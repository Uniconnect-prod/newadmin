import { platformRepository, toAdminView, normalizeModules, normalizeStatus, REPORTING_MODULES } from '../repositories/platformRepository.js';
import { integrationLogRepository } from '../repositories/integrationLogRepository.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { mappingRepository } from '../repositories/mappingRepository.js';
import { executeHealthCheck, evaluateMetricMappings } from '../integrations/metricAutoDetector.js';
import { validateIntegrationConfig, AUTH_TYPES, PAGINATION_STRATEGIES, DATE_PARAM_FORMATS } from '../integrations/configSchema.js';
import { mergeSecrets, isVaultConfigured, SECRET_FIELDS } from '../integrations/secretVault.js';
import { inspectRequest } from '../integrations/inspector.js';
import { validateIntegration } from '../integrations/validator.js';
import { describeCapabilities } from '../integrations/capabilities.js';
import { DAILY_FIELDS, SUMMARY_FIELDS, RECORD_FIELDS, REPORT_TYPES, REQUEST_PARAMS } from '../integrations/canonicalFields.js';
import { DATE_FORMATS } from '../integrations/transforms.js';
import { listAdapters } from '../integrations/adapters/index.js';
import { listPresets } from '../integrations/presets.js';
import { normalizeAllowlistEntry, isBlockedHostname, isPrivateAddress } from '../integrations/ssrfGuard.js';
import { IntegrationError } from '../integrations/errors.js';
import { clearResponseCache } from '../integrations/connector.js';
import { clearTokenCache } from '../integrations/authStrategies.js';
import { createPlatformClient, draftHash } from '../services/integrationService.js';
import { resolveRange } from '../reporting/dateRange.js';
import { addDays } from '../integrations/requestBuilder.js';
import { dayKeyInTimezone } from '../integrations/transforms.js';
import { logAudit } from '../middleware/auditLogger.js';
import { config } from '../config/index.js';
import { badRequest, notFound, conflict, AppError } from '../utils/errors.js';

const CODE_RE = /^[A-Z0-9_]{2,40}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

