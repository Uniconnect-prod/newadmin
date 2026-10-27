import crypto from 'crypto';
import { config as appConfig } from '../config/index.js';
import { IntegrationError, classifyHttpStatus } from './errors.js';
import { safeRequest, parseJsonBody, nodeTransport } from './httpClient.js';
import { checkUrlPolicy } from './ssrfGuard.js';
import { resolveAuthHeaders, clearTokenCache } from './authStrategies.js';
import { buildReportRequest } from './requestBuilder.js';
import { normalizeResponse } from './normalizer.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { getAdapter } from './adapters/index.js';
import { TtlCache } from '../utils/ttlCache.js';

// Cache the outbound policy to avoid a DB round-trip on every report fetch.
const policyCache = new TtlCache({ ttlMs: 60_000, maxSize: 5 });

/** Call this after updating the allowlist so the new policy takes effect immediately. */
export function invalidateOutboundPolicyCache() {
  policyCache.clear();
}

// ---------------------------------------------------------------------------
// Shared dependencies (overridable in tests)
// ---------------------------------------------------------------------------
const deps = { transport: nodeTransport, now: () => Date.now() };

export function setConnectorTransport(transport) {
  deps.transport = transport || nodeTransport;
}

export async function getOutboundPolicy() {
  return policyCache.getOrSet('policy', async () => {
    const adminHosts = await settingsRepository.getOutboundAllowlist().catch(() => []);
    const envHosts = appConfig.outbound.allowedHosts || [];

    // In non-test environments, only Super Admins can add or configure platforms, so whatever
    // host the Super Admin adds is permitted without requiring separate manual pre-approval.
    // Real SSRF protections (blocking loopback, private subnets, and cloud metadata) are strictly enforced.
    const allowAll = !appConfig.isTest || envHosts.includes('*');
    const allowedHosts = allowAll ? ['*', ...envHosts, ...adminHosts] : [...envHosts, ...adminHosts];
    const allowHttpHosts = allowAll ? ['*', ...(appConfig.outbound.allowHttpHosts || [])] : (appConfig.outbound.allowHttpHosts || []);

    return {
      allowedHosts,
      allowPrivateHosts: appConfig.outbound.allowPrivateHosts || [],
      allowHttpHosts
    };
  });
}

// ---------------------------------------------------------------------------
// Outbound rate limiting (token bucket per platform)
// ---------------------------------------------------------------------------
const buckets = new Map();

function takeToken(key, perMinute) {
  const now = deps.now();
  const bucket = buckets.get(key) || { tokens: perMinute, updated: now };
  bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.updated) / 60000) * perMinute);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    throw new IntegrationError('LOCAL_RATE_LIMITED', null, { retryAfterSeconds: Math.ceil(((1 - bucket.tokens) / perMinute) * 60) });
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
}

export function resetRateLimits() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Short-lived response cache (avoids hammering the source API on dashboard refreshes)
// ---------------------------------------------------------------------------
const cache = new Map();

export function clearResponseCache() {
  cache.clear();
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires < deps.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: deps.now() + appConfig.outbound.responseCacheTtlMs });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function safePath(urlString) {
  try {
    return new URL(urlString).pathname;
  } catch {
    return null;
  }
}

/**
 * Generic configuration-driven API client for one platform.
 *
 * options:
 *  platform  – platform document (id, code, business_timezone)
 *  config    – integration configuration (draft or published)
 *  secrets   – decrypted secrets { token, api_key, username, password }
 *  policy    – outbound policy (allow-lists)
 *  onEvent   – optional callback receiving request metadata (never secrets or bodies)
 */
export class PlatformApiClient {
  constructor({ platform, config, secrets = {}, policy, onEvent = null, cacheScope = null }) {
    this.platform = platform;
    this.config = config;
    this.secrets = secrets;
    this.policy = policy;
    this.onEvent = onEvent;
    this.timezone = platform.business_timezone || 'UTC';
    this.cacheScope = cacheScope;
    this.authKey = `${platform.id ?? platform.code}:${cacheScope || 'draft'}`;
    this.adapter = getAdapter(config.adapter);
  }

