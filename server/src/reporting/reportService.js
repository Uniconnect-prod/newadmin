import { createPlatformClient } from '../services/integrationService.js';
import { toSelectorEntry } from '../services/accessService.js';
import { describeCapabilities } from '../integrations/capabilities.js';
import { SETTLEMENT_COLUMNS, DAILY_FIELDS, SUMMARY_FIELDS, RECORD_FIELDS } from '../integrations/canonicalFields.js';
import { IntegrationError } from '../integrations/errors.js';
import { sumExact, sumIntegers, toMicros, microsToNumber } from '../integrations/transforms.js';
import { resolveRange, listDays, daysBetween } from './dateRange.js';
import { resolveMetric, dailyValue, dailyAvailable, DERIVED_METRICS } from './metrics.js';

/**
 * Report sections: which KPI metrics and daily trend series each page shows.
 * Only metrics the platform's mapping supports are displayed as values; the rest are
 * returned as "unavailable" with the missing inputs named.
 */
export const SECTIONS = {
  overview: {
    kpis: ['new_subscribers', 'subscriber_count', 'active_subscribers', 'renewal_count', 'failed_renewal_count', 'grand_total', 'renewal_rate', 'deactivations'],
    trends: ['new_subscribers', 'grand_total', 'renewal_count', 'deactivations']
  },
  revenue: {
    kpis: ['grand_total', 'daily_revenue', 'ondemand_revenue', 'transaction_count', 'successful_charges', 'failed_charges'],
    trends: ['grand_total', 'daily_revenue', 'ondemand_revenue']
  },
  subscribers: {
    kpis: ['new_subscribers', 'subscriber_count', 'active_subscribers', 'activation_parking', 'deactivations', 'net_additions'],
    trends: ['new_subscribers', 'activation_parking', 'deactivations', 'net_additions']
  },
  renewals: {
    kpis: ['renewal_count', 'failed_renewal_count', 'renewal_rate', 'successful_charges', 'failed_charges', 'transaction_count'],
    trends: ['renewal_count', 'failed_renewal_count', 'successful_charges', 'failed_charges']
  },
  churn: {
    kpis: ['deactivations', 'new_subscribers', 'net_additions', 'active_subscribers'],
    trends: ['deactivations', 'net_additions']
  }
};

function dataSource(platform, snapshot, client) {
  let host = null;
  try {
    host = new URL(client.config.base_url).host;
  } catch {
    host = null;
  }
  return {
    type: 'platform_api',
    host,
    fetchedAt: snapshot.fetchedAt,
    cached: Boolean(snapshot.cached),
    pages: snapshot.pages || 1,
    timezone: client.timezone,
    publishedAt: platform.published_at || null,
    lastSuccessAt: platform.integration_health?.last_success_at || null
  };
}

function trendSeries(rows, keys, config) {
  const available = keys.filter(k => dailyAvailable(k, config).available);
  const series = rows.map(r => {
    const point = { date: r.report_date };
    for (const k of available) point[k] = dailyValue(r, k, config);
    return point;
  });
  return {
    available: available.map(k => ({ key: k, label: config.mappings?.daily?.[k]?.label || DAILY_FIELDS[k]?.label || DERIVED_METRICS[k]?.label || k, kind: DAILY_FIELDS[k]?.kind || DERIVED_METRICS[k]?.kind, provenance: dailyAvailable(k, config).provenance })),
    unavailable: keys.filter(k => !available.includes(k)),
    series
  };
}

function rangeWarnings(range, snapshot, config) {
  const warnings = [];
  if (!snapshot.daily?.present) return warnings;
  const returned = new Set(snapshot.daily.rows.map(r => r.report_date));
  const outside = [...returned].filter(d => d < range.from || d > range.to);
  if (outside.length) warnings.push({ code: 'ROWS_OUTSIDE_RANGE', message: `The API returned ${outside.length} row(s) outside the requested period (${outside.slice(0, 3).join(', ')}…). They are shown as returned.` });
  const missing = listDays(range.from, range.to).filter(d => !returned.has(d) && d <= range.today);
  if (missing.length && snapshot.daily.rows.length) {
    warnings.push({ code: 'MISSING_DAYS', message: `No row was returned for ${missing.length} day(s) in the selected period. Those days are left blank rather than shown as zero.`, dates: missing.slice(0, 31) });
  }
  return warnings;
}

