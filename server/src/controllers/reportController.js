import { getSection, getSettlementReport, getRecordsPage, getConsolidatedOverview } from '../reporting/reportService.js';
import { platformRepository, normalizeModules } from '../repositories/platformRepository.js';
import { auditRepository } from '../repositories/auditRepository.js';
import { AppError } from '../utils/errors.js';

const SECTION_MODULES = { revenue: 'revenue', subscribers: 'subscribers', renewals: 'renewals', churn: 'churn' };
const RECORD_TYPES = ['all', 'overview', 'subscribers', 'renewals', 'churn'];

/**
 * Abort outbound platform API calls when the browser cancels the request
 * (filters changed rapidly, page navigated away).
 */
export function requestSignal(req, res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

function userMinStartDate(req) {
  if (req.user?.isSuperAdmin) return null;
  const start = req.platformAccess?.start_date || req.user?.access_start_date;
  return start ? String(start).slice(0, 10) : null;
}

function rangeQuery(q, req) {
  const minDate = userMinStartDate(req);
  return { range: q.range || undefined, from: q.from || undefined, to: q.to || undefined, minStartDate: minDate || undefined };
}

function requireModule(platform, module) {
  if (!normalizeModules(platform.enabled_modules).includes(module)) {
    throw new AppError(404, 'MODULE_DISABLED', 'This report is not enabled for the selected platform.');
  }
}

export const reportController = {
  async overview(req, res) {
    const minStartDate = userMinStartDate(req);
    const ctx = { userId: req.user.id, signal: requestSignal(req, res), fresh: req.query.fresh === '1', minStartDate };
    if (req.activePlatform.isAll) {
      let platforms = await platformRepository.listActive();
      if (req.activePlatform.country) {
        platforms = platforms.filter(p => (p.country || '').toLowerCase() === req.activePlatform.country.toLowerCase());
      }
      const data = await getConsolidatedOverview(platforms, rangeQuery(req.query, req), ctx);
      return res.json({ success: true, data });
    }
    const data = await getSection(req.activePlatform, 'overview', rangeQuery(req.query, req), ctx);
    return res.json({ success: true, data });
  },

  async section(req, res) {
    const section = req.params.section;
    if (!SECTION_MODULES[section]) throw new AppError(404, 'NOT_FOUND', 'Unknown report.');
    requireModule(req.activePlatform, SECTION_MODULES[section]);
    const minStartDate = userMinStartDate(req);
    const data = await getSection(req.activePlatform, section, rangeQuery(req.query, req), {
      userId: req.user.id,
      signal: requestSignal(req, res),
      fresh: req.query.fresh === '1',
      minStartDate
    });
    res.json({ success: true, data });
  },

  async settlement(req, res) {
    requireModule(req.activePlatform, 'settlement');
    const minStartDate = userMinStartDate(req);
    const data = await getSettlementReport(req.activePlatform, rangeQuery(req.query, req), {
      userId: req.user.id,
      signal: requestSignal(req, res),
      fresh: req.query.fresh === '1',
      minStartDate
    });
    res.json({ success: true, data });
  },

  async records(req, res) {
    const reportType = String(req.query.reportType || 'subscribers');
    if (!RECORD_TYPES.includes(reportType)) throw new AppError(400, 'VALIDATION_ERROR', 'reportType must be subscribers, renewals or churn.');
    requireModule(req.activePlatform, (reportType === 'subscribers' || reportType === 'all' || reportType === 'overview') ? 'subscriber_records' : reportType);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 40) : undefined;
    if (search && !/^[0-9+\s-]{3,40}$/.test(search)) throw new AppError(400, 'VALIDATION_ERROR', 'Search accepts phone numbers (digits, +, -, spaces).');
    const status = typeof req.query.status === 'string' && /^[A-Za-z_-]{1,30}$/.test(req.query.status) ? req.query.status : undefined;
    const minStartDate = userMinStartDate(req);
    let targetReportType = reportType;
    if (targetReportType === 'all' || targetReportType === 'overview') {
      if (status === 'renewal') targetReportType = 'renewals';
      else if (status === 'churn') targetReportType = 'churn';
      else targetReportType = 'subscribers';
    }
    const data = await getRecordsPage(req.activePlatform, {
      reportType: targetReportType,
      ...rangeQuery(req.query, req),
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: search ? search.replace(/[\s+-]/g, '') : undefined,
      status
    }, { userId: req.user.id, signal: requestSignal(req, res), minStartDate });
    res.json({ success: true, data });
  },

  /**
   * Recent report activity for the selected platform (exports, configuration changes, tests).
   * Super Admins and Platform Admins see everyone's events; other roles see their own.
   */
  async activity(req, res) {
    const platformIds = req.activePlatform.isAll ? null : [req.activePlatform.id];
    const seeAll = req.user.isSuperAdmin || req.platformRole === 'Platform Admin';
    const result = await auditRepository.search({ platformIds, userId: seeAll ? null : req.user.id, page: 1, limit: 8 });
    res.json({ success: true, data: result.records.map(r => ({ id: r.id, action: r.action, user: r.user, timestamp: r.timestamp, platformId: r.platformId })) });
  }
};
