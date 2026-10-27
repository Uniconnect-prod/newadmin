import { exportSettlementCsv, exportRecordsCsv } from '../reporting/exportService.js';
import { normalizeModules } from '../repositories/platformRepository.js';
import { logAudit } from '../middleware/auditLogger.js';
import { AppError } from '../utils/errors.js';
import { requestSignal } from './reportController.js';

function send(res, { csv, filename, meta }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Export-Rows', String(meta.rows));
  res.setHeader('X-Export-Complete', meta.complete ? 'true' : 'false');
  res.setHeader('X-Export-Pages', String(meta.pages ?? 1));
  if (meta.reportedTotal !== undefined && meta.reportedTotal !== null) res.setHeader('X-Export-Reported-Total', String(meta.reportedTotal));
  if (meta.duplicatesSkipped) res.setHeader('X-Export-Duplicates-Skipped', String(meta.duplicatesSkipped));
  res.status(200).send(csv);
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

export const exportController = {
  async settlement(req, res) {
    if (!normalizeModules(req.activePlatform.enabled_modules).includes('settlement')) {
      throw new AppError(404, 'MODULE_DISABLED', 'The settlement report is not enabled for this platform.');
    }
    const view = req.query.view === 'transactions' ? 'transactions' : 'revenue';
    const minStartDate = userMinStartDate(req);
    const result = await exportSettlementCsv(req.activePlatform, rangeQuery(req.query, req), { view, userId: req.user.id, signal: requestSignal(req, res), minStartDate });
    await logAudit(req, 'EXPORT_SETTLEMENT_CSV', 'Report', null, { view, rows: result.meta.rows, file: result.filename });
    send(res, result);
  },

  async records(req, res) {
    const reportType = String(req.query.reportType || 'subscribers');
    if (!['all', 'overview', 'subscribers', 'renewals', 'churn'].includes(reportType)) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown export type.');
    const module = (reportType === 'subscribers' || reportType === 'all' || reportType === 'overview') ? 'subscriber_records' : reportType;
    if (!normalizeModules(req.activePlatform.enabled_modules).includes(module)) {
      throw new AppError(404, 'MODULE_DISABLED', 'This export is not enabled for this platform.');
    }
    const status = typeof req.query.status === 'string' && /^[A-Za-z_-]{1,30}$/.test(req.query.status) ? req.query.status : undefined;
    const fields = typeof req.query.fields === 'string' ? req.query.fields : undefined;
    const minStartDate = userMinStartDate(req);
    const result = await exportRecordsCsv(req.activePlatform, { reportType, ...rangeQuery(req.query, req), search, status, fields, minStartDate }, { userId: req.user.id, signal: requestSignal(req, res), minStartDate });
    await logAudit(req, 'EXPORT_RECORDS_CSV', 'Report', null, { reportType, rows: result.meta.rows, complete: result.meta.complete, file: result.filename });
    send(res, result);
  }
};
