export function setIn(obj, path, value) {
  const parts = path.split('.');
  const root = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    cur[key] = Array.isArray(next) ? [...next] : { ...(next || {}) };
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

export function getIn(obj, path, fallback = '') {
  const v = path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
  return v === undefined || v === null ? fallback : v;
}

export function errorsToMap(errors = []) {
  const map = {};
  for (const e of errors) if (!map[e.field]) map[e.field] = e.message;
  return map;
}

export const COMMON_TIMEZONES = [
  'Africa/Accra', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Kampala', 'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Abidjan',
  'Africa/Dar_es_Salaam', 'Africa/Kinshasa', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'UTC'
];

export const MODULE_OPTIONS = [
  { id: 'overview', label: 'Overview dashboard', locked: true },
  { id: 'settlement', label: 'Daily settlement report' },
  { id: 'revenue', label: 'Revenue analytics' },
  { id: 'subscribers', label: 'Subscriber analytics' },
  { id: 'renewals', label: 'Renewals & billing' },
  { id: 'churn', label: 'Deactivations & churn' },
  { id: 'subscriber_records', label: 'Subscriber list' }
];

export const STEPS = [
  { id: 'details', label: 'Platform details', short: 'Details' },
  { id: 'api', label: 'API configuration', short: 'API' },
  { id: 'params', label: 'Request parameters', short: 'Parameters' },
  { id: 'inspect', label: 'Response inspection', short: 'Inspect' },
  { id: 'mapping', label: 'Field mapping', short: 'Mapping' },
  { id: 'validate', label: 'Validate & activate', short: 'Activate' }
];

export const CORE_METRICS = [
  {
    id: 'totalSubscribers',
    label: 'Total Subscribers',
    description: 'Total active subscriber base',
    canonical: 'subscriber_count',
    example: 'data.totalSubscribers'
  },
  {
    id: 'dailySubscribers',
    label: 'Daily Subscribers',
    description: 'New subscriptions for the period or day',
    canonical: 'new_subscribers',
    example: 'data.dailySubscribers'
  },
  {
    id: 'durationSubscribers',
    label: 'Duration Subscribers',
    description: 'Subscribers active across duration / validity window',
    canonical: 'duration_subscribers',
    example: 'data.durationSubscribers'
  },
  {
    id: 'churnSubscribers',
    label: 'Churn Subscribers',
    description: 'Unsubscriptions / deactivations / churned accounts',
    canonical: 'deactivations',
    example: 'data.churnSubscribers'
  },
  {
    id: 'renewals',
    label: 'Renewals',
    description: 'Successful recurring renewals',
    canonical: 'renewal_count',
    example: 'data.renewals'
  },
  {
    id: 'monthlyIncome',
    label: 'Monthly Income',
    description: 'Total revenue / monthly income generated',
    canonical: 'grand_total',
    example: 'data.monthlyIncome'
  }
];

export function resolveClientPath(obj, path) {
  if (!path || typeof path !== 'string' || !obj) return { found: false, value: null };
  const parts = path.trim().split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { found: false, value: null };
    }
    current = current[part];
  }
  return { found: current !== undefined, value: current };
}

export function validateClientValue(val) {
  if (val === null || val === undefined) return { valid: false, parsed: null, error: 'Value is null or undefined.' };
  if (typeof val === 'number' && Number.isFinite(val)) return { valid: true, parsed: val, error: null };
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val.replace(/,/g, ''));
    if (Number.isFinite(num)) return { valid: true, parsed: num, error: null };
  }
  return { valid: false, parsed: null, error: `Expected numeric value, received ${typeof val}.` };
}

/**
 * Collect candidate paths from an inspection result to suggest mapping paths.
 */
export function pathSuggestions(inspection) {
  const containers = inspection?.structure?.containers || [];
  const arrays = containers.filter(c => c.kind === 'array');
  const objects = containers.filter(c => c.kind === 'object');
  return {
    containers: containers.map(c => ({ path: c.path, kind: c.kind, length: c.length })),
    itemFields: Object.fromEntries(arrays.map(a => [a.path, a.itemFields || []])),
    objectFields: Object.fromEntries(objects.map(o => [o.path, o.fields || []]))
  };
}
