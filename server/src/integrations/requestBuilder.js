import { IntegrationError } from './errors.js';

const pad = n => String(n).padStart(2, '0');

export function addDays(dayKey, days) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function tzOffsetMs(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(instantMs));
  const get = t => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * UTC instant of 00:00 local time on the given business day.
 */
export function zonedDayStart(dayKey, timezone = 'UTC') {
  const [y, m, d] = dayKey.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMs(guess, timezone);
    const candidate = Date.UTC(y, m - 1, d) - offset;
    if (candidate === guess) break;
    guess = candidate;
  }
  return guess;
}

function formatDateParam(dayKey, format, timezone, edge) {
  const [y, m, d] = dayKey.split('-');
  switch (format) {
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
    case 'YYYYMMDD': return `${y}${m}${d}`;
    case 'iso_datetime':
    case 'epoch_ms':
    case 'epoch_s': {
      // 'start' → 00:00:00.000 local; 'end' → 23:59:59.999 local; 'exclusive-end' → next day 00:00 local
      const ms = edge === 'end' ? zonedDayStart(addDays(dayKey, 1), timezone) - 1 : zonedDayStart(dayKey, timezone);
      if (format === 'iso_datetime') return new Date(ms).toISOString();
      if (format === 'epoch_ms') return String(ms);
      return String(Math.floor(ms / 1000));
    }
    case 'YYYY-MM-DD':
    default:
      return dayKey;
  }
}

/**
 * Build the outbound request for a canonical report request using ONLY the saved
 * configuration (parameter names, static parameters, report type values).
 *
 * input: { reportType, from, to, page, limit, offset, cursor, search, status, endpoint }
 * from/to are inclusive business-day keys (YYYY-MM-DD) in the platform timezone.
 */
export function buildReportRequest(config, input, timezone = 'UTC') {
  const p = config.params || {};
  const query = {};
  const set = (canonical, value) => {
    if (p[canonical] && value !== undefined && value !== null && value !== '') query[p[canonical]] = String(value);
  };

  const exclusive = config.end_date_mode === 'exclusive';
  const toKey = exclusive ? addDays(input.to, 1) : input.to;
  set('from', formatDateParam(input.from, config.date_param_format, timezone, 'start'));
  set('to', formatDateParam(toKey, config.date_param_format, timezone, exclusive ? 'start' : 'end'));

  const reportType = input.reportType || 'overview';
  if (p.report_type) {
    const value = config.report_types?.[reportType] || (reportType === 'all' ? (config.report_types?.overview || 'all') : undefined);
    if (!value) throw new IntegrationError('UNSUPPORTED_REPORT', `No '${reportType}' report value is configured for this platform.`);
    query[p.report_type] = value;
  }

  set('page', input.page);
  set('limit', input.limit);
  set('offset', input.offset);
  set('cursor', input.cursor);
  set('search', input.search);
  set('status', input.status);

  for (const sp of config.static_params || []) query[sp.name] = sp.value;

  let endpoint = (input.endpoint === 'export' && config.endpoints?.export) ? config.endpoints.export : config.endpoints.report;
  if (input.metric && config.endpoints?.[input.metric]) {
    const override = config.endpoints[input.metric];
    endpoint = typeof override === 'string' ? { path: override, method: 'GET' } : override;
  }
  const method = endpoint.method || 'GET';
  let url = `${config.base_url}${endpoint.path}`;
  let body;
  if (method === 'GET') {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  } else {
    body = JSON.stringify(query);
  }

  const extraHeaders = {};
  for (const h of config.extra_headers || []) extraHeaders[h.name.toLowerCase()] = h.value;
  if (method === 'POST') extraHeaders['content-type'] = 'application/json';

  return { method, url, body, query, headers: extraHeaders, path: endpoint.path };
}
