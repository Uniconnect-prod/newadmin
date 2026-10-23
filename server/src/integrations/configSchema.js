import crypto from 'crypto';
import { isValidPath } from './jsonPath.js';
import { DATE_FORMATS } from './transforms.js';
import { FIELD_GROUPS, REPORT_TYPES, REQUEST_PARAMS } from './canonicalFields.js';
import { ADAPTERS } from './adapters/index.js';

export const AUTH_TYPES = ['none', 'bearer', 'api_key', 'login_token', 'hmac_sha256', 'basic'];
export const PAGINATION_STRATEGIES = ['none', 'page', 'offset', 'cursor'];
export const HTTP_METHODS = ['GET', 'POST'];
export const DATE_PARAM_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYYMMDD', 'iso_datetime', 'epoch_ms', 'epoch_s'];

// Headers that may never be set through configuration.
export const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect',
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'proxy-connection', 'forwarded', 'origin', 'referer'
]);

const NAME_RE = /^[A-Za-z0-9_.\-[\]]{1,64}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const VALUE_TOKEN_RE = /^[A-Za-z0-9_.\-:]{1,64}$/;

export function isForbiddenHeader(name) {
  const lower = String(name).toLowerCase();
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('x-forwarded-') || lower.startsWith('sec-');
}

export function validateEndpointPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'Path must start with "/".';
  if (path.length > 500) return 'Path is too long.';
  if (path.includes('#')) return 'Path may not contain a hash/fragment.';
  if (!/^\/[A-Za-z0-9/_\-.~%?&=:]*$/.test(path)) return 'Path may only contain valid URL path and query characters.';
  if (path.includes('//')) return 'Path may not contain "//".';
  if (path.split('?')[0].split('/').some(seg => seg === '..' || seg === '.')) return 'Path may not contain "." or ".." segments.';
  if (/%2e|%2f|%5c/i.test(path)) return 'Path may not contain encoded dots or slashes.';
  return null;
}

export function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return { error: 'Base URL must be an absolute URL, e.g. https://api.example.com/api' };
  }
  if (!['https:', 'http:'].includes(url.protocol)) return { error: 'Base URL must use https.' };
  if (url.username || url.password) return { error: 'Base URL must not contain credentials.' };
  if (url.search || url.hash) return { error: 'Base URL must not contain a query string or fragment.' };
  const pathErr = url.pathname === '/' ? null : validateEndpointPath(url.pathname.replace(/\/+$/, ''));
  if (pathErr) return { error: `Base URL path: ${pathErr}` };
  const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  return { value: normalized, url };
}

function intIn(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return NaN;
  return n;
}