async function autoApproveHost(rawUrl, userId) {
  try {
    if (!rawUrl) return;
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host && !isBlockedHostname(host)) {
      const existing = await settingsRepository.getOutboundAllowlist().catch(() => []);
      if (!existing.includes(host)) {
        await settingsRepository.setOutboundAllowlist([...existing, host], userId).catch(() => {});
      }
    }
  } catch {}
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateDetails(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 80) throw badRequest('Platform display name is required (2–80 characters).');
    out.name = body.name.trim();
  }
  if (!partial) {
    const code = String(body.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) throw badRequest('Platform code must be 2–40 characters: A–Z, 0–9 or underscore.');
    out.code = code;
  }
  if (body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 500);
  if (body.logo_url !== undefined) {
    const url = String(body.logo_url || '').trim();
    if (url && !/^(https:\/\/|\/)[^\s"'<>]{1,400}$/.test(url)) throw badRequest('Logo URL must be an https:// URL or a site-relative path.');
    out.logo_url = url;
  }
  if (body.accent_color !== undefined) {
    if (body.accent_color && !COLOR_RE.test(body.accent_color)) throw badRequest('Brand accent must be a hex colour such as #0170B9.');
    out.accent_color = body.accent_color || '#0170B9';
  }
  if (body.country !== undefined) out.country = body.country ? String(body.country).trim().slice(0, 80) : null;
  if (body.country_id !== undefined) out.country_id = body.country_id ? Number(body.country_id) : null;
  if (!partial || body.business_timezone !== undefined) {
    const tz = String(body.business_timezone || '').trim();
    if (!isValidTimezone(tz)) throw badRequest('Default timezone must be a valid IANA timezone (e.g. Africa/Accra).');
    out.business_timezone = tz;
  }
  if (body.currency !== undefined) {
    if (body.currency && !/^[A-Za-z]{3}$/.test(body.currency)) throw badRequest('Currency must be a 3-letter ISO code.');
    out.currency = body.currency ? body.currency.toUpperCase() : null;
  }
  if (body.enabled_modules !== undefined) {
    if (!Array.isArray(body.enabled_modules)) throw badRequest('enabled_modules must be an array.');
    const unknown = body.enabled_modules.filter(m => !REPORTING_MODULES.includes(m));
    if (unknown.length) throw badRequest(`Unknown reporting module(s): ${unknown.join(', ')}.`);
    out.enabled_modules = normalizeModules(body.enabled_modules);
  }
  return out;
}

async function loadPlatform(id) {
  const platform = await platformRepository.findByIdOrCode(id);
  if (!platform) throw notFound('Platform not found.');
  return platform;
}

function adminView(platform) {
  const view = toAdminView(platform);
  const hash = platform.integration ? draftHash(platform) : null;
  view.draft_config_hash = hash;
  view.validation_current = Boolean(hash && platform.validation?.status === 'PASSED' && platform.validation?.config_hash === hash);
  view.has_unpublished_changes = Boolean(hash && platform.published_config_hash !== hash);
  view.capabilities = platform.integration ? describeCapabilities(platform.integration) : null;
  view.published_capabilities = platform.published_integration ? describeCapabilities(platform.published_integration) : null;
  return view;
}

function sampleRange(platform, body) {
  const tz = platform.business_timezone || 'UTC';
  if (body?.from && body?.to) return resolveRange({ range: 'custom', from: body.from, to: body.to }, tz);
  const today = dayKeyInTimezone(new Date(), tz);
  return resolveRange({ range: 'custom', from: addDays(today, -6), to: today }, tz);
}

export const platformManagementController = {
  async meta(req, res) {
    const managed = await settingsRepository.getOutboundAllowlist();
    res.json({
      success: true,
      data: {
        modules: REPORTING_MODULES,
        fields: { daily: DAILY_FIELDS, summary: SUMMARY_FIELDS, records: RECORD_FIELDS },
        reportTypes: REPORT_TYPES,
        requestParams: REQUEST_PARAMS,
        authTypes: AUTH_TYPES,
        paginationStrategies: PAGINATION_STRATEGIES,
        dateParamFormats: DATE_PARAM_FORMATS,
        dateFormats: DATE_FORMATS,
        adapters: listAdapters(),
        presets: listPresets(),
        vaultConfigured: isVaultConfigured(),
        outbound: { envHosts: config.outbound.allowedHosts, managedHosts: managed, privateExceptions: config.outbound.allowPrivateHosts, httpHosts: config.outbound.allowHttpHosts }
      }
    });
  },

  async list(req, res) {
    const { search, status, country } = req.query;
    let platforms = (await platformRepository.listAll()).map(adminView);
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      platforms = platforms.filter(p => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
    }
    if (status && status !== 'ALL') platforms = platforms.filter(p => p.status === String(status).toUpperCase());
    if (country && country !== 'ALL') platforms = platforms.filter(p => (p.country || '').toLowerCase() === String(country).toLowerCase());
    res.json({ success: true, data: platforms });
  },

  async getById(req, res) {
    res.json({ success: true, data: adminView(await loadPlatform(req.params.id)) });
  },

  async create(req, res) {
    const details = validateDetails(req.body || {}, { partial: false });
    let integration = null;
    if (req.body.integration) {
      integration = validateIntegrationConfig(req.body.integration).config;
    }
    let created;
    try {
      created = await platformRepository.create({ ...details, integration }, req.user.id);
      if (created?.id && integration) {
        await mappingRepository.savePlatformMappings(created.id, {
          fieldMappings: integration.field_mappings || integration.mappings?.summary || {},
          requestParams: integration.params || {},
          responsePaths: integration.endpoints || {}
        });
      }
      if (created?.id && req.body.secrets && typeof req.body.secrets === 'object') {
        const submittedSecrets = Object.fromEntries(
          SECRET_FIELDS.filter(f => typeof req.body.secrets[f] === 'string' && req.body.secrets[f].length > 0)
            .map(f => [f, req.body.secrets[f]])
        );
        if (Object.keys(submittedSecrets).length && isVaultConfigured()) {
          const merged = mergeSecrets({}, submittedSecrets, []);
          await platformRepository.saveSecrets(created.id, merged);
        }
      }
    } catch (err) {
      if (err.code === 'DUPLICATE_CODE' || err.code === 11000) throw conflict(err.message || 'A platform with this code already exists.');
      throw err;
    }
    await logAudit(req, 'CREATE_PLATFORM', 'Platform', created.id, { code: created.code, name: created.name }, { platformId: created.id });
    const fresh = await platformRepository.findById(created.id);
    res.status(201).json({ success: true, message: 'Platform created successfully.', data: adminView(fresh || created) });
  },

  async update(req, res) {
    const platform = await loadPlatform(req.params.id);
    const details = validateDetails(req.body || {}, { partial: true });
    const updated = await platformRepository.updateDetails(platform.id, details);
    await logAudit(req, 'UPDATE_PLATFORM', 'Platform', platform.id, { fields: Object.keys(details) }, { platformId: platform.id });
    res.json({ success: true, message: 'Platform details saved.', data: adminView(updated) });
  },

  /**
   * Save the draft API configuration and (optionally) credentials.
   * Credentials are encrypted server-side and never returned.
   */
  async saveIntegration(req, res) {
    const platform = await loadPlatform(req.params.id);
    const { integration, secrets = {}, clear_secrets: clearSecrets = [] } = req.body || {};
    if (!integration || typeof integration !== 'object') throw badRequest('integration configuration is required.');
    const { config: cfg, errors } = validateIntegrationConfig(integration);
    if (errors.length) throw new AppError(422, 'INVALID_CONFIGURATION', 'The API configuration has errors.', { errors });

    const submittedSecrets = Object.fromEntries(SECRET_FIELDS.filter(f => typeof secrets[f] === 'string' && secrets[f].length > 0).map(f => [f, secrets[f]]));
    const clear = Array.isArray(clearSecrets) ? clearSecrets.filter(f => SECRET_FIELDS.includes(f)) : [];
    if (Object.keys(submittedSecrets).length && !isVaultConfigured()) throw new IntegrationError('SECRET_KEY_MISSING');

    await platformRepository.saveIntegrationDraft(platform.id, cfg);
    await autoApproveHost(cfg.base_url, req.user?.id);
    await mappingRepository.savePlatformMappings(platform.id, {
      fieldMappings: cfg.field_mappings || cfg.mappings?.summary || {},
      requestParams: cfg.params || {},
      responsePaths: cfg.endpoints || {}
    });

    if (Object.keys(submittedSecrets).length || clear.length) {
      const merged = mergeSecrets(platform.integration_secrets || {}, submittedSecrets, clear);
      await platformRepository.saveSecrets(platform.id, merged);
      clearTokenCache();
      clearResponseCache();
    }
    const saved = await platformRepository.findById(platform.id);
    await logAudit(req, 'UPDATE_INTEGRATION', 'Platform', platform.id, {
      base_url: cfg.base_url,
      auth_type: cfg.auth.type,
      endpoint: cfg.endpoints.report.path,
      mapped: { daily: Object.keys(cfg.mappings.daily), summary: Object.keys(cfg.mappings.summary), records: Object.keys(cfg.mappings.records) },
      credentials_changed: Object.keys(submittedSecrets),
      credentials_cleared: clear
    }, { platformId: platform.id });
    res.json({ success: true, message: 'API configuration saved as draft.', data: adminView(saved) });
  },

  async testHealth(req, res) {
    let baseUrl = req.body?.baseUrl || req.body?.integration?.base_url;
    let healthPath = req.body?.healthPath || req.body?.integration?.endpoints?.health || '/api/health';
    const headers = {};

    let platform = null;
    if (req.params?.id) {
      platform = await loadPlatform(req.params.id);
      if (!baseUrl && platform.integration?.base_url) {
        baseUrl = platform.integration.base_url;
      }
      if (!req.body?.healthPath && platform.integration?.endpoints?.health) {
        healthPath = platform.integration.endpoints.health;
      }
    }

    if (!baseUrl) throw badRequest('Base URL is required to run a health check.');
    await autoApproveHost(baseUrl, req.user?.id);

    if (req.body?.token) {
      headers['Authorization'] = `Bearer ${req.body.token}`;
    } else if (req.body?.apiKey) {
      headers[req.body.apiKeyHeader || 'X-API-Key'] = req.body.apiKey;
    }

    const result = await executeHealthCheck({
      baseUrl,
      healthPath,
      timeoutMs: 10000,
      headers
    });

    if (platform?.id) {
      try {
        const u = new URL(result.url);
        await integrationLogRepository.insert({
          platformId: platform.id,
          platformCode: platform.code,
          kind: 'HEALTH',
          ok: result.ok,
          httpStatus: result.status ?? null,
          errorCode: result.error?.code || null,
          message: result.message,
          host: u.host,
          path: u.pathname,
          durationMs: result.durationMs ?? null,
          userId: req.user.id
        });
      } catch {
        /* ignore url parsing/log errors */
      }
    }

    res.json({ success: true, data: result });
  },

  async previewMetrics(req, res) {
    const { responseJson, mappings = {} } = req.body || {};
    if (!responseJson || typeof responseJson !== 'object') {
      throw badRequest('Valid responseJson object is required to evaluate metrics.');
    }
    const metrics = evaluateMetricMappings(responseJson, mappings);
    res.json({ success: true, data: metrics });
  },

  async inspect(req, res) {
    let platform = null;
    let override = null;

    if (req.params?.id) {
      platform = await loadPlatform(req.params.id);
      if (req.body?.integration) {
        const { config: cfg, errors } = validateIntegrationConfig(req.body.integration);
        if (errors.length) throw new AppError(422, 'INVALID_CONFIGURATION', 'Fix configuration errors before testing.', { errors });
        override = cfg;
      } else if (!platform.integration) {
        throw new IntegrationError('INTEGRATION_NOT_CONFIGURED');
      }
    } else {
      if (!req.body?.integration) throw badRequest('integration configuration is required for inspection.');
      const { config: cfg, errors } = validateIntegrationConfig(req.body.integration);
      if (errors.length) throw new AppError(422, 'INVALID_CONFIGURATION', 'Fix configuration errors before testing.', { errors });
      override = cfg;
      let secrets = {};
      if (req.body.secrets && isVaultConfigured()) {
        const submitted = Object.fromEntries(
          SECRET_FIELDS.filter(f => typeof req.body.secrets[f] === 'string' && req.body.secrets[f].length > 0)
            .map(f => [f, req.body.secrets[f]])
        );
        if (Object.keys(submitted).length) {
          secrets = mergeSecrets({}, submitted, []);
        }
      }
      platform = {
        id: 0,
        code: req.body?.code || 'DRAFT',
        name: req.body?.name || 'Draft Platform',
        business_timezone: req.body?.business_timezone || 'UTC',
        integration: override,
        integration_secrets: secrets
      };
    }

    const range = sampleRange(platform, req.body);
    if (!config.isTest) {
      if (override?.base_url) await autoApproveHost(override.base_url, req.user.id);
      else if (platform?.integration?.base_url) await autoApproveHost(platform.integration.base_url, req.user.id);
    }
    const client = await createPlatformClient(platform, { mode: 'draft', draftOverride: override, userId: req.user.id });
    const reportType = ['overview', 'subscribers', 'renewals', 'churn'].includes(req.body?.reportType) ? req.body.reportType : 'overview';
    const result = await inspectRequest(client, { reportType, from: range.from, to: range.to, page: req.body?.page });
    result.sampleRange = { from: range.from, to: range.to, timezone: range.timezone };

    if (platform.id) {
      await integrationLogRepository.insert({
        platformId: platform.id,
        platformCode: platform.code,
        kind: 'TEST',
        ok: result.ok,
        httpStatus: result.status ?? null,
        errorCode: result.error?.code || null,
        message: result.error?.message || null,
        host: result.request?.host,
        path: result.request?.path,
        durationMs: result.durationMs ?? null,
        bytes: result.bytes ?? null,
        summary: { reportType, from: range.from, to: range.to },
        userId: req.user.id
      }).catch(() => {});
      await logAudit(req, 'TEST_PLATFORM_API', 'Platform', platform.id, { ok: result.ok, status: result.status ?? null, reportType }, { platformId: platform.id });
    }

    res.json({ success: true, data: result });
  },

  async validate(req, res) {
    const platform = await loadPlatform(req.params.id);
    if (!platform.integration) throw new IntegrationError('INTEGRATION_NOT_CONFIGURED');
    const { config: cfg, errors } = validateIntegrationConfig(platform.integration);
    const range = sampleRange(platform, req.body);
    const client = await createPlatformClient(platform, { mode: 'draft', draftOverride: cfg, userId: req.user.id });
    const result = await validateIntegration({ client, platform, from: range.from, to: range.to, configErrors: errors });
    const hash = draftHash(platform);
    const validation = { ...result, config_hash: hash, ran_by: req.user.id };
    await platformRepository.saveValidation(platform.id, validation);

    await integrationLogRepository.insert({
      platformId: platform.id,
      platformCode: platform.code,
      kind: 'VALIDATION',
      ok: result.status === 'PASSED',
      message: `${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.warnings} warning(s)`,
      summary: { ...result.summary, from: range.from, to: range.to },
      userId: req.user.id
    });
    await logAudit(req, 'VALIDATE_PLATFORM', 'Platform', platform.id, { status: result.status, ...result.summary }, { platformId: platform.id });
    res.json({ success: true, data: { ...validation, platform: adminView(await platformRepository.findById(platform.id)) } });
  },

  async activate(req, res) {
    const platform = await loadPlatform(req.params.id);
    if (!platform.integration) throw new AppError(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure the platform API before activating.');
    const hash = draftHash(platform);
    if (platform.validation?.status !== 'PASSED' || platform.validation?.config_hash !== hash) {
      throw new AppError(409, 'VALIDATION_REQUIRED', 'Run validation on the current configuration and resolve all failed checks before activating.');
    }
    const published = await platformRepository.publish(platform.id, { integration: platform.integration, configHash: hash, userId: req.user.id });
    clearResponseCache();
    await integrationLogRepository.insert({ platformId: platform.id, platformCode: platform.code, kind: 'ACTIVATION', ok: true, message: 'Configuration published and platform activated.', userId: req.user.id });
    await logAudit(req, 'ACTIVATE_PLATFORM', 'Platform', platform.id, { config_hash: hash.slice(0, 12) }, { platformId: platform.id });
    res.json({ success: true, message: `${platform.name} is active and available to authorised users.`, data: adminView(published) });
  },

  async disable(req, res) {
    const platform = await loadPlatform(req.params.id);
    if (normalizeStatus(platform.status) === 'DISABLED') return res.json({ success: true, message: 'Platform is already disabled.', data: adminView(platform) });
    const updated = await platformRepository.setStatus(platform.id, 'DISABLED');
    clearResponseCache();
    await logAudit(req, 'DISABLE_PLATFORM', 'Platform', platform.id, {}, { platformId: platform.id });
    res.json({ success: true, message: `${platform.name} has been disabled. Its configuration and history are kept.`, data: adminView(updated) });
  },

  async delete(req, res) {
    const platform = await loadPlatform(req.params.id);
    await platformRepository.delete(platform.id);
    clearResponseCache();
    await logAudit(req, 'DELETE_PLATFORM', 'Platform', platform.id, { name: platform.name, code: platform.code }, { platformId: platform.id });
    res.json({ success: true, message: `Platform '${platform.name}' (${platform.code}) has been deleted.` });
  },

  async history(req, res) {
    const platformId = req.params.id ? (await loadPlatform(req.params.id)).id : (req.query.platformId ? parseInt(req.query.platformId, 10) : null);
    const ok = req.query.ok === 'true' ? true : req.query.ok === 'false' ? false : null;
    const result = await integrationLogRepository.list({ platformId, kind: req.query.kind || null, ok, page: req.query.page, limit: req.query.limit });
    res.json({ success: true, data: result });
  },

  async getAllowlist(req, res) {
    res.json({ success: true, data: { envHosts: config.outbound.allowedHosts, managedHosts: await settingsRepository.getOutboundAllowlist() } });
  },

  async setAllowlist(req, res) {
    const hosts = req.body?.hosts;
    if (!Array.isArray(hosts) || hosts.length > 100) throw badRequest('hosts must be an array of up to 100 entries.');
    const normalized = [];
    for (const h of hosts) {
      const value = normalizeAllowlistEntry(h);
      if (!value) throw badRequest(`'${h}' is not a valid host entry. Use api.example.com, *.example.com or host:port.`);
      if (!normalized.includes(value)) normalized.push(value);
    }
    const before = await settingsRepository.getOutboundAllowlist();
    await settingsRepository.setOutboundAllowlist(normalized, req.user.id);
    await logAudit(req, 'UPDATE_OUTBOUND_ALLOWLIST', 'Settings', 'outbound_allowlist', {
      added: normalized.filter(h => !before.includes(h)),
      removed: before.filter(h => !normalized.includes(h))
    }, { platformId: null });
    res.json({ success: true, message: 'Approved hosts updated.', data: { envHosts: config.outbound.allowedHosts, managedHosts: normalized } });
  }
};