function reconciliation(snapshot, config) {
  const out = [];
  if (!snapshot.summary?.present || !snapshot.daily?.present) return out;
  for (const key of Object.keys(config.mappings?.summary || {})) {
    const def = DAILY_FIELDS[key];
    if (!def || def.kind === 'stock' || !config.mappings?.daily?.[key]) continue;
    const summary = snapshot.summary.values[key];
    const vals = snapshot.daily.rows.map(r => r[key]);
    const dailySum = def.kind === 'currency' ? sumExact(vals, config.currency_decimals) : sumIntegers(vals);
    if (summary === null || dailySum === null) continue;
    const sumMicros = toMicros(summary);
    const dayMicros = toMicros(dailySum);
    const diff = def.kind === 'currency'
      ? (sumMicros !== null && dayMicros !== null ? microsToNumber(sumMicros - dayMicros, config.currency_decimals) : 0)
      : (summary ?? 0) - (dailySum ?? 0);
    out.push({ key, label: def.label, summary, dailySum, difference: diff, matches: Math.abs(diff) <= (def.kind === 'currency' ? 0.01 : 0) });
  }
  return out;
}

export function buildSettlement(snapshot, config) {
  const columns = SETTLEMENT_COLUMNS.map(key => {
    const avail = dailyAvailable(key, config);
    const pairedKey = DAILY_FIELDS[key]?.pairedCount || null;
    const pairedAvail = pairedKey ? dailyAvailable(pairedKey, config) : null;
    return {
      key,
      label: config.mappings?.daily?.[key]?.label || DAILY_FIELDS[key].label,
      kind: DAILY_FIELDS[key].kind,
      available: avail.available,
      provenance: avail.provenance,
      formula: avail.formula || null,
      transactions: pairedKey ? { key: pairedKey, label: config.mappings?.daily?.[pairedKey]?.label || DAILY_FIELDS[pairedKey].label, available: pairedAvail.available, provenance: pairedAvail.provenance } : null
    };
  });

  const keys = new Set();
  for (const c of columns) {
    if (c.available) keys.add(c.key);
    if (c.transactions?.available) keys.add(c.transactions.key);
  }
  const decimals = config.currency_decimals ?? 2;
  const running = {};
  const rows = (snapshot.daily?.rows || []).map(r => {
    const values = {};
    const cumulative = {};
    for (const k of keys) {
      values[k] = dailyValue(r, k, config);
      const kind = DAILY_FIELDS[k]?.kind;
      if (values[k] !== null && values[k] !== undefined) {
        if (kind === 'currency') {
          const runMicros = toMicros(running[k] ?? 0) ?? 0n;
          const valMicros = toMicros(values[k]);
          running[k] = valMicros !== null ? microsToNumber(runMicros + valMicros, decimals) : (running[k] ?? 0);
        } else {
          running[k] = (running[k] ?? 0) + (Number(values[k]) || 0);
        }
      }
      cumulative[k] = running[k] ?? null;
    }
    return { date: r.report_date, values, running: cumulative };
  });

  const totals = {};
  for (const k of keys) {
    const vals = rows.map(r => r.values[k]);
    totals[k] = DAILY_FIELDS[k]?.kind === 'currency' ? sumExact(vals, decimals) : sumIntegers(vals);
  }

  return { columns, rows, totals, totalsProvenance: 'calculated', viewModes: { revenue: columns.some(c => c.available && c.kind === 'currency'), transactions: columns.some(c => c.transactions?.available) } };
}