function str(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/**
 * Validate and normalise an integration configuration submitted by a Super Admin.
 * Returns { config, errors } — callers must reject the save when errors is non-empty.
 * Nothing in the configuration is ever executed: paths are data, not code.
 */
export function validateIntegrationConfig(input = {}) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  const cfg = {};

  cfg.adapter = input.adapter || 'generic-json';
  if (!ADAPTERS[cfg.adapter]) err('adapter', `Unknown adapter '${cfg.adapter}'.`);

  const base = validateBaseUrl(input.base_url);
  if (base.error) err('base_url', base.error);
  cfg.base_url = base.value || str(input.base_url, 500);

  cfg.timeout_ms = intIn(input.timeout_ms, 1000, 30000, 15000);
  if (Number.isNaN(cfg.timeout_ms)) err('timeout_ms', 'Timeout must be between 1000 and 30000 ms.');
  cfg.max_response_bytes = intIn(input.max_response_bytes, 10 * 1024, 100 * 1024 * 1024, 25 * 1024 * 1024);
  if (Number.isNaN(cfg.max_response_bytes)) err('max_response_bytes', 'Response size limit must be between 10 KB and 100 MB.');
  cfg.rate_limit_per_minute = intIn(input.rate_limit_per_minute, 1, 600, 60);
  if (Number.isNaN(cfg.rate_limit_per_minute)) err('rate_limit_per_minute', 'Rate limit must be between 1 and 600 requests per minute.');
  cfg.default_range_days = intIn(input.default_range_days, 1, 366, 30);
  if (Number.isNaN(cfg.default_range_days)) err('default_range_days', 'Default range must be between 1 and 366 days.');
  cfg.currency_decimals = intIn(input.currency_decimals, 0, 4, 2);
  if (Number.isNaN(cfg.currency_decimals)) err('currency_decimals', 'Currency decimals must be between 0 and 4.');

  // --- Authentication -------------------------------------------------------
  const a = input.auth || {};
  const auth = { type: a.type || 'none' };
  if (!AUTH_TYPES.includes(auth.type)) err('auth.type', `Authentication type must be one of ${AUTH_TYPES.join(', ')}.`);
  if (auth.type === 'api_key') {
    auth.header_name = str(a.header_name, 64);
    if (!HEADER_NAME_RE.test(auth.header_name)) err('auth.header_name', 'Header name may only contain letters, digits and hyphens.');
    else if (isForbiddenHeader(auth.header_name)) err('auth.header_name', `Header '${auth.header_name}' cannot be used for an API key.`);
  }
  if (auth.type === 'login_token') {
    auth.login_path = str(a.login_path, 300);
    const p = validateEndpointPath(auth.login_path);
    if (p) err('auth.login_path', p);
    auth.username_field = str(a.username_field || 'username', 64);
    auth.password_field = str(a.password_field || 'password', 64);
    if (!NAME_RE.test(auth.username_field)) err('auth.username_field', 'Invalid username field name.');
    if (!NAME_RE.test(auth.password_field)) err('auth.password_field', 'Invalid password field name.');
    auth.token_source = a.token_source === 'cookie' ? 'cookie' : 'json';
    if (auth.token_source === 'json') {
      auth.token_path = str(a.token_path || 'token', 200);
      if (!isValidPath(auth.token_path) || !auth.token_path) err('auth.token_path', 'Token path must be a valid response path, e.g. "token" or "data.accessToken".');
    } else {
      auth.cookie_name = str(a.cookie_name, 64);
      if (!/^[A-Za-z0-9_\-.]{1,64}$/.test(auth.cookie_name)) err('auth.cookie_name', 'Cookie name is required when the token is delivered as a cookie.');
    }
    auth.token_ttl_seconds = intIn(a.token_ttl_seconds, 60, 86400, 3000);
    if (Number.isNaN(auth.token_ttl_seconds)) err('auth.token_ttl_seconds', 'Token lifetime must be between 60 and 86400 seconds.');
  }
  cfg.auth = auth;

  // --- Endpoints ------------------------------------------------------------
  const e = input.endpoints || {};
  const reportPath = str(e.report?.path, 300) || '/api/admin/dashboard';
  cfg.endpoints = { report: { path: reportPath, method: (e.report?.method || 'GET').toUpperCase() } };
  const rp = validateEndpointPath(cfg.endpoints.report.path);
  if (rp) err('endpoints.report.path', rp);
  if (!HTTP_METHODS.includes(cfg.endpoints.report.method)) err('endpoints.report.method', 'Method must be GET or POST.');

  // Health check endpoint (optional, defaults to /api/health)
  const healthPath = str(e.health?.path, 300) || '/api/health';
  cfg.endpoints.health = { path: healthPath, method: 'GET' };
  const hp = validateEndpointPath(cfg.endpoints.health.path);
  if (hp) err('endpoints.health.path', hp);

  // Optional metric endpoint overrides
  const optionalEndpoints = [
    { key: 'total_subscribers', alt: 'totalSubscribers' },
    { key: 'daily_subscribers', alt: 'dailySubscribers' },
    { key: 'duration_subscribers', alt: 'durationSubscribers' },
    { key: 'churn_subscribers', alt: 'churnSubscribers' },
    { key: 'renewals', alt: 'renewals' },
    { key: 'monthly_income', alt: 'monthlyIncome' }
  ];
  for (const { key, alt } of optionalEndpoints) {
    const rawVal = e[key] || e[alt];
    const pathStr = typeof rawVal === 'string' ? rawVal : rawVal?.path;
    if (pathStr) {
      const p = str(pathStr, 500);
      const valErr = validateEndpointPath(p);
      if (valErr) err(`endpoints.${key}.path`, valErr);
      else {
        const method = ((typeof rawVal === 'object' && rawVal?.method) || 'GET').toUpperCase();
        cfg.endpoints[key] = { path: p, method };
        cfg.endpoints[alt] = { path: p, method };
      }
    }
  }

  if (e.export?.path) {
    cfg.endpoints.export = { path: str(e.export.path, 300), method: (e.export.method || 'GET').toUpperCase(), page_size: intIn(e.export.page_size, 1, 5000, 500) };
    const xp = validateEndpointPath(cfg.endpoints.export.path);
    if (xp) err('endpoints.export.path', xp);
    if (!HTTP_METHODS.includes(cfg.endpoints.export.method)) err('endpoints.export.method', 'Method must be GET or POST.');
    if (Number.isNaN(cfg.endpoints.export.page_size)) err('endpoints.export.page_size', 'Export page size must be between 1 and 5000.');
  }

  // --- Request parameter mapping -------------------------------------------
  const params = {};
  const seen = new Map();
  for (const key of Object.keys(REQUEST_PARAMS)) {
    const name = str(input.params?.[key], 64);
    if (!name) continue;
    if (!NAME_RE.test(name)) err(`params.${key}`, `Invalid parameter name '${name}'.`);
    if (seen.has(name)) err(`params.${key}`, `Parameter name '${name}' is already used for ${seen.get(name)}.`);
    seen.set(name, key);
    params[key] = name;
  }
  // Default common parameter names if omitted
  if (!params.from) params.from = 'fromDate';
  if (!params.to) params.to = 'toDate';
  cfg.params = params;

  cfg.date_param_format = input.date_param_format || 'YYYY-MM-DD';
  if (!DATE_PARAM_FORMATS.includes(cfg.date_param_format)) err('date_param_format', 'Unsupported date parameter format.');
  cfg.end_date_mode = input.end_date_mode === 'exclusive' ? 'exclusive' : 'inclusive';

  cfg.report_types = {};
  for (const rt of REPORT_TYPES) {
    const v = str(input.report_types?.[rt], 64);
    if (v) {
      cfg.report_types[rt] = v;
      if (!VALUE_TOKEN_RE.test(v)) err(`report_types.${rt}`, 'Report type values may only contain letters, digits and _ . - :');
    }
  }
  if (cfg.params.report_type) {
    if (!cfg.report_types.overview) cfg.report_types.overview = 'all';
    if (!cfg.report_types.subscribers) cfg.report_types.subscribers = 'success';
    if (!cfg.report_types.renewals) cfg.report_types.renewals = 'renewal';
    if (!cfg.report_types.churn) cfg.report_types.churn = 'churn';
  }

  cfg.static_params = [];
  for (const [i, sp] of (Array.isArray(input.static_params) ? input.static_params : []).slice(0, 10).entries()) {
    const name = str(sp?.name, 64);
    const value = str(sp?.value, 200);
    if (!name) continue;
    if (!NAME_RE.test(name)) err(`static_params.${i}.name`, `Invalid parameter name '${name}'.`);
    if (seen.has(name)) err(`static_params.${i}.name`, `'${name}' is already a mapped parameter.`);
    if (/[\r\n]/.test(value)) err(`static_params.${i}.value`, 'Value may not contain line breaks.');
    cfg.static_params.push({ name, value });
  }

  cfg.extra_headers = [];
  for (const [i, h] of (Array.isArray(input.extra_headers) ? input.extra_headers : []).slice(0, 10).entries()) {
    const name = str(h?.name, 64);
    const value = str(h?.value, 500);
    if (!name) continue;
    if (!HEADER_NAME_RE.test(name)) err(`extra_headers.${i}.name`, 'Header names may only contain letters, digits and hyphens.');
    else if (isForbiddenHeader(name)) err(`extra_headers.${i}.name`, `Header '${name}' cannot be configured.`);
    if (cfg.auth.type === 'api_key' && name.toLowerCase() === cfg.auth.header_name?.toLowerCase()) err(`extra_headers.${i}.name`, 'This header is managed by the API key setting.');
    if (/[\r\n]/.test(value)) err(`extra_headers.${i}.value`, 'Header values may not contain line breaks.');
    cfg.extra_headers.push({ name, value });
  }

  // --- Pagination -----------------------------------------------------------
  const pg = input.pagination || {};
  cfg.pagination = {
    strategy: pg.strategy || 'none',
    applies_to: pg.applies_to === 'daily' ? 'daily' : 'records',
    page_start: pg.page_start === 0 || pg.page_start === '0' ? 0 : 1,
    page_size: intIn(pg.page_size, 1, 1000, 50),
    max_pages: intIn(pg.max_pages, 1, 1000, 100),
    total_path: str(pg.total_path, 200),
    total_pages_path: str(pg.total_pages_path, 200),
    has_more_path: str(pg.has_more_path, 200),
    next_cursor_path: str(pg.next_cursor_path, 200)
  };
  if (!PAGINATION_STRATEGIES.includes(cfg.pagination.strategy)) err('pagination.strategy', 'Unsupported pagination strategy.');
  if (Number.isNaN(cfg.pagination.page_size)) err('pagination.page_size', 'Page size must be between 1 and 1000.');
  if (Number.isNaN(cfg.pagination.max_pages)) err('pagination.max_pages', 'Max pages must be between 1 and 1000.');
  for (const k of ['total_path', 'total_pages_path', 'has_more_path', 'next_cursor_path']) {
    if (cfg.pagination[k] && !isValidPath(cfg.pagination[k])) err(`pagination.${k}`, 'Invalid response path.');
  }
  if (cfg.pagination.strategy === 'page' && (!params.page || !params.limit)) err('pagination.strategy', 'Page pagination needs the page number and page size parameters mapped.');
  if (cfg.pagination.strategy === 'offset' && (!params.offset || !params.limit)) err('pagination.strategy', 'Offset pagination needs the offset and page size parameters mapped.');
  if (cfg.pagination.strategy === 'cursor' && (!params.cursor || !cfg.pagination.next_cursor_path)) err('pagination.strategy', 'Cursor pagination needs the cursor parameter and the next-cursor response path.');

  // --- Response structure ---------------------------------------------------
  const r = input.response || {};
  cfg.response = {
    success_path: str(r.success_path, 200),
    success_value: r.success_value === undefined || r.success_value === '' ? true : r.success_value,
    error_message_path: str(r.error_message_path, 200),
    daily_path: str(r.daily_path, 200),
    records_path: str(r.records_path, 200),
    summary_path: str(r.summary_path, 200)
  };
  for (const k of ['success_path', 'error_message_path', 'daily_path', 'records_path', 'summary_path']) {
    if (cfg.response[k] && !isValidPath(cfg.response[k])) err(`response.${k}`, 'Invalid response path.');
  }
  if (typeof cfg.response.success_value === 'string') cfg.response.success_value = cfg.response.success_value.slice(0, 64);
  else if (!['boolean', 'number'].includes(typeof cfg.response.success_value)) cfg.response.success_value = true;

  // --- Simple Field Mappings ------------------------------------------------
  const fm = input.field_mappings || {};
  cfg.field_mappings = {};
  for (const [key, pathVal] of Object.entries(fm)) {
    const rawPath = typeof pathVal === 'string' ? pathVal : pathVal?.path;
    const path = str(rawPath, 200);
    if (!path) continue;
    if (!isValidPath(path)) {
      err(`field_mappings.${key}`, `Invalid path '${path}'.`);
      continue;
    }
    cfg.field_mappings[key] = path;
  }

  // --- Field mappings -------------------------------------------------------
  cfg.mappings = { daily: {}, summary: {}, records: {} };

  // Populate summary mappings from simple field_mappings if present
  if (cfg.field_mappings.totalSubscribers) {
    cfg.mappings.summary.subscriber_count = { path: cfg.field_mappings.totalSubscribers, type: 'integer' };
    cfg.mappings.summary.active_subscribers = { path: cfg.field_mappings.totalSubscribers, type: 'integer' };
  }
  if (cfg.field_mappings.dailySubscribers) {
    cfg.mappings.summary.new_subscribers = { path: cfg.field_mappings.dailySubscribers, type: 'integer' };
  }
  if (cfg.field_mappings.durationSubscribers) {
    cfg.mappings.summary.duration_subscribers = { path: cfg.field_mappings.durationSubscribers, type: 'integer' };
  }
  if (cfg.field_mappings.churnSubscribers) {
    cfg.mappings.summary.deactivations = { path: cfg.field_mappings.churnSubscribers, type: 'integer' };
  }
  if (cfg.field_mappings.renewals) {
    cfg.mappings.summary.renewal_count = { path: cfg.field_mappings.renewals, type: 'integer' };
  }
  if (cfg.field_mappings.monthlyIncome) {
    cfg.mappings.summary.grand_total = { path: cfg.field_mappings.monthlyIncome, type: 'decimal' };
    cfg.mappings.summary.daily_revenue = { path: cfg.field_mappings.monthlyIncome, type: 'decimal' };
  }
  for (const [group, defs] of Object.entries(FIELD_GROUPS)) {
    const supplied = input.mappings?.[group] || {};
    for (const [key, m] of Object.entries(supplied)) {
      if (!defs[key]) {
        err(`mappings.${group}.${key}`, `Unknown canonical field '${key}'.`);
        continue;
      }
      const rawPath = typeof m === 'string' ? m : m?.path;
      const path = str(rawPath, 200);
      if (!path) continue;
      if (!isValidPath(path)) {
        err(`mappings.${group}.${key}`, `Invalid path '${path}'.`);
        continue;
      }
      const entry = { path, type: defs[key].type };
      if (defs[key].type === 'date' || defs[key].type === 'datetime') {
        entry.format = m && typeof m === 'object' && m.format && DATE_FORMATS.includes(m.format) ? m.format : 'auto';
      }
      if (defs[key].type === 'decimal' || defs[key].type === 'integer') {
        entry.decimal_separator = m && typeof m === 'object' && m.decimal_separator === ',' ? ',' : '.';
      }
      if (m && typeof m === 'object' && m.label) entry.label = str(m.label, 60);
      cfg.mappings[group][key] = entry;
    }
  }
  const usesDaily = Object.keys(cfg.mappings.daily).length > 0;
  if (usesDaily && !cfg.response.daily_path && cfg.pagination.applies_to !== 'daily') err('response.daily_path', 'Set the path of the daily rows array (use "$" if the response root is the array).');
  if (usesDaily && !cfg.mappings.daily.report_date) err('mappings.daily.report_date', 'Daily rows need the report date mapped.');
  if (Object.keys(cfg.mappings.records).length > 0 && !cfg.response.records_path) err('response.records_path', 'Set the path of the records array.');
  if (Object.keys(cfg.mappings.summary).length > 0 && cfg.response.summary_path === undefined) cfg.response.summary_path = '';
  if (cfg.pagination.applies_to === 'daily' && cfg.pagination.strategy !== 'none' && !cfg.response.daily_path) cfg.response.daily_path = cfg.response.records_path;

  cfg.notes = str(input.notes, 2000);
  return { config: cfg, errors };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash binding a validation run to an exact configuration + secret version.
 */
export function configHash(integration, secretsUpdatedAt = null, platformTimezone = null) {
  return crypto
    .createHash('sha256')
    .update(stableStringify({ integration, secretsUpdatedAt: secretsUpdatedAt ? new Date(secretsUpdatedAt).toISOString() : null, platformTimezone }))
    .digest('hex');
}
