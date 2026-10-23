import { initStore, query } from '../src/store/index.js';

async function run() {
  await initStore();
  
  const currentRes = await query('SELECT integration, published_integration FROM admin_platforms WHERE id = 2');
  const existing = currentRes.rows[0]?.published_integration || currentRes.rows[0]?.integration || {};

  const field_mappings = {
    totalSubscribers: 'summary.totalSubscribers',
    dailySubscribers: 'daily[0].newSubscriptions',
    durationSubscribers: '',
    churnSubscribers: '',
    renewals: 'summary.renewals',
    monthlyIncome: 'summary.totalGhsAmount'
  };

  const updatedIntegration = {
    ...existing,
    field_mappings,
    response: {
      ...(existing.response || {}),
      summary_path: '', // root path so summary.totalSubscribers and daily[0] work directly
      daily_path: 'daily',
      records_path: 'data'
    },
    pagination: {
      strategy: 'page',
      applies_to: 'records',
      page_start: 1,
      page_size: 50,
      max_pages: 500,
      total_path: 'total'
    },
    report_types: {
      all: 'all',
      overview: 'all',
      subscribers: 'success',
      renewals: 'renewal',
      churn: 'churn'
    },
    mappings: {
      ...(existing.mappings || {}),
      summary: {
        subscriber_count: { path: 'summary.totalSubscribers', type: 'integer' },
        new_subscribers: { path: 'daily[0].newSubscriptions', type: 'integer' },
        renewal_count: { path: 'summary.renewals', type: 'integer' },
        grand_total: { path: 'summary.totalGhsAmount', type: 'decimal' }
      },
      daily: {
        report_date: { path: 'date', type: 'date' },
        new_subscribers: { path: 'newSubscriptions', type: 'integer' },
        daily_revenue: { path: 'revenueGhs', type: 'decimal' },
        grand_total: { path: 'revenueGhs', type: 'decimal' }
      },
      records: {
        record_id: { path: 'id', type: 'string' },
        msisdn: { path: 'msisdn', type: 'string' },
        offer_code: { path: 'offerCode', type: 'string' },
        reason: { path: 'reason', type: 'string' },
        lifecycle: { path: 'lifecycle', type: 'string' },
        next_billing_date: { path: 'nextBillingDate', type: 'string' },
        status: { path: 'status', type: 'string' },
        charging_amount: { path: 'chargingAmount', type: 'decimal' },
        event_time: { path: 'createdAt', type: 'datetime', format: 'auto' }
      }
    }
  };

  const modules = ['overview', 'settlement', 'revenue', 'subscribers', 'renewals', 'churn', 'subscriber_records'];

  const sql = `
    UPDATE admin_platforms 
    SET enabled_modules = $1, 
        integration = $2, 
        published_integration = $3 
    WHERE id = $4
  `;

  await query(sql, [
    JSON.stringify(modules),
    JSON.stringify(updatedIntegration),
    JSON.stringify(updatedIntegration),
    2
  ]);

  console.log('Successfully updated Platform 2 with exact field_mappings and root summary_path!');
  process.exit(0);
}

run().catch(err => {
  console.error('Error running update:', err);
  process.exit(1);
});
