import { platformRepository, normalizeStatus } from '../repositories/platformRepository.js';
import { determineAccessStatus } from '../utils/platformAccessHelper.js';

const DENIAL_MESSAGES = {
  REVOKED: { code: 'PLATFORM_ACCESS_REVOKED', message: 'Your access to this platform has been revoked.' },
  UPCOMING: { code: 'PLATFORM_ACCESS_UPCOMING', message: 'Your access to this platform has not started yet.' },
  EXPIRED: { code: 'PLATFORM_ACCESS_EXPIRED', message: 'Your access to this platform has expired.' }
};

/**
 * Resolves the active platform for the request from the x-platform-code / x-platform-id
 * header and re-validates the caller's date-windowed access on EVERY request, so a
 * client-side platform switch can never bypass authorisation.
 *
 * Options:
 *  - allowAll: permit the consolidated "ALL" scope (Super Admin only).
 */
export function requirePlatform({ allowAll = true } = {}) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Authentication required.' });
      }
      const requested = String(req.headers['x-platform-code'] || req.headers['x-platform-id'] || '').trim();

      if (!requested) {
        return res.status(400).json({ success: false, code: 'PLATFORM_REQUIRED', message: 'Select a platform to continue.' });
      }

      if (requested.toUpperCase() === 'ALL') {
        if (!req.user.isSuperAdmin) {
          return res.status(403).json({ success: false, code: 'SUPER_ADMIN_REQUIRED', message: 'The consolidated view is restricted to Super Admins.' });
        }
        if (!allowAll) {
          return res.status(400).json({ success: false, code: 'SPECIFIC_PLATFORM_REQUIRED', message: 'This report requires a specific platform.' });
        }
        const country = String(req.headers['x-country'] || req.query.country || '').trim();
        req.activePlatform = { id: 'ALL', code: 'ALL', name: 'All Platforms', isAll: true, country: country && country !== 'All Countries' ? country : null };
        req.platformRole = 'Super Admin';
        return next();
      }

      const platform = await platformRepository.findByIdOrCode(requested);
      if (!platform || normalizeStatus(platform.status) !== 'ACTIVE') {
        return res.status(404).json({ success: false, code: 'PLATFORM_NOT_FOUND', message: 'Platform not found or not active.' });
      }

      if (req.user.isSuperAdmin) {
        req.activePlatform = platform;
        req.platformRole = 'Super Admin';
        return next();
      }

      const assignment = req.user.access.find(a => a.platform_id === platform.id);
      if (!assignment) {
        return res.status(403).json({ success: false, code: 'PLATFORM_ACCESS_DENIED', message: 'You are not authorised for this platform.' });
      }
      const evaluation = determineAccessStatus({ status: assignment.configured_status, start_date: assignment.start_date, end_date: assignment.end_date });
      if (!evaluation.isCurrentlyActive) {
        const denial = DENIAL_MESSAGES[evaluation.status] || { code: 'PLATFORM_ACCESS_DENIED', message: evaluation.reason };
        return res.status(403).json({ success: false, ...denial });
      }

      req.activePlatform = platform;
      req.platformRole = assignment.role_name;
      req.platformAccess = assignment;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
