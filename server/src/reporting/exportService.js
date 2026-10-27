import { createPlatformClient } from '../services/integrationService.js';
import { describeCapabilities } from '../integrations/capabilities.js';
import { IntegrationError } from '../integrations/errors.js';
import { RECORD_FIELDS } from '../integrations/canonicalFields.js';
import { resolveRange } from './dateRange.js';
import { buildSettlement } from './reportService.js';
import { csvCell, toCsv, safeFilenamePart } from '../utils/csv.js';

/**
 * Server-side CSV exports. Data is retrieved page by page from the platform API with
 * duplicate and completeness checks; a failure on any page fails the whole export
 * (no partial files presented as complete).
 */

export async function exportSettlementCsv(platform, query, { view = 'revenue', userId, signal, minStartDate } = {}) {
  const client = await createPlatformClient(platform, { mode: 'published', userId });
  const caps = describeCapabilities(client.config);
  if (!caps.modules.settlement) throw new IntegrationError('UNSUPPORTED_REPORT', 'The settlement report is not available for this platform.');
  const range = resolveRange(query, client.timezone, client.config.default_range_days);
  const minDate = minStartDate || query?.minStartDate;

  if (minDate) {
    if (range.to < minDate) {
      return {
        csv: '',
        filename: `${safeFilenamePart(platform.code)}_settlement_${view}_${range.from}_${range.to}.csv`,
        meta: { rows: 0, complete: true, pages: 0 }
      };
    }
    if (range.from < minDate) {
      range.from = minDate;
    }
  }

  const snapshot = await client.fetchSnapshot({ from: range.from, to: range.to, signal, fresh: true });
  if (minDate && snapshot.daily?.rows?.length) {
    snapshot.daily.rows = snapshot.daily.rows.filter(r => r.report_date >= minDate);
  }
  const settlement = buildSettlement(snapshot, client.config);
  const decimals = client.config.currency_decimals ?? 2;
  const currency = platform.currency ? ` (${platform.currency})` : '';

  const cols = [];
  for (const c of settlement.columns) {
    if (c.kind === 'currency' && view === 'transactions') {
      if (c.transactions?.available) cols.push({ key: c.transactions.key, header: `${c.label} (transactions)`, decimals: null });
    } else if (c.available) {
      cols.push({ key: c.key, header: c.kind === 'currency' ? `${c.label}${currency}` : c.label, decimals: c.kind === 'currency' ? decimals : null });
    }
  }
  const header = ['Date', ...cols.map(c => c.header)];
  const rows = settlement.rows.map(r => [csvCell(r.date), ...cols.map(c => csvCell(r.values[c.key], { decimals: c.decimals }))]);
  rows.push([csvCell('TOTAL'), ...cols.map(c => csvCell(settlement.totals[c.key], { decimals: c.decimals }))]);

  return {
    csv: toCsv(header, rows),
    filename: `${safeFilenamePart(platform.code)}_settlement_${view}_${range.from}_${range.to}.csv`,
    meta: { rows: settlement.rows.length, complete: true, pages: snapshot.pages || 1 }
  };
}

export async function exportRecordsCsv(platform, { reportType, search, status, minStartDate, ...query }, { userId, signal, minStartDate: ctxMinDate } = {}) {
  const client = await createPlatformClient(platform, { mode: 'published', userId });
  const caps = describeCapabilities(client.config);
  if (!caps.recordReports[reportType]) throw new IntegrationError('UNSUPPORTED_REPORT', `Record-level '${reportType}' data is not configured for this platform.`);
  const range = resolveRange(query, client.timezone, client.config.default_range_days);
  const minDate = minStartDate || ctxMinDate;

  if (minDate) {
    if (range.to < minDate) {
      return {
        csv: '',
        filename: `${safeFilenamePart(platform.code)}_${reportType}_${range.from}_${range.to}.csv`,
        meta: { rows: 0, pages: 0, duplicatesSkipped: 0, reportedTotal: 0, complete: true }
      };
    }
    if (range.from < minDate) {
      range.from = minDate;
    }
  }

  const collected = await client.collectRecords({
    reportType,
    from: range.from,
    to: range.to,
    search: client.config.params?.search ? search : undefined,
    status: client.config.params?.status ? status : undefined,
    signal
  });

  if (minDate && collected.rows?.length) {
    collected.rows = collected.rows.filter(r => !r.date || r.date >= minDate);
  }
  let keys = Object.keys(client.config.mappings.records || {});
  if (query.fields) {
    const selected = String(query.fields).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (selected.length > 0) {
      const filtered = keys.filter(k => selected.includes(k.toLowerCase()));
      if (filtered.length > 0) keys = filtered;
    }
  }
  const decimals = client.config.currency_decimals ?? 2;
  const header = keys.map(k => (k === 'amount' && platform.currency ? `${RECORD_FIELDS[k]?.label || k} (${platform.currency})` : (RECORD_FIELDS[k]?.label || k)));
  const rows = collected.rows.map(r => keys.map(k => csvCell(r[k], { decimals: RECORD_FIELDS[k]?.type === 'decimal' ? decimals : null })));
  return {
    csv: toCsv(header, rows),
    filename: `${safeFilenamePart(platform.code)}_${reportType}_${range.from}_${range.to}.csv`,
    meta: {
      rows: collected.rows.length,
      pages: collected.pages,
      duplicatesSkipped: collected.duplicates,
      reportedTotal: collected.reportedTotal,
      complete: collected.complete
    }
  };
}
