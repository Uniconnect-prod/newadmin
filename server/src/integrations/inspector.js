import { IntegrationError, classifyHttpStatus } from './errors.js';
import { buildReportRequest } from './requestBuilder.js';
import { normalizeResponse } from './normalizer.js';
import { detectFieldMappings, evaluateMetricMappings } from './metricAutoDetector.js';

/**
 * Safe response inspection for the "Test & inspect" step of the platform wizard.
 * The preview is sanitised: credential-like keys are redacted, personal identifiers are
 * masked, long strings and arrays are truncated. Nothing is persisted.
 */

const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|api[_-]?key|session|jwt|credential|private)/i;
const PII_KEY = /(msisdn|phone|mobile|email|e-mail|account(no|number)?)/i;
const JWT_LIKE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const PAGINATION_KEYS = /^(total|count|totalcount|total_count|totalrecords|total_records|totalitems|totalpages|total_pages|pages|page|currentpage|current_page|limit|perpage|per_page|pagesize|page_size|hasmore|has_more|hasnext|has_next|next|nextcursor|next_cursor|cursor|offset)$/i;

function maskValue(v) {
  const s = String(v);
  if (s.length <= 4) return '••••';
  return `${s.slice(0, 3)}${'•'.repeat(Math.min(6, s.length - 5))}${s.slice(-2)}`;
}

export function sanitizePreview(value, depth = 0, key = '') {
  if (depth > 6) return '[…]';
  if (key && SECRET_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 3).map(v => sanitizePreview(v, depth + 1));
    if (value.length > 3) items.push(`… ${value.length - 3} more item(s)`);
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 60)) out[k] = sanitizePreview(v, depth + 1, k);
    return out;
  }
  if (typeof value === 'string') {
    if (JWT_LIKE.test(value)) return '[redacted token]';
    if (key && PII_KEY.test(key)) return maskValue(value);
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  if (typeof value === 'number' && key && PII_KEY.test(key)) return maskValue(value);
  return value;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Describe the response structure: containers (arrays/objects) with their paths and the
 * field paths inside array items, so admins can pick mapping paths instead of guessing.
 */
export function describeStructure(json) {
  const containers = [];
  const paginationCandidates = [];

  const walk = (value, path, depth) => {
    if (depth > 5) return;
    if (Array.isArray(value)) {
      const objects = value.filter(v => v && typeof v === 'object' && !Array.isArray(v)).slice(0, 25);
      const fields = new Map();
      for (const item of objects) collectFields(item, '', 0, fields);
      containers.push({
        path: path || '$',
        kind: 'array',
        length: value.length,
        itemFields: [...fields.entries()].map(([p, info]) => ({ path: p, types: [...info.types], sample: info.sample }))
      });
      return;
    }
    if (value && typeof value === 'object') {
      const scalarFields = [];
      for (const [k, v] of Object.entries(value)) {
        const childPath = path ? `${path}.${k}` : k;
        if (PAGINATION_KEYS.test(k) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || v === null)) {
          paginationCandidates.push({ path: childPath, type: typeOf(v), value: typeof v === 'string' ? v.slice(0, 40) : v });
        }
        if (v && typeof v === 'object') walk(v, childPath, depth + 1);
        else scalarFields.push({ path: childPath, type: typeOf(v), sample: sanitizePreview(v, 0, k) });
      }
      containers.push({ path: path || '$', kind: 'object', fields: scalarFields.slice(0, 80) });
    }
  };

  const collectFields = (obj, prefix, depth, acc) => {
    if (depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        collectFields(v, p, depth + 1, acc);
        continue;
      }
      const entry = acc.get(p) || { types: new Set(), sample: undefined };
      entry.types.add(typeOf(v));
      if (entry.sample === undefined && v !== null) entry.sample = sanitizePreview(v, 0, k);
      acc.set(p, entry);
    }
  };

  walk(json, '', 0);

  const envelopeCandidates = containers
    .filter(c => c.path !== '$' && /(^|\.)(data|result|results|payload|items|rows|records|daily|summary|list|content)$/i.test(c.path))
    .map(c => ({ path: c.path, kind: c.kind, length: c.length ?? null }));

  return { containers: containers.slice(0, 40), envelopeCandidates, paginationCandidates: paginationCandidates.slice(0, 20) };
}

/**
 * Run one request against the platform API with the given (draft) configuration and
 * report everything an administrator needs to build the mapping.
 */
export async function inspectRequest(client, { reportType = 'overview', from, to, page, limit, search, status } = {}) {
  const pg = client.config.pagination || {};
  const request = {
    reportType,
    from,
    to,
    search,
    status,
    page: pg.strategy === 'page' ? (page ?? pg.page_start ?? 1) : undefined,
    limit: pg.strategy !== 'none' ? (limit ?? pg.page_size) : undefined,
    offset: pg.strategy === 'offset' ? 0 : undefined
  };
  const built = buildReportRequest(client.config, request, client.timezone);
  const target = new URL(built.url);
  const result = {
    request: { method: built.method, host: target.host, path: target.pathname, query: built.query },
    fetchedAt: new Date().toISOString(),
    ok: false
  };

  let response;
  try {
    response = await client.executeRaw(built, { kind: 'TEST' });
  } catch (err) {
    result.error = err instanceof IntegrationError ? err.toJSON() : { code: 'CONNECTION_ERROR', message: 'Request failed.' };
    return result;
  }

  result.status = response.status;
  result.durationMs = response.durationMs;
  result.bytes = response.bytes;
  result.contentType = response.headers['content-type'] || null;
  result.redirected = response.redirected;

  let json = null;
  const text = response.body.toString('utf8').replace(/^﻿/, '');
  try {
    json = text.trim() ? JSON.parse(text) : null;
  } catch {
    result.error = { code: 'INVALID_JSON', message: 'The response is not valid JSON.', detail: String(result.contentType || '').includes('html') ? 'Received HTML — check the endpoint path and authentication.' : null };
  }

  const errorCode = classifyHttpStatus(response.status);
  if (errorCode && !result.error) {
    const err = new IntegrationError(errorCode, `HTTP ${response.status}.`, { upstreamStatus: response.status });
    result.error = err.toJSON();
  }

  if (json !== null) {
    result.preview = sanitizePreview(json);
    result.structure = describeStructure(json);
    result.detection = detectFieldMappings(json);
    const activeMappings = {
      ...(client.config.mappings?.summary || {}),
      ...(client.config.field_mappings || {})
    };
    result.evaluatedMetrics = evaluateMetricMappings(json, activeMappings);
  }

  if (!errorCode && json !== null && !result.error) {
    result.ok = true;
    try {
      const normalized = normalizeResponse(json, client.config, { timezone: client.timezone, parts: ['daily', 'summary', 'records'], strict: false });
      result.mappingPreview = {
        daily: normalized.daily.present ? { rowCount: normalized.daily.rows.length, rows: normalized.daily.rows.slice(0, 5) } : null,
        summary: normalized.summary.present ? normalized.summary.values : null,
        records: normalized.records.present ? { rowCount: normalized.records.rows.length, rows: normalized.records.rows.slice(0, 5).map(r => sanitizePreview(r)) } : null,
        pagination: normalized.pagination,
        fieldStats: normalized.fieldStats
      };
    } catch (err) {
      result.mappingError = err instanceof IntegrationError ? err.toJSON() : { code: 'UNEXPECTED_SCHEMA', message: err.message };
    }
  }
  return result;
}
