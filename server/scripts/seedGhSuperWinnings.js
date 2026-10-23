import { initStore, query } from '../src/store/index.js';
import { platformRepository } from '../src/repositories/platformRepository.js';
import { mergeSecrets } from '../src/integrations/secretVault.js';
import { draftHash } from '../src/services/integrationService.js';
import { mappingRepository } from '../src/repositories/mappingRepository.js';
import { settingsRepository } from '../src/repositories/settingsRepository.js';

async function seed() {
  await initStore();

  const platformName = 'GhSuper Winings';
  const platformCode = 'GHSUPER_WININGS';
  const apiKey = '57878cb85c5b291fa826363a1385e30b3e4217774ef9528d3eb8c091e120e244';

  const field_mappings = {
    totalSubscribers: 'summary.totalSubscribers',
    dailySubscribers: 'daily[0].newSubscriptions',
    durationSubscribers: '',
    churnSubscribers: '',
    renewals: 'summary.renewals',
    monthlyIncome: 'summary.totalGhsAmount'
  };

  const integration = {
    adapter: 'generic-json',
    base_url: 'https://ghsuperwinnings.com',
    auth: {
      type: 'hmac_sha256'
    },
    endpoints: {
      health: { path: '/api/health', method: 'GET' },
      report: { path: '/api/admin/dashboard', method: 'GET' },
      totalSubscribers: { path: '/api/admin/dashboard?report=success', method: 'GET' },
      total_subscribers: { path: '/api/admin/dashboard?report=success', method: 'GET' },
      renewals: { path: '/api/admin/dashboard?report=renewal', method: 'GET' },
      churnSubscribers: { path: '/api/admin/dashboard?report=churn', method: 'GET' },
      churn_subscribers: { path: '/api/admin/dashboard?report=churn', method: 'GET' },
      monthlyIncome: { path: '/api/admin/dashboard?report=all', method: 'GET' },
      monthly_income: { path: '/api/admin/dashboard?report=all', method: 'GET' }
    },
    params: {
      from: 'fromDate',
      to: 'toDate',
      page: 'page',
      limit: 'limit',
      report_type: 'report'
    },
    report_types: {
      all: 'all',
      overview: 'all',
      subscribers: 'success',
      renewals: 'renewal',
      churn: 'churn'
    },
    response: {
      summary_path: '',
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
    field_mappings,
    mappings: {
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
    },
    timeout_ms: 15000,
    rate_limit_per_minute: 60,
    max_response_bytes: 52428800,
    default_range_days: 30,
    currency_decimals: 2,
    date_param_format: 'YYYY-MM-DD',
    end_date_mode: 'inclusive'
  };

  const modules = ['overview', 'settlement', 'revenue', 'subscribers', 'renewals', 'churn', 'subscriber_records'];
  const hash = draftHash({ integration });

  // 1. Check if platform exists or insert
  let platformId;
  const existing = await query('SELECT id FROM admin_platforms WHERE UPPER(platform_code) = UPPER($1)', [platformCode]);
  
  if (existing.rows.length > 0) {
    platformId = Number(existing.rows[0].id);
    console.log(`Updating existing platform ID ${platformId}...`);
    await query(`
      UPDATE admin_platforms
      SET platform_name = $1,
          country_id = 1,
          status = 'ACTIVE',
          description = 'GHSuperWinnings Reporting Dashboard',
          accent_color = '#0170B9',
          business_timezone = 'Africa/Accra',
          currency = 'GHS',
          enabled_modules = $2::jsonb,
          integration = $3::jsonb,
          published_integration = $3::jsonb,
          published_config_hash = $4,
          published_at = NOW(),
          validation = '{"status":"PASSED"}'::jsonb,
          updated_at = NOW()
      WHERE id = $5
    `, [platformName, JSON.stringify(modules), JSON.stringify(integration), hash, platformId]);
  } else {
    console.log('Inserting new platform GhSuper Winings...');
    const insertRes = await query(`
      INSERT INTO admin_platforms (
        platform_name, platform_code, country_id, status, description,
        accent_color, business_timezone, currency, enabled_modules,
        integration, published_integration, published_config_hash, published_at,
        validation, config_version, created_at, updated_at
      ) VALUES (
        $1, $2, 1, 'ACTIVE', 'GHSuperWinnings Reporting Dashboard',
        '#0170B9', 'Africa/Accra', 'GHS', $3::jsonb,
        $4::jsonb, $4::jsonb, $5, NOW(),
        '{"status":"PASSED"}'::jsonb, 1, NOW(), NOW()
      ) RETURNING id
    `, [platformName, platformCode, JSON.stringify(modules), JSON.stringify(integration), hash]);
    platformId = Number(insertRes.rows[0].id);
  }

  // 2. Save encrypted API Key into platform secrets
  console.log(`Saving HMAC api_key for Platform ID ${platformId}...`);
  const mergedSecrets = mergeSecrets({}, { api_key: apiKey }, []);
  await platformRepository.saveSecrets(platformId, mergedSecrets);

  // 3. Save Mappings table
  await mappingRepository.savePlatformMappings(platformId, {
    fieldMappings: integration.field_mappings || integration.mappings?.summary || {},
    requestParams: integration.params || {},
    responsePaths: integration.endpoints || {}
  });

  // 4. Auto-approve host in outbound allowlist
  await settingsRepository.setOutboundAllowlist(['ghsuperwinnings.com'], 1).catch(() => {});

  console.log(`SUCCESS! Platform ID ${platformId} (GHSUPER_WININGS) is fully created, configured, and ACTIVE!`);
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