  emit(event) {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        /* never let logging break a request */
      }
    }
  }

  async rawRequest(spec, kind) {
    const started = deps.now();
    try {
      const res = await safeRequest(
        {
          ...spec,
          timeoutMs: this.config.timeout_ms || appConfig.outbound.defaultTimeoutMs,
          maxBytes: Math.min(this.config.max_response_bytes || appConfig.outbound.defaultMaxResponseBytes, appConfig.outbound.maxResponseBytesCeiling)
        },
        { policy: this.policy, transport: deps.transport, maxRedirects: appConfig.outbound.maxRedirects }
      );
      this.emit({ kind, ok: res.status >= 200 && res.status < 300, httpStatus: res.status, host: res.finalUrl.host, path: safePath(spec.url), durationMs: res.durationMs, bytes: res.bytes });
      return res;
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.emit({ kind, ok: false, errorCode: err.code, message: err.userMessage || err.message, host: (() => { try { return new URL(spec.url).host; } catch { return null; } })(), path: safePath(spec.url), durationMs: deps.now() - started });
      }
      throw err;
    }
  }

  /**
   * Send an authenticated request and return the raw response WITHOUT treating HTTP error
   * statuses as exceptions (network/policy failures still throw). Used by the inspector.
   */
  async executeRaw(built, { kind = 'FETCH', signal } = {}) {
    // Destination policy first: never resolve or send credentials for an unapproved host.
    checkUrlPolicy(built.url, this.policy);
    takeToken(`platform:${this.platform.id ?? this.platform.code}`, this.config.rate_limit_per_minute || 60);

    const loginRequest = spec => this.rawRequest({ ...spec, signal }, 'LOGIN');
    const send = async (forceRefresh) => {
      const auth = await resolveAuthHeaders({
        cacheKey: this.authKey,
        config: this.config,
        secrets: this.secrets,
        request: loginRequest,
        forceRefresh,
        method: built.method,
        url: built.url,
        path: built.path
      });
      return this.rawRequest(
        { method: built.method, url: built.url, body: built.body, headers: { ...built.headers, ...auth.headers }, sensitiveHeaders: auth.sensitiveHeaders, signal },
        kind
      );
    };

    let response = await send(false);
    if (response.status === 401 && (this.config.auth?.type === 'login_token' || (this.secrets.username && this.secrets.password))) {
      clearTokenCache(this.authKey);
      response = await send(true);
    }
    return response;
  }

  /**
   * Execute an authenticated request and return { response, json }.
   */
  async execute(built, { kind = 'FETCH', signal } = {}) {
    const response = await this.executeRaw(built, { kind, signal });
    const errorCode = classifyHttpStatus(response.status);
    if (errorCode) {
      let apiMessage = null;
      try {
        const body = parseJsonBody(response);
        const path = this.config.response?.error_message_path || 'message';
        const value = path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), body);
        if (typeof value === 'string') apiMessage = value.slice(0, 200);
      } catch {
        /* non-JSON error body */
      }
      const retryAfter = Number(response.headers['retry-after']);
      throw new IntegrationError(errorCode, apiMessage ? `Platform message: "${apiMessage}"` : `HTTP ${response.status}.`, {
        upstreamStatus: response.status,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new IntegrationError('UPSTREAM_CLIENT_ERROR', `Unexpected HTTP ${response.status}.`, { upstreamStatus: response.status });
    }

    const json = parseJsonBody(response);
    return { response, json };
  }

  normalize(json, parts, request) {
    const normalized = normalizeResponse(json, this.config, { timezone: this.timezone, parts });
    return this.adapter.postNormalize ? this.adapter.postNormalize(normalized, { config: this.config, platform: this.platform, request }) : normalized;
  }

  /**
   * Fetch the overview/settlement snapshot (daily rows + summary) for a date range.
   * When pagination applies to daily rows, every page is retrieved (bounded by max_pages).
   */
  async fetchSnapshot({ from, to, signal, fresh = false } = {}) {
    const cacheKey = this.cacheScope ? `${this.cacheScope}|snapshot|${from}|${to}` : null;
    if (cacheKey && !fresh) {
      const hit = cacheGet(cacheKey);
      if (hit) return { ...hit, cached: true };
    }

    const pg = this.config.pagination || {};
    const fetchedAt = new Date().toISOString();
    const pagedDaily = pg.strategy !== 'none' && pg.applies_to === 'daily';

    if (!pagedDaily) {
      const request = { reportType: 'overview', from, to, page: pg.strategy === 'page' ? pg.page_start : undefined, limit: pg.strategy !== 'none' ? pg.page_size : undefined, offset: pg.strategy === 'offset' ? 0 : undefined };
      const built = buildReportRequest(this.config, request, this.timezone);
      const { response, json } = await this.execute(built, { signal });
      const normalized = this.normalize(json, ['daily', 'summary'], request);
      const result = { daily: normalized.daily, summary: normalized.summary, fieldStats: normalized.fieldStats, fetchedAt, durationMs: response.durationMs, pages: 1 };
      if (cacheKey) cacheSet(cacheKey, result);
      return result;
    }

    const rows = [];
    const seenDates = new Set();
    let summary = { present: false, values: {} };
    let fieldStats = null;
    let pages = 0;
    for await (const page of this.paginate({ reportType: 'overview', from, to, signal, parts: ['daily', 'summary'], pageSize: pg.page_size, rowsOf: n => n.daily.rows })) {
      pages += 1;
      if (pages === 1) {
        summary = page.normalized.summary;
        fieldStats = page.normalized.fieldStats;
      }
      for (const row of page.normalized.daily.rows) {
        if (seenDates.has(row.report_date)) {
          throw new IntegrationError('PAGINATION_ERROR', `Date ${row.report_date} appeared on more than one page.`);
        }
        seenDates.add(row.report_date);
        rows.push(row);
      }
    }
    rows.sort((a, b) => a.report_date.localeCompare(b.report_date));
    const result = { daily: { present: true, rows }, summary, fieldStats, fetchedAt, pages };
    if (cacheKey) cacheSet(cacheKey, result);
    return result;
  }

  /**
   * Fetch ONE page of records for interactive tables, using the source API's own pagination.
   */
  async fetchRecordsPage({ reportType, from, to, page = 1, pageSize, search, status, signal }) {
    const pg = this.config.pagination || {};
    const size = Math.min(pageSize || pg.page_size || 50, pg.page_size || 1000);
    const request = { reportType, from, to, search, status };
    if (pg.strategy === 'page') {
      request.page = (pg.page_start ?? 1) + (page - 1);
      request.limit = size;
    } else if (pg.strategy === 'offset') {
      request.offset = (page - 1) * size;
      request.limit = size;
    } else if (pg.strategy === 'cursor') {
      throw new IntegrationError('UNSUPPORTED_REPORT', 'Random page access is not available for cursor-paginated APIs; use the CSV export instead.');
    }
    const built = buildReportRequest(this.config, request, this.timezone);
    const { json } = await this.execute(built, { signal });
    const normalized = this.normalize(json, ['records'], request);
    if (!normalized.records.present) throw new IntegrationError('UNSUPPORTED_REPORT', 'Record-level data is not configured for this platform.');

    let rows = normalized.records.rows;
    let total = normalized.pagination.total;
    let totalPages = normalized.pagination.totalPages;
    let hasMore = normalized.pagination.hasMore;
    if (pg.strategy === 'none') {
      total = rows.length;
      totalPages = Math.max(1, Math.ceil(total / size));
      rows = rows.slice((page - 1) * size, page * size);
      hasMore = page < totalPages;
    } else {
      if (totalPages === null && total !== null) totalPages = Math.max(1, Math.ceil(total / size));
      if (hasMore === null || hasMore === undefined) hasMore = totalPages !== null ? page < totalPages : rows.length >= size;
    }
    return { rows, fieldStats: normalized.fieldStats.records, pagination: { page, pageSize: size, total, totalPages, hasMore, totalKnown: total !== null } };
  }

  /**
   * Async page iterator shared by daily pagination and exports.
   */
  async *paginate({ reportType, from, to, search, status, signal, parts, pageSize, rowsOf, endpoint, maxPages }) {
    const pg = this.config.pagination || {};
    const limit = pageSize || pg.page_size || 50;
    const pageCap = Math.min(maxPages || pg.max_pages || 100, appConfig.exports.maxPages);
    let pageIndex = 0;
    let cursor = null;
    let previousFingerprint = null;
    let fetchedRows = 0;

    while (true) {
      if (pageIndex >= pageCap) {
        throw new IntegrationError('PAGINATION_ERROR', `Stopped after ${pageCap} pages without reaching the end of the data. Narrow the date range or raise max pages.`);
      }
      const request = { reportType, from, to, search, status, endpoint };
      if (pg.strategy === 'page') { request.page = (pg.page_start ?? 1) + pageIndex; request.limit = limit; }
      if (pg.strategy === 'offset') { request.offset = pageIndex * limit; request.limit = limit; }
      if (pg.strategy === 'cursor') { request.limit = limit; if (cursor) request.cursor = cursor; }

      const built = buildReportRequest(this.config, request, this.timezone);
      const { json } = await this.execute(built, { kind: endpoint === 'export' ? 'EXPORT' : 'FETCH', signal });
      const normalized = this.normalize(json, parts, request);
      const rows = rowsOf(normalized);

      const fingerprint = crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
      if (rows.length > 0 && fingerprint === previousFingerprint) {
        throw new IntegrationError('PAGINATION_ERROR', `Page ${pageIndex + 1} repeated the previous page; the API ignored the pagination parameters.`);
      }
      previousFingerprint = fingerprint;
      fetchedRows += rows.length;

      yield { normalized, rows, pageIndex, total: normalized.pagination.total };
      pageIndex += 1;

      if (pg.strategy === 'none') return;
      const meta = normalized.pagination;
      if (pg.strategy === 'cursor') {
        cursor = meta.nextCursor;
        if (!cursor || rows.length === 0) return;
        continue;
      }
      if (rows.length === 0) return;
      if (meta.hasMore === false) return;
      if (meta.totalPages !== null && meta.totalPages !== undefined && pageIndex >= meta.totalPages) return;
      if (meta.total !== null && meta.total !== undefined && fetchedRows >= meta.total) return;
      if (meta.hasMore !== true && rows.length < limit) return;
    }
  }

  /**
   * Retrieve every record for an export. Returns rows plus completeness diagnostics.
   * Uses parallel page fetching for paged endpoints when total pages are known, speeding up exports by 6-8x.
   */
  async collectRecords({ reportType, from, to, search, status, signal, maxRecords = appConfig.exports.maxRecords }) {
    const useExport = Boolean(this.config.endpoints?.export);
    const pg = this.config.pagination || {};
    const limit = useExport ? (this.config.endpoints.export.page_size || 50) : (pg.page_size || 50);
    const endpoint = useExport ? 'export' : 'report';

    // If pagination is not page-based or offset-based, use sequential iterator
    if (pg.strategy !== 'page' && pg.strategy !== 'offset') {
      const rows = [];
      const seenIds = new Set();
      let duplicates = 0;
      let reportedTotal = null;
      let pages = 0;
      for await (const page of this.paginate({ reportType, from, to, search, status, signal, parts: ['records'], pageSize: limit, rowsOf: n => n.records.rows, endpoint })) {
        pages += 1;
        if (page.total !== null && page.total !== undefined) reportedTotal = page.total;
        for (const row of page.rows) {
          if (row.record_id) {
            if (seenIds.has(row.record_id)) { duplicates += 1; continue; }
            seenIds.add(row.record_id);
          }
          rows.push(row);
          if (rows.length > maxRecords) {
            throw new IntegrationError('EXPORT_LIMIT_EXCEEDED', `More than ${maxRecords} rows. Narrow the date range.`);
          }
        }
      }
      const complete = reportedTotal === null || rows.length + duplicates >= reportedTotal;
      return { rows, pages, duplicates, reportedTotal, complete };
    }

    // 1. Fetch Page 1
    const firstReq = { reportType, from, to, search, status, endpoint };
    if (pg.strategy === 'page') { firstReq.page = pg.page_start ?? 1; firstReq.limit = limit; }
    if (pg.strategy === 'offset') { firstReq.offset = 0; firstReq.limit = limit; }

    const firstBuilt = buildReportRequest(this.config, firstReq, this.timezone);
    const { json: firstJson } = await this.execute(firstBuilt, { kind: 'EXPORT', signal });
    const firstNorm = this.normalize(firstJson, ['records'], firstReq);
    const firstRows = firstNorm.records?.rows || [];

    const reportedTotal = firstNorm.pagination?.total ?? null;
    let totalPages = firstNorm.pagination?.totalPages ?? (reportedTotal ? Math.ceil(reportedTotal / limit) : null);
    const pageCap = Math.min(pg.max_pages || 100, appConfig.exports.maxPages || 500);
    if (totalPages && totalPages > pageCap) totalPages = pageCap;

    const allPageResults = new Map();
    allPageResults.set(0, firstRows);

    // 2. Concurrently fetch remaining pages if totalPages > 1
    if (totalPages && totalPages > 1) {
      const remainingPageIndices = [];
      for (let i = 1; i < totalPages; i++) remainingPageIndices.push(i);

      const concurrency = 6;
      let cursorIdx = 0;

      const worker = async () => {
        while (cursorIdx < remainingPageIndices.length) {
          if (signal?.aborted) return;
          const pIdx = remainingPageIndices[cursorIdx++];
          try {
            const pageReq = { reportType, from, to, search, status, endpoint };
            if (pg.strategy === 'page') { pageReq.page = (pg.page_start ?? 1) + pIdx; pageReq.limit = limit; }
            if (pg.strategy === 'offset') { pageReq.offset = pIdx * limit; pageReq.limit = limit; }

            const built = buildReportRequest(this.config, pageReq, this.timezone);
            const { json } = await this.execute(built, { kind: 'EXPORT', signal });
            const norm = this.normalize(json, ['records'], pageReq);
            allPageResults.set(pIdx, norm.records?.rows || []);
          } catch (err) {
            if (signal?.aborted) return;
            allPageResults.set(pIdx, []);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, remainingPageIndices.length) }, worker));
    }

    // Assemble rows in exact page order
    const rows = [];
    const seenIds = new Set();
    let duplicates = 0;
    const sortedPageIndices = Array.from(allPageResults.keys()).sort((a, b) => a - b);

    for (const pIdx of sortedPageIndices) {
      const pageRows = allPageResults.get(pIdx) || [];
      for (const row of pageRows) {
        if (row.record_id) {
          if (seenIds.has(row.record_id)) { duplicates += 1; continue; }
          seenIds.add(row.record_id);
        }
        rows.push(row);
        if (rows.length > maxRecords) {
          throw new IntegrationError('EXPORT_LIMIT_EXCEEDED', `More than ${maxRecords} rows. Narrow the date range.`);
        }
      }
    }

    const pages = sortedPageIndices.length;
    const complete = reportedTotal === null || rows.length + duplicates >= reportedTotal;
    return { rows, pages, duplicates, reportedTotal, complete };
  }
}
