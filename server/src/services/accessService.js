import { accessRepository, roleRepository } from '../repositories/accessRepository.js';
import { platformRepository, normalizeModules, normalizeStatus } from '../repositories/platformRepository.js';
import { determineAccessStatus } from '../utils/platformAccessHelper.js';
import { describeCapabilities } from '../integrations/capabilities.js';

export const EXPORT_ROLES = ['Super Admin', 'Platform Admin', 'Analyst'];

export function isSuperAdminUser(user, evaluatedAccess = []) {
  // id 1 is the original root operator account; kept for backwards compatibility.
  return Boolean(
    user?.is_super_admin ||
    user?.id === 1 ||
    evaluatedAccess.some(a => a.role_name === 'Super Admin' && a.isCurrentlyActive)
  );
}

/**
 * Public description of a platform for selectors and report pages. Contains no
 * integration configuration beyond the capability summary of the PUBLISHED config.
 */
export function toSelectorEntry(platform, role = null) {
  const published = platform.published_integration || platform.integration || null;
  return {
    id: platform.id,
    code: platform.code,
    name: platform.name,
    country: platform.country || null,
    logo_url: platform.logo_url || '',
    accent_color: platform.accent_color || '#2A58FF',
    business_timezone: platform.business_timezone || 'UTC',
    currency: platform.currency || null,
    enabled_modules: normalizeModules(platform.enabled_modules),
    role,
    integration_ready: Boolean(published),
    capabilities: published ? describeCapabilities(published) : null
  };
}

/**
 * Evaluate every platform assignment for a user against the current time.
 */
export async function evaluateUserAccess(user, now = new Date()) {
  const [rows, roles, platforms] = await Promise.all([
    accessRepository.listForUser(user.id),
    roleRepository.list(),
    platformRepository.listAll()
  ]);
  const roleMap = new Map(roles.map(r => [r.id, r.name]));
  const platformMap = new Map(platforms.map(p => [p.id, p]));

  const evaluated = rows
    .map(row => {
      const platform = platformMap.get(row.platform_id);
      if (!platform) return null;
      const result = determineAccessStatus(row, now);
      return {
        platform_id: row.platform_id,
        platform,
        role_id: row.role_id,
        role_name: roleMap.get(row.role_id) || 'Viewer',
        start_date: row.start_date,
        end_date: row.end_date,
        configured_status: row.status,
        status: result.status,
        isCurrentlyActive: result.isCurrentlyActive && normalizeStatus(platform.status) === 'ACTIVE',
        platformActive: normalizeStatus(platform.status) === 'ACTIVE',
        isExpiringSoon: result.isExpiringSoon || false,
        daysUntilExpiry: result.daysUntilExpiry ?? null,
        reason: result.reason
      };
    })
    .filter(Boolean);

  const isSuperAdmin = isSuperAdminUser(user, evaluated);
  let available;
  if (isSuperAdmin) {
    available = platforms.filter(p => normalizeStatus(p.status) === 'ACTIVE').map(p => toSelectorEntry(p, 'Super Admin'));
  } else {
    available = evaluated
      .filter(a => a.isCurrentlyActive)
      .map(a => ({
        ...toSelectorEntry(a.platform, a.role_name),
        access: { start_date: a.start_date, end_date: a.end_date, isExpiringSoon: a.isExpiringSoon, daysUntilExpiry: a.daysUntilExpiry }
      }));
  }

  return { evaluated, isSuperAdmin, available };
}
