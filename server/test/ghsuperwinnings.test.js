import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../src/integrations/presets.js';
import { validateIntegrationConfig } from '../src/integrations/configSchema.js';
import { buildReportRequest } from '../src/integrations/requestBuilder.js';
import { PlatformApiClient, setConnectorTransport } from '../src/integrations/connector.js';
import { normalizeResponse } from '../src/integrations/normalizer.js';
import { toCsv, csvCell } from '../src/utils/csv.js';
import { encryptSecret, decryptSecret, mergeSecrets, decryptAll, setSecretKeyForTests } from '../src/integrations/secretVault.js';
import { safeRequest } from '../src/integrations/httpClient.js';
import { checkUrlPolicy } from '../src/integrations/ssrfGuard.js';

describe('GHSuperWinnings Reporting API Integration', () => {
  const preset = PRESETS.find(p => p.id === 'ghsuperwinnings');
  const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  before(() => {
    setSecretKeyForTests(TEST_KEY);
  });

  after(() => {
    setSecretKeyForTests(null);
    setConnectorTransport(null);
  });

  describe('1. Configuration & Preset Specification', () => {
    test('preset defines base URL, reporting path, GET method, and Bearer token auth', () => {
      assert.ok(preset, 'ghsuperwinnings preset must exist');
      const { config, errors } = validateIntegrationConfig(preset.integration);
      assert.deepEqual(errors, []);
      assert.equal(config.base_url, 'https://ghsuperwinnings.com/api');
      assert.equal(config.endpoints.report.path, '/admin/dashboard');
      assert.equal(config.endpoints.report.method, 'GET');
      assert.equal(config.auth.type, 'bearer');
      assert.equal(config.endpoints.export, undefined, 'Export endpoint left empty until dedicated export verified');
    });

    test('preset specifies query parameters: fromDate, toDate, report, page, limit', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      assert.equal(config.params.from, 'fromDate');
      assert.equal(config.params.to, 'toDate');
      assert.equal(config.params.report_type, 'report');
      assert.equal(config.params.page, 'page');
      assert.equal(config.params.limit, 'limit');
      assert.equal(config.date_param_format, 'YYYY-MM-DD');
      assert.equal(config.end_date_mode, 'inclusive');
    });

    test('preset maps report types: overview -> all, subscribers -> success', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      assert.equal(config.report_types.overview, 'all');
      assert.equal(config.report_types.subscribers, 'success');
      assert.equal(config.report_types.renewals, 'renewal');
      assert.equal(config.report_types.churn, 'churn');
    });
  });

  describe('2. Reporting API Requests & URL Construction', () => {
    test('constructs GET /api/admin/dashboard with date range Oct 1-15 2026 and report=all', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const built = buildReportRequest(
        config,
        { reportType: 'overview', from: '2026-10-01', to: '2026-10-15', page: 1, limit: 50 },
        'Africa/Accra'
      );

      assert.equal(built.method, 'GET');
      assert.equal(
        built.url,
        'https://ghsuperwinnings.com/api/admin/dashboard?fromDate=2026-10-01&toDate=2026-10-15&report=all&page=1&limit=50'
      );
      assert.equal(built.query.fromDate, '2026-10-01');
      assert.equal(built.query.toDate, '2026-10-15');
      assert.equal(built.query.report, 'all');
      assert.equal(built.query.page, '1');
      assert.equal(built.query.limit, '50');
    });

    test('constructs GET /api/admin/dashboard with date range Oct 1-15 2026 and report=success', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const built = buildReportRequest(
        config,
        { reportType: 'subscribers', from: '2026-10-01', to: '2026-10-15', page: 1, limit: 50 },
        'Africa/Accra'
      );

      assert.equal(built.method, 'GET');
      assert.equal(
        built.url,
        'https://ghsuperwinnings.com/api/admin/dashboard?fromDate=2026-10-01&toDate=2026-10-15&report=success&page=1&limit=50'
      );
      assert.equal(built.query.fromDate, '2026-10-01');
      assert.equal(built.query.toDate, '2026-10-15');
      assert.equal(built.query.report, 'success');
      assert.equal(built.query.page, '1');
      assert.equal(built.query.limit, '50');
    });

    test('dynamically generates query parameters from user selection without hardcoding', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const testCases = [
        { from: '2026-09-01', to: '2026-09-30', page: 2, limit: 25, reportType: 'renewals', expectedReport: 'renewal' },
        { from: '2026-10-10', to: '2026-10-12', page: 3, limit: 100, reportType: 'churn', expectedReport: 'churn' }
      ];

      for (const tc of testCases) {
        const built = buildReportRequest(config, tc, 'Africa/Accra');
        assert.equal(built.query.fromDate, tc.from);
        assert.equal(built.query.toDate, tc.to);
        assert.equal(built.query.report, tc.expectedReport);
        assert.equal(built.query.page, String(tc.page));
        assert.equal(built.query.limit, String(tc.limit));
        assert.ok(built.url.includes(`fromDate=${tc.from}`));
        assert.ok(built.url.includes(`toDate=${tc.to}`));
        assert.ok(built.url.includes(`report=${tc.expectedReport}`));
      }
    });
  });

  describe('3. Authentication, Security & Secret Vault', () => {
    test('securely encrypts and decrypts Bearer Token at rest using AES-256-GCM', () => {
      const token = 'gh_test_bearer_token_xyz987';
      const encrypted = encryptSecret(token);
      assert.equal(encrypted.v, 1);
      assert.ok(encrypted.iv);
      assert.ok(encrypted.tag);
      assert.ok(encrypted.data);
      assert.notEqual(encrypted.data, token);

      const decrypted = decryptSecret(encrypted);
      assert.equal(decrypted, token);
    });

    test('mergeSecrets preserves existing encrypted tokens when not changed', () => {
      const existing = mergeSecrets({}, { token: 'initial_token' }, []);
      assert.ok(existing.token);

      // Keep token unchanged
      const kept = mergeSecrets(existing, {}, []);
      assert.equal(decryptSecret(kept.token), 'initial_token');

      // Clear token
      const cleared = mergeSecrets(existing, {}, ['token']);
      assert.equal(cleared.token, undefined);
    });

    test('PlatformApiClient sends Authorization: Bearer <token> in headers', async () => {
      const config = validateIntegrationConfig(preset.integration).config;
      let interceptedHeaders = null;

      const mockTransport = async (req) => {
        interceptedHeaders = req.headers;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({
            success: true,
            summary: { newSubscriptions: 10, renewals: 5 },
            daily: [{ date: '2026-10-01', newSubscriptions: 10 }],
            data: [],
            total: 0
          }))
        };
      };

      setConnectorTransport(mockTransport);

      const client = new PlatformApiClient({
        platform: { id: 1, code: 'GHSUPERWINNINGS', business_timezone: 'Africa/Accra' },
        config,
        secrets: { token: 'gh_secret_bearer_token_123' },
        policy: { allowedHosts: ['ghsuperwinnings.com'], allowPrivateHosts: false, allowHttpHosts: false }
      });

      const snapshot = await client.fetchSnapshot({ from: '2026-10-01', to: '2026-10-15', fresh: true });
      assert.ok(snapshot.daily.present);
      assert.equal(interceptedHeaders?.authorization, 'Bearer gh_secret_bearer_token_123');
    });

    test('throws AUTH_FAILED when bearer token is missing', async () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const client = new PlatformApiClient({
        platform: { id: 1, code: 'GHSUPERWINNINGS', business_timezone: 'Africa/Accra' },
        config,
        secrets: {},
        policy: { allowedHosts: ['ghsuperwinnings.com'], allowPrivateHosts: false, allowHttpHosts: false }
      });

      await assert.rejects(
        async () => client.fetchSnapshot({ from: '2026-10-01', to: '2026-10-15', fresh: true }),
        { name: 'IntegrationError', code: 'AUTH_FAILED' }
      );
    });

    test('SSRF policy verifies ghsuperwinnings.com is an approved destination', () => {
      const policy = { allowedHosts: ['ghsuperwinnings.com'], allowPrivateHosts: false, allowHttpHosts: false };
      assert.doesNotThrow(() => checkUrlPolicy('https://ghsuperwinnings.com/api/admin/dashboard', policy));
      assert.throws(() => checkUrlPolicy('https://malicious.evil.com/api', policy));
      assert.throws(() => checkUrlPolicy('http://ghsuperwinnings.com/api', policy));
      assert.throws(() => checkUrlPolicy('https://169.254.169.254/latest/meta-data', policy));
    });
  });

  describe('4. Response Handling & Dynamic Field Mapping', () => {
    test('correctly normalizes valid dashboard response with daily, summary, and data records', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const apiResponse = {
        success: true,
        summary: {
          totalSubscribers: 154,
          newSubscriptions: 154,
          renewals: 420
        },
        daily: [
          { date: '2026-10-01', newSubscriptions: 45 },
          { date: '2026-10-02', newSubscriptions: 52 },
          { date: '2026-10-03', newSubscriptions: 57 }
        ],
        data: [
          { msisdn: '233201112233', createdAt: '2026-10-01T08:30:00Z', offerCode: '9923310010', status: 'success', reason: null },
          { msisdn: '233502223344', createdAt: '2026-10-02T09:15:00Z', offerCode: '9923310009', status: 'success', reason: null }
        ],
        total: 2,
        page: 1,
        limit: 50
      };

      const normalized = normalizeResponse(apiResponse, config, { timezone: 'Africa/Accra' });

      // Daily checks
      assert.equal(normalized.daily.present, true);
      assert.equal(normalized.daily.rows.length, 3);
      assert.equal(normalized.daily.rows[0].report_date, '2026-10-01');
      assert.equal(normalized.daily.rows[0].new_subscribers, 45);

      // Summary checks
      assert.equal(normalized.summary.present, true);
      assert.equal(normalized.summary.values.new_subscribers, 154);
      assert.equal(normalized.summary.values.renewal_count, 420);

      // Records checks
      assert.equal(normalized.records.present, true);
      assert.equal(normalized.records.rows.length, 2);
      assert.equal(normalized.records.rows[0].msisdn, '233201112233');
      assert.equal(normalized.records.rows[0].offer_code, '9923310010');
      assert.equal(normalized.records.rows[0].status, 'success');

      // Pagination checks
      assert.equal(normalized.pagination.total, 2);
    });

    test('handles API reported failure cleanly without fabricating numbers', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const apiResponse = {
        success: false,
        message: 'Invalid date range specified'
      };

      assert.throws(
        () => normalizeResponse(apiResponse, config),
        { name: 'IntegrationError', code: 'API_REPORTED_FAILURE' }
      );
    });

    test('handles empty results and preserves zero vs unmapped distinctions', () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const apiResponse = {
        success: true,
        summary: { totalSubscribers: 0, newSubscriptions: 0, renewals: 0 },
        daily: [],
        data: [],
        total: 0
      };

      const normalized = normalizeResponse(apiResponse, config, { timezone: 'Africa/Accra' });
      assert.equal(normalized.daily.rows.length, 0);
      assert.equal(normalized.records.rows.length, 0);
      assert.equal(normalized.summary.values.new_subscribers, 0);
      assert.equal(normalized.summary.values.renewal_count, 0);
      assert.equal(normalized.pagination.total, 0);
    });
  });

  describe('5. Pagination & CSV Export', () => {
    test('fetches paginated records and generates CSV export over /admin/dashboard', async () => {
      const config = validateIntegrationConfig(preset.integration).config;
      const page1Records = [
        { msisdn: '233200000001', createdAt: '2026-10-01T10:00:00Z', offerCode: '9923310010', status: 'success', reason: '-' },
        { msisdn: '233200000002', createdAt: '2026-10-01T11:00:00Z', offerCode: '9923310010', status: 'success', reason: '-' }
      ];
      const page2Records = [
        { msisdn: '233200000003', createdAt: '2026-10-02T10:00:00Z', offerCode: '9923310009', status: 'success', reason: '-' }
      ];

      const calls = [];
      const mockTransport = async (req) => {
        calls.push(req.url.toString());
        const u = new URL(req.url.toString());
        const page = u.searchParams.get('page');
        if (page === '1') {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({
              success: true,
              data: page1Records,
              total: 3,
              page: 1,
              limit: 2
            }))
          };
        }
        if (page === '2') {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({
              success: true,
              data: page2Records,
              total: 3,
              page: 2,
              limit: 2
            }))
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ success: true, data: [], total: 3 }))
        };
      };

      setConnectorTransport(mockTransport);

      const client = new PlatformApiClient({
        platform: { id: 1, code: 'GHSUPERWINNINGS', business_timezone: 'Africa/Accra' },
        config: { ...config, pagination: { ...config.pagination, page_size: 2 } },
        secrets: { token: 'test_token' },
        policy: { allowedHosts: ['ghsuperwinnings.com'], allowPrivateHosts: false, allowHttpHosts: false }
      });

      const { rows, pages, complete } = await client.collectRecords({
        reportType: 'subscribers',
        from: '2026-10-01',
        to: '2026-10-15'
      });

      assert.equal(rows.length, 3);
      assert.equal(pages, 2);
      assert.equal(complete, true);
      assert.ok(calls[0].includes('page=1'));
      assert.ok(calls[1].includes('page=2'));

      // Generate CSV
      const header = ['MSISDN', 'Offer Code', 'Status'];
      const csvRows = rows.map(r => [csvCell(r.msisdn), csvCell(r.offer_code), csvCell(r.status)]);
      const csv = toCsv(header, csvRows);

      assert.ok(csv.includes('MSISDN,Offer Code,Status'));
      assert.ok(csv.includes('233200000001,9923310010,success'));
      assert.ok(csv.includes('233200000002,9923310010,success'));
      assert.ok(csv.includes('233200000003,9923310009,success'));
    });
  });

  describe('6. Verified Remote Upstream Behavior', () => {
    test('confirms live upstream accepts Bearer auth header and dedicated /admin/export returns 404', async (t) => {
      const policy = { allowedHosts: ['ghsuperwinnings.com'], allowPrivateHosts: false, allowHttpHosts: false };

      try {
        // Test without token
        const resNoToken = await safeRequest({
          method: 'GET',
          url: 'https://ghsuperwinnings.com/api/admin/dashboard',
          timeoutMs: 15000
        }, { policy });

        if (resNoToken.status === 502 || resNoToken.status === 503 || resNoToken.status === 504) {
          t.skip(`Remote upstream returned HTTP ${resNoToken.status} (external server gateway issue)`);
          return;
        }

        assert.equal(resNoToken.status, 401);
        const jsonNoToken = JSON.parse(resNoToken.body.toString('utf8'));
        assert.equal(jsonNoToken.success, false);
        assert.equal(jsonNoToken.message, 'No token provided');

        // Test with Bearer token
        const resWithToken = await safeRequest({
          method: 'GET',
          url: 'https://ghsuperwinnings.com/api/admin/dashboard',
          headers: { authorization: 'Bearer test_token' },
          timeoutMs: 15000
        }, { policy });
        assert.equal(resWithToken.status, 401);
        const jsonWithToken = JSON.parse(resWithToken.body.toString('utf8'));
        assert.equal(jsonWithToken.success, false);
        assert.equal(jsonWithToken.message, 'Invalid or expired token');

        // Test dedicated /admin/export endpoint
        const resExport = await safeRequest({
          method: 'GET',
          url: 'https://ghsuperwinnings.com/api/admin/export',
          timeoutMs: 15000
        }, { policy });
        assert.equal(resExport.status, 404);
        const jsonExport = JSON.parse(resExport.body.toString('utf8'));
        assert.equal(jsonExport.success, false);
        assert.equal(jsonExport.message, 'Not found');
      } catch (err) {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
          t.skip(`Remote upstream unreachable: ${err.message}`);
          return;
        }
        throw err;
      }
    });
  });
});