async function loadSnapshot(platform, query, ctx = {}) {
  const { userId, signal, fresh, minStartDate } = ctx;
  const client = await createPlatformClient(platform, { mode: 'published', userId });
  const range = resolveRange(query, client.timezone, client.config.default_range_days);
  const minDate = minStartDate || query?.minStartDate;

  if (minDate) {
    if (range.to < minDate) {
      return {
        client,
        range,
        snapshot: {
          fetchedAt: new Date().toISOString(),
          cached: false,
          pages: 0,
          summary: { present: false, values: {} },
          daily: { present: true, rows: [] }
        }
      };
    }
    if (range.from < minDate) {
      range.from = minDate;
      range.days = daysBetween(range.from, range.to);
    }
  }

  const snapshot = await client.fetchSnapshot({ from: range.from, to: range.to, signal, fresh });
  if (minDate && snapshot.daily?.rows?.length) {
    snapshot.daily.rows = snapshot.daily.rows.filter(r => r.report_date >= minDate);
  }
  return { client, range, snapshot };
}

/**
 * Overview / analytics section for one platform.
 */
export async function getSection(platform, section, query, ctx = {}) {
  const def = SECTIONS[section];
  if (!def) throw new IntegrationError('UNSUPPORTED_REPORT', `Unknown report section '${section}'.`);
  const { client, range, snapshot } = await loadSnapshot(platform, query, ctx);
  const config = client.config;
  const kpis = def.kpis.map(k => resolveMetric(k, snapshot, config));
  const capabilities = describeCapabilities(config);
  const payload = {
    platform: toSelectorEntry(platform),
    section,
    range,
    currency: platform.currency || null,
    kpis,
    trends: trendSeries(snapshot.daily?.rows || [], def.trends, config),
    capabilities,
    reconciliation: reconciliation(snapshot, config),
    warnings: rangeWarnings(range, snapshot, config),
    dataSource: dataSource(platform, snapshot, client),
    empty: snapshot.daily?.present ? snapshot.daily.rows.length === 0 : null
  };
  if (section === 'overview') {
    payload.settlement = buildSettlement(snapshot, config);
    payload.revenueBreakdown = ['daily_revenue', 'ondemand_revenue'].map(k => resolveMetric(k, snapshot, config));
  }
  if (section === 'revenue') {
    payload.revenueBreakdown = ['daily_revenue', 'ondemand_revenue'].map(k => resolveMetric(k, snapshot, config));
  }
  return payload;
}

export async function getSettlementReport(platform, query, ctx = {}) {
  const { client, range, snapshot } = await loadSnapshot(platform, query, ctx);
  const capabilities = describeCapabilities(client.config);
  if (!capabilities.modules.settlement) {
    throw new IntegrationError('UNSUPPORTED_REPORT', 'Daily rows are not mapped for this platform, so the settlement report is unavailable.');
  }
  return {
    platform: toSelectorEntry(platform),
    range,
    currency: platform.currency || null,
    settlement: buildSettlement(snapshot, client.config),
    reconciliation: reconciliation(snapshot, client.config),
    warnings: rangeWarnings(range, snapshot, client.config),
    dataSource: dataSource(platform, snapshot, client)
  };
}

export async function getRecordsPage(platform, { reportType, page, pageSize, search, status, minStartDate, ...query }, ctx = {}) {
  const client = await createPlatformClient(platform, { mode: 'published', userId: ctx.userId });
  const caps = describeCapabilities(client.config);
  if (!caps.recordReports[reportType]) {
    throw new IntegrationError('UNSUPPORTED_REPORT', `Record-level '${reportType}' data is not configured for this platform.`);
  }
  const range = resolveRange(query, client.timezone, client.config.default_range_days);
  const minDate = minStartDate || ctx.minStartDate;
  const mapped = Object.keys(client.config.mappings?.records || {});

  const baseResult = {
    platform: toSelectorEntry(platform),
    reportType,
    range,
    columns: mapped.map(k => ({ key: k, label: RECORD_FIELDS[k].label, type: RECORD_FIELDS[k].type })),
    supports: { search: Boolean(client.config.params?.search), status: Boolean(client.config.params?.status) },
    currency: platform.currency || null,
    fetchedAt: new Date().toISOString()
  };

  if (minDate) {
    if (range.to < minDate) {
      return {
        ...baseResult,
        rows: [],
        pagination: { page: 1, pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25)), total: 0, pages: 0 }
      };
    }
    if (range.from < minDate) {
      range.from = minDate;
      range.days = daysBetween(range.from, range.to);
    }
  }

  const result = await client.fetchRecordsPage({
    reportType,
    from: range.from,
    to: range.to,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25)),
    search: client.config.params?.search ? search : undefined,
    status: client.config.params?.status ? status : undefined,
    signal: ctx.signal
  });

  let rows = result.rows;
  if (minDate && rows?.length) {
    rows = rows.filter(r => !r.date || r.date >= minDate);
  }

  return {
    ...baseResult,
    rows,
    pagination: result.pagination
  };
}

