import { PlatformApiClient, getOutboundPolicy } from '../integrations/connector.js';
import { IntegrationError } from '../integrations/errors.js';
import { decryptAll } from '../integrations/secretVault.js';
import { configHash } from '../integrations/configSchema.js';
import { platformRepository } from '../repositories/platformRepository.js';
import { integrationLogRepository } from '../repositories/integrationLogRepository.js';

const lastSuccessWrite = new Map();
const SUCCESS_WRITE_INTERVAL_MS = 60_000;

function healthRecorder(platform, userId) {
  return (event) => {
    if (!['FETCH', 'EXPORT', 'LOGIN'].includes(event.kind)) return;
    const now = Date.now();
    if (event.ok) {
      // Throttle success writes: one per platform per minute is enough for "last successful fetch".
      if (now - (lastSuccessWrite.get(platform.id) || 0) < SUCCESS_WRITE_INTERVAL_MS) return;
      lastSuccessWrite.set(platform.id, now);
      platformRepository.recordHealth(platform.id, {
        last_success_at: new Date(),
        last_status_code: event.httpStatus ?? null,
        last_duration_ms: event.durationMs ?? null
      }).catch(err => console.error('[Integration] health write failed:', err.message));
      return;
    }
    platformRepository.recordHealth(platform.id, {
      last_error_at: new Date(),
      last_error_code: event.errorCode || (event.httpStatus ? `HTTP_${event.httpStatus}` : 'UNKNOWN'),
      last_error_message: event.message || null,
      last_status_code: event.httpStatus ?? null
    }).catch(err => console.error('[Integration] health write failed:', err.message));
    integrationLogRepository.insert({
      platformId: platform.id,
      platformCode: platform.code,
      kind: event.kind,
      ok: false,
      httpStatus: event.httpStatus,
      errorCode: event.errorCode || (event.httpStatus ? `HTTP_${event.httpStatus}` : null),
      message: event.message,
      host: event.host,
      path: event.path,
      durationMs: event.durationMs,
      userId
    }).catch(err => console.error('[Integration] log write failed:', err.message));
  };
}

export function hasSecrets(platform) {
  return Object.keys(platform.integration_secrets || {}).some(k => k !== 'updated_at');
}

/**
 * Build an API client for a platform.
 *  mode 'published' – the activated configuration used for reporting (default)
 *  mode 'draft'     – the editable configuration, optionally overridden in-memory by the wizard
 */
export async function createPlatformClient(platform, { mode = 'published', draftOverride = null, userId = null } = {}) {
  const config = mode === 'draft' ? (draftOverride || platform.integration) : (platform.published_integration || platform.integration);
  if (!config || !config.base_url) throw new IntegrationError('INTEGRATION_NOT_CONFIGURED');
  const secrets = hasSecrets(platform) ? decryptAll(platform.integration_secrets) : {};
  const policy = await getOutboundPolicy();
  const cacheScope = mode === 'published'
    ? `${platform.id}:${platform.published_config_hash}:${platform.integration_secrets?.updated_at ? new Date(platform.integration_secrets.updated_at).getTime() : 0}`
    : null;
  return new PlatformApiClient({
    platform,
    config,
    secrets,
    policy,
    cacheScope,
    onEvent: mode === 'published' ? healthRecorder(platform, userId) : null
  });
}

export function draftHash(platform) {
  return configHash(platform.integration || null, platform.integration_secrets?.updated_at || null, platform.business_timezone || null);
}
