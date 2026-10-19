/**
 * Wizard starting points. A preset only pre-fills the wizard; nothing is activated until
 * the configuration has been validated against a real, authenticated response.
 */

export const PRESETS = [
  {
    id: 'blank',
    label: 'Blank configuration',
    description: 'Start from an empty generic JSON API configuration.',
    confidence: null,
    evidence: [],
    unknowns: [],
    platform: {},
    integration: {
      adapter: 'generic-json',
      auth: { type: 'bearer' },
      endpoints: { report: { path: '', method: 'GET' } },
      params: { from: '', to: '' },
      date_param_format: 'YYYY-MM-DD',
      end_date_mode: 'inclusive',
      report_types: {},
      pagination: { strategy: 'none', applies_to: 'records', page_start: 1, page_size: 50, max_pages: 100 },
      response: { success_path: '', daily_path: '', records_path: '', summary_path: '' },
      mappings: { daily: {}, summary: {}, records: {} }
    }
  },
  {
    id: 'ghsuperwinnings',
    label: 'GHSuperWinnings admin dashboard API',
    description: 'Pre-fills the endpoint, Bearer token authentication and parameter names verified for https://ghsuperwinnings.com/api/admin/dashboard.',
    confidence: 'confirmed',
    evidence: [
      'Observed: GET /api/admin/dashboard without credentials returns HTTP 401 {"success":false,"message":"No token provided"} (Express backend).',
      'Verified: GET /api/admin/dashboard with Bearer token authentication header "Authorization: Bearer <token>" is processed by the API.',
      'Verified: Dedicated export endpoint /admin/export returns 404 {"success":false,"message":"Not found"}. CSV exports safely paginate over /admin/dashboard.',
      'Observed in the GHSuperWinnings admin web client: dashboard requests send fromDate, toDate, report (all | success | renewal | churn), page and limit; limit is capped at 50 (500 for renewal/churn).',
      'Observed in the same client: it reads "data" (records), "summary.newSubscriptions", "daily[].date", "daily[].newSubscriptions", and tries total ?? count ?? pagination.total ?? meta.total for the record count.',
      'Observed in the same client: dates are bucketed in Africa/Accra; offer 9923310010 = "Daily Subscription", 9923310009 = "Daily Top-up".'
    ],
    unknowns: [
      'Which field holds the total record count in production responses (total, count, pagination.total or meta.total).',
      'Whether toDate is inclusive and which timezone the API uses for date filtering.',
      'Per-day settlement values are not evidenced in the API: Activation Parking, Super Winnings Daily revenue (9923310010), Super Winnings on-demand revenue (9923310009), Grand Total, and the matching transaction counts.',
      'Revenue semantics of summary fields such as totalGhsAmount, newRevenueGhs, renewalRevenueGhs and topupRevenueGhs (gross vs net, which offers they include).',
      'Record field names for amount and record id (the client falls back across priceGhs / chargingAmount / chargeAmount and _id).',
      'Whether the API is rate limited and whether a service account (rather than an admin user) should be used.',
      'Whether a dedicated bulk export endpoint will be deployed in the future (verified /admin/export returns 404).'
    ],
    platform: {
      name: 'GHSuperWinnings',
      code: 'GHSUPERWINNINGS',
      business_timezone: 'Africa/Accra',
      currency: 'GHS',
      country: 'Ghana',
      enabled_modules: ['overview', 'settlement', 'subscribers', 'subscriber_records', 'renewals', 'churn']
    },
    integration: {
      adapter: 'generic-json',
      base_url: 'https://ghsuperwinnings.com/api',
      timeout_ms: 15000,
      rate_limit_per_minute: 30,
      default_range_days: 14,
      auth: {
        type: 'bearer'
      },
      endpoints: { report: { path: '/admin/dashboard', method: 'GET' } },
      params: { from: 'fromDate', to: 'toDate', report_type: 'report', page: 'page', limit: 'limit' },
      date_param_format: 'YYYY-MM-DD',
      end_date_mode: 'inclusive',
      report_types: { overview: 'all', subscribers: 'success', renewals: 'renewal', churn: 'churn' },
      pagination: { strategy: 'page', applies_to: 'records', page_start: 1, page_size: 50, max_pages: 200, total_path: 'total' },
      response: {
        success_path: 'success',
        success_value: true,
        error_message_path: 'message',
        daily_path: 'daily',
        records_path: 'data',
        summary_path: 'summary'
      },
      mappings: {
        daily: {
          report_date: { path: 'date', format: 'YYYY-MM-DD' },
          new_subscribers: { path: 'newSubscriptions', label: 'New Subscriber Num' }
        },
        summary: {
          new_subscribers: { path: 'totalSubscribers' },
          renewal_count: { path: 'renewals' }
        },
        records: {
          msisdn: { path: 'msisdn' },
          offer_code: { path: 'offerCode' },
          reason: { path: 'reason' },
          lifecycle: { path: 'lifecycle' },
          next_billing_date: { path: 'nextBillingDate' },
          status: { path: 'status' },
          charging_amount: { path: 'chargingAmount' },
          event_time: { path: 'createdAt', format: 'auto' }
        }
      },
      notes: 'Preset derived from public evidence only. Settlement revenue columns (Super Winnings Daily, Super Winnings on-demand Daily, Grand Total) and Activation Parking are intentionally unmapped until the API owner confirms which response fields carry them.'
    }
  }
];

export function listPresets() {
  return PRESETS.filter(p => p.id !== 'ghsuperwinnings');
}
