import { resolvePath, isValidPath } from './jsonPath.js';
import { safeRequest } from './httpClient.js';
import { getOutboundPolicy } from './connector.js';

export const DASHBOARD_METRICS = [
  {
    id: 'totalSubscribers',
    label: 'Total Subscribers',
    description: 'Total active subscriber base',
    canonical: 'subscriber_count',
    candidates: [
      'totalsubscribers', 'total_subscribers', 'totalsubs', 'total_subs',
      'subscribers_total', 'total_subscriber_count', 'totalsubscribercount',
      'active_subscribers', 'activesubscribers', 'subscriber_count', 'subscribercount',
      'all_subscribers', 'current_subscribers', 'currentsubscribers', 'active_base',
      'subscribers', 'total'
    ]
  },
  {
    id: 'dailySubscribers',
    label: 'Daily Subscribers',
    description: 'New subscriptions for the period or day',
    canonical: 'new_subscribers',
    candidates: [
      'dailysubscribers', 'daily_subscribers', 'newsubscriptions', 'new_subscriptions',
      'newsubscribers', 'new_subscribers', 'todaysubscribers', 'today_subscribers',
      'dailynew', 'daily_new', 'dailysubs', 'daily_subs', 'new_users', 'newusers',
      'daily_count', 'dailycount', 'new_subs', 'newsubs'
    ]
  },
  {
    id: 'durationSubscribers',
    label: 'Duration Subscribers',
    description: 'Subscribers active across duration / validity window',
    canonical: 'duration_subscribers',
    candidates: [
      'durationsubscribers', 'duration_subscribers', 'durationsubs', 'duration_subs',
      'activedurationsubscribers', 'active_duration_subscribers', 'duration',
      'duration_count', 'durationcount', 'activeduration', 'active_duration',
      'period_subscribers', 'periodsubscribers'
    ]
  },
  {
    id: 'churnSubscribers',
    label: 'Churn Subscribers',
    description: 'Unsubscriptions / deactivations / churned accounts',
    canonical: 'deactivations',
    candidates: [
      'churnsubscribers', 'churn_subscribers', 'churn', 'unsubscriptions',
      'unsubscribers', 'deactivations', 'deactivation_count', 'churncount',
      'churn_count', 'unsubs', 'unsub_count', 'cancelled', 'canceled',
      'canceled_subscribers', 'cancelled_subscribers', 'optouts', 'opt_outs'
    ]
  },
  {
    id: 'renewals',
    label: 'Renewals',
    description: 'Successful recurring renewals',
    canonical: 'renewal_count',
    candidates: [
      'renewals', 'renewal_count', 'renewalcount', 'renewed_subscribers',
      'renewedsubscribers', 'totalrenewals', 'total_renewals', 'renewals_count',
      'renewalscount', 'successfulrenewals', 'successful_renewals', 'recurring_count'
    ]
  },
  {
    id: 'monthlyIncome',
    label: 'Monthly Income',
    description: 'Total revenue / monthly income generated',
    canonical: 'grand_total',
    candidates: [
      'monthlyincome', 'monthly_income', 'totalrevenue', 'total_revenue',
      'monthlyrevenue', 'monthly_revenue', 'revenue', 'income', 'totalamount',
      'total_amount', 'grandtotal', 'grand_total', 'totalghsamount',
      'total_income', 'earnings', 'daily_revenue', 'dailyrevenue', 'amount'
    ]
  }
];

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isNumericValue(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return true;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val.replace(/,/g, ''));
    return Number.isFinite(num);
  }
  return false;
}

function parseNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const num = Number(val.replace(/,/g, ''));
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Recursively scans a JSON object and extracts candidate field paths with their values.
 */
function extractLeafNodes(obj, prefix = '', depth = 0, results = []) {
  if (depth > 6 || obj === null || obj === undefined) return results;

  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
      // Check first item of array as sample
      extractLeafNodes(obj[0], prefix ? `${prefix}[0]` : '[0]', depth + 1, results);
    }
    return results;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object') {
        extractLeafNodes(value, currentPath, depth + 1, results);
      } else {
        results.push({
          key,
          normKey: normalizeKey(key),
          path: currentPath,
          value
        });
      }
    }
  }

  return results;
}

/**
 * Automatically detects common field names in a JSON response for the 6 core metrics.
 */
