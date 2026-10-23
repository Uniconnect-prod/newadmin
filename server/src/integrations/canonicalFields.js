/**
 * Canonical reporting model. Platform API fields are mapped onto these keys.
 * None of them is mandatory for every platform: a platform exposes whatever subset its
 * API provides and every report shows the rest as "unavailable".
 *
 * kind:
 *   - count    : additive integer (flow) metric, summable across days
 *   - stock    : point-in-time integer (e.g. subscriber base); NOT summable across days
 *   - currency : additive money amount in the platform currency
 */

export const DAILY_FIELDS = {
  report_date: { label: 'Date', type: 'date', kind: 'key', description: 'Business date of the row.' },
  new_subscribers: { label: 'New subscribers', type: 'integer', kind: 'count' },
  activation_parking: { label: 'Activation parking', type: 'integer', kind: 'count', description: 'Activations parked (e.g. insufficient balance) awaiting billing.' },
  daily_revenue: { label: 'Daily offer revenue', type: 'decimal', kind: 'currency', pairedCount: 'daily_transactions' },
  ondemand_revenue: { label: 'On-demand revenue', type: 'decimal', kind: 'currency', pairedCount: 'ondemand_transactions' },
  grand_total: { label: 'Grand total', type: 'decimal', kind: 'currency', pairedCount: 'transaction_count' },
  daily_transactions: { label: 'Daily offer transactions', type: 'integer', kind: 'count' },
  ondemand_transactions: { label: 'On-demand transactions', type: 'integer', kind: 'count' },
  transaction_count: { label: 'Transactions', type: 'integer', kind: 'count' },
  renewal_count: { label: 'Renewals', type: 'integer', kind: 'count' },
  failed_renewal_count: { label: 'Failed renewals', type: 'integer', kind: 'count' },
  successful_charges: { label: 'Successful charges', type: 'integer', kind: 'count' },
  failed_charges: { label: 'Failed charges', type: 'integer', kind: 'count' },
  deactivations: { label: 'Deactivations', type: 'integer', kind: 'count' },
  subscriber_count: { label: 'Total subscribers', type: 'integer', kind: 'stock' },
  active_subscribers: { label: 'Active subscribers', type: 'integer', kind: 'stock' },
  duration_subscribers: { label: 'Duration subscribers', type: 'integer', kind: 'stock', description: 'Active subscribers across duration window.' }
};

export const SUMMARY_FIELDS = {
  new_subscribers: { label: 'New subscribers', type: 'integer', kind: 'count' },
  activation_parking: { label: 'Activation parking', type: 'integer', kind: 'count' },
  subscriber_count: { label: 'Total subscribers', type: 'integer', kind: 'stock' },
  active_subscribers: { label: 'Active subscribers', type: 'integer', kind: 'stock' },
  duration_subscribers: { label: 'Duration subscribers', type: 'integer', kind: 'stock', description: 'Active subscribers across duration window.' },
  renewal_count: { label: 'Renewals', type: 'integer', kind: 'count' },
  failed_renewal_count: { label: 'Failed renewals', type: 'integer', kind: 'count' },
  successful_charges: { label: 'Successful charges', type: 'integer', kind: 'count' },
  failed_charges: { label: 'Failed charges', type: 'integer', kind: 'count' },
  transaction_count: { label: 'Transactions', type: 'integer', kind: 'count' },
  deactivations: { label: 'Deactivations', type: 'integer', kind: 'count' },
  daily_revenue: { label: 'Daily offer revenue', type: 'decimal', kind: 'currency' },
  ondemand_revenue: { label: 'On-demand revenue', type: 'decimal', kind: 'currency' },
  grand_total: { label: 'Grand total revenue', type: 'decimal', kind: 'currency' }
};

export const RECORD_FIELDS = {
  record_id: { label: 'Record ID', type: 'string' },
  msisdn: { label: 'MSISDN', type: 'string' },
  event_time: { label: 'Created At', type: 'datetime' },
  event_type: { label: 'Event type', type: 'string' },
  status: { label: 'Status', type: 'string' },
  offer_code: { label: 'Offer Code', type: 'string' },
  amount: { label: 'Amount', type: 'decimal' },
  charging_amount: { label: 'Charging Amount', type: 'decimal' },
  reason: { label: 'Reason', type: 'string' },
  lifecycle: { label: 'Lifecycle', type: 'string' },
  next_billing_date: { label: 'Next Billing Date', type: 'string' },
  channel: { label: 'Channel', type: 'string' }
};

export const FIELD_GROUPS = { daily: DAILY_FIELDS, summary: SUMMARY_FIELDS, records: RECORD_FIELDS };

/**
 * Settlement report column order (after the date column).
 */
export const SETTLEMENT_COLUMNS = ['new_subscribers', 'activation_parking', 'daily_revenue', 'ondemand_revenue', 'grand_total'];

/**
 * Canonical report types the dashboard may request; each platform maps them to its own
 * report parameter values (e.g. GHSuperWinnings uses report=all|renewal|churn).
 */
export const REPORT_TYPES = ['overview', 'subscribers', 'renewals', 'churn'];

/**
 * Canonical request parameters that may be mapped to platform-specific names.
 */
export const REQUEST_PARAMS = {
  from: { label: 'Start date', required: true },
  to: { label: 'End date', required: true },
  report_type: { label: 'Report type' },
  page: { label: 'Page number' },
  limit: { label: 'Page size' },
  offset: { label: 'Offset' },
  search: { label: 'Search (MSISDN)' },
  status: { label: 'Subscriber status' },
  cursor: { label: 'Cursor' }
};