// ---------------------------------------------------------------------------
// Consolidated (All Platforms) overview
// ---------------------------------------------------------------------------

export const CONSOLIDATION_RULES = [
  'Only flow metrics that are additive across platforms are totalled: new subscribers, renewals, failed renewals, deactivations, activation parking and transactions.',
  'Revenue is totalled per currency; amounts in different currencies are never added together.',
  'Point-in-time subscriber counts (total/active subscribers) are listed per platform and not summed, because one person can subscribe to several platforms.',
  'Ratios (e.g. renewal rate) are never averaged across platforms.',
  'Platforms whose API request fails, or that do not provide a metric, are excluded from that total and listed under coverage.'
];

const ADDITIVE = ['new_subscribers', 'renewal_count', 'failed_renewal_count', 'deactivations', 'activation_parking', 'transaction_count'];

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function getConsolidatedOverview(platforms, query, ctx = {}) {
  const perPlatform = await mapLimit(platforms, 4, async (platform) => {
    const base = { platform: toSelectorEntry(platform) };
    if (!platform.published_integration) {
      return { ...base, status: 'not_configured', error: new IntegrationError('INTEGRATION_NOT_CONFIGURED').toJSON() };
    }
    try {
      const { client, range, snapshot } = await loadSnapshot(platform, query, ctx);
      const metrics = {};
      for (const k of [...ADDITIVE, 'grand_total', 'subscriber_count', 'active_subscribers', 'renewal_rate']) {
        metrics[k] = resolveMetric(k, snapshot, client.config);
      }
      return { ...base, status: 'ok', range, metrics, currency: platform.currency || null, fetchedAt: snapshot.fetchedAt };
    } catch (err) {
      if (err instanceof IntegrationError) return { ...base, status: 'error', error: err.toJSON() };
      throw err;
    }
  });

  const ok = perPlatform.filter(p => p.status === 'ok');
  const totals = ADDITIVE.map(key => {
    const contributing = ok.filter(p => p.metrics[key].provenance !== 'unavailable');
    return {
      key,
      // Canonical label: per-platform custom column labels must not leak into cross-platform totals.
      label: SUMMARY_FIELDS[key]?.label || DAILY_FIELDS[key]?.label || key,
      kind: 'count',
      value: contributing.length ? contributing.reduce((s, p) => s + p.metrics[key].value, 0) : null,
      provenance: contributing.length ? 'calculated' : 'unavailable',
      coverage: { included: contributing.map(p => p.platform.code), of: perPlatform.length }
    };
  });

  const byCurrency = new Map();
  for (const p of ok) {
    const m = p.metrics.grand_total;
    if (m.provenance === 'unavailable') continue;
    const cur = p.currency || 'UNSPECIFIED';
    if (!byCurrency.has(cur)) byCurrency.set(cur, { currency: cur, micros: 0n, platforms: [] });
    const entry = byCurrency.get(cur);
    const valMicros = toMicros(m.value);
    if (valMicros !== null) entry.micros += valMicros;
    entry.platforms.push(p.platform.code);
  }
  const revenue = [...byCurrency.values()].map(e => ({ currency: e.currency, value: microsToNumber(e.micros, 2), provenance: 'calculated', platforms: e.platforms }));

  return {
    scope: 'ALL',
    range: ok[0]?.range || null,
    totals,
    revenue,
    platforms: perPlatform,
    rules: CONSOLIDATION_RULES
  };
}