export function detectFieldMappings(json) {
  const detectedMappings = {};
  const detectedValues = {};
  const warnings = [];

  if (!json || typeof json !== 'object') {
    return { detectedMappings, detectedValues, warnings };
  }

  const leaves = extractLeafNodes(json);

  for (const metric of DASHBOARD_METRICS) {
    const matches = [];

    for (const leaf of leaves) {
      if (!isNumericValue(leaf.value)) continue;

      const idx = metric.candidates.indexOf(leaf.normKey);
      if (idx !== -1) {
        matches.push({
          path: leaf.path,
          value: parseNumber(leaf.value),
          priority: idx
        });
      }
    }

    if (matches.length > 0) {
      // Sort by priority (exact candidate order in definition)
      matches.sort((a, b) => a.priority - b.priority);
      const chosen = matches[0];
      detectedMappings[metric.id] = chosen.path;
      detectedValues[metric.id] = chosen.value;

      // Check for ambiguity
      const distinctValues = [...new Set(matches.map(m => m.value))];
      if (distinctValues.length > 1) {
        warnings.push({
          metric: metric.id,
          metricLabel: metric.label,
          selectedPath: chosen.path,
          selectedValue: chosen.value,
          otherCandidates: matches.slice(1).map(m => ({ path: m.path, value: m.value })),
          message: `Multiple distinct candidate fields found for "${metric.label}". Selected "${chosen.path}" (${chosen.value}). You can override this if needed.`
        });
      }
    }
  }

  return {
    detectedMappings,
    detectedValues,
    detectedCount: Object.keys(detectedMappings).length,
    warnings
  };
}

/**
 * Evaluates current mapping configuration against a sample response.
 */
export function evaluateMetricMappings(json, mappings = {}) {
  const results = {};

  for (const metric of DASHBOARD_METRICS) {
    const path = mappings[metric.id];

    if (!path || !String(path).trim()) {
      results[metric.id] = {
        metric: metric.id,
        label: metric.label,
        path: null,
        value: null,
        configured: false,
        valid: null,
        error: null
      };
      continue;
    }

    const cleanPath = String(path).trim();
    if (!isValidPath(cleanPath)) {
      results[metric.id] = {
        metric: metric.id,
        label: metric.label,
        path: cleanPath,
        value: null,
        configured: true,
        valid: false,
        error: `Invalid JSON path syntax: "${cleanPath}"`
      };
      continue;
    }

    const { found, value } = resolvePath(json, cleanPath);

    if (!found) {
      results[metric.id] = {
        metric: metric.id,
        label: metric.label,
        path: cleanPath,
        value: null,
        configured: true,
        valid: false,
        error: `Path "${cleanPath}" not found in response.`
      };
      continue;
    }

    if (value === null || value === undefined) {
      results[metric.id] = {
        metric: metric.id,
        label: metric.label,
        path: cleanPath,
        value: null,
        configured: true,
        valid: true,
        warning: 'Value is null/empty in the response.'
      };
      continue;
    }

    if (!isNumericValue(value)) {
      results[metric.id] = {
        metric: metric.id,
        label: metric.label,
        path: cleanPath,
        value,
        configured: true,
        valid: false,
        error: `Expected numeric value, but received ${typeof value} ("${String(value).slice(0, 50)}")`
      };
      continue;
    }

    const num = parseNumber(value);
    results[metric.id] = {
      metric: metric.id,
      label: metric.label,
      path: cleanPath,
      value: num,
      formatted: num.toLocaleString(),
      configured: true,
      valid: true,
      error: null
    };
  }

  return results;
}

/**
 * Standalone health check test against a platform's health endpoint.
 * Explicitly separated from reporting data.
 */
export function executeHealthCheck({ baseUrl, healthPath = '/api/health', timeoutMs = 10000, headers = {} }) {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  let path = String(healthPath || '/api/health').trim();
  if (!path.startsWith('/')) path = `/${path}`;

  const fullUrl = `${cleanBase}${path}`;

  return getOutboundPolicy().then(async (policy) => {
    const started = Date.now();
    try {
      const res = await safeRequest({
        method: 'GET',
        url: fullUrl,
        headers,
        timeoutMs: Math.min(Math.max(timeoutMs, 2000), 30000)
      }, { policy });

      const durationMs = Date.now() - started;
      const isOk = res.status >= 200 && res.status < 400;

      let bodyText = res.body ? res.body.toString('utf8') : '';
      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = bodyText.slice(0, 300);
      }

      return {
        ok: isOk,
        status: res.status,
        durationMs,
        url: fullUrl,
        data: parsed,
        message: isOk
          ? `Health check succeeded in ${durationMs}ms (HTTP ${res.status})`
          : `Health check returned HTTP ${res.status}`
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      return {
        ok: false,
        status: err.status || 0,
        durationMs,
        url: fullUrl,
        error: {
          code: err.code || 'HEALTH_CHECK_FAILED',
          message: err.message || 'Failed to reach health endpoint.'
        },
        message: err.message || 'Failed to reach health endpoint.'
      };
    }
  });
}
