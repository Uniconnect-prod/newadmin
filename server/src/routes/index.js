import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import { requirePlatform } from '../middleware/platformGuard.js';
import { requireRole, requireSuperAdmin, requireAnyPlatformRole } from '../middleware/roleGuard.js';
import { asyncHandler as h } from '../utils/errors.js';
import { authController } from '../controllers/authController.js';
import { platformController } from '../controllers/platformController.js';
import { platformManagementController as pm } from '../controllers/platformManagementController.js';
import { reportController } from '../controllers/reportController.js';
import { exportController } from '../controllers/exportController.js';
import { userController } from '../controllers/userController.js';
import { countryController } from '../controllers/countryController.js';
import { auditController } from '../controllers/auditController.js';
import { settingsController } from '../controllers/settingsController.js';
import { EXPORT_ROLES } from '../services/accessService.js';
import { getStore } from '../store/index.js';

const limiter = (windowMs, max, keyByUser = false) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  ...(keyByUser ? { keyGenerator: req => `user:${req.user?.id ?? req.ip}` } : {}),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' }
});

export function buildRouter({ disableRateLimits = false } = {}) {
  const passthrough = (req, res, next) => next();
  const loginLimiter = disableRateLimits ? passthrough : limiter(15 * 60 * 1000, 20);
  const refreshLimiter = disableRateLimits ? passthrough : limiter(15 * 60 * 1000, 120);
  const integrationLimiter = disableRateLimits ? passthrough : limiter(60 * 1000, 20, true);
  const exportLimiter = disableRateLimits ? passthrough : limiter(60 * 1000, 10, true);

  const router = Router();

  router.get('/health', h(async (req, res) => {
    let store = 'unavailable';
    try {
      await getStore().ping();
      store = 'ok';
    } catch {
      store = 'error';
    }
    res.status(store === 'ok' ? 200 : 503).json({ status: store === 'ok' ? 'HEALTHY' : 'DEGRADED', store, timestamp: new Date().toISOString() });
  }));

  // Auth --------------------------------------------------------------------------
  router.post('/auth/login', loginLimiter, h(authController.login));
  router.post('/auth/refresh', refreshLimiter, h(authController.refresh));
  router.post('/auth/logout', authenticate, h(authController.logout));
  router.get('/auth/me', authenticate, h(authController.me));

  // Platform selector -------------------------------------------------------------
  router.get('/platforms/showcase', h(platformController.getPublicShowcase));
  router.get('/platforms', authenticate, h(platformController.getAuthorizedPlatforms));

  // Platform management (Super Admin) ---------------------------------------------
  const pmRouter = Router();
  pmRouter.use(authenticate, requireSuperAdmin);
  pmRouter.get('/meta', h(pm.meta));
  pmRouter.get('/history', h(pm.history));
  pmRouter.get('/allowlist', h(pm.getAllowlist));
  pmRouter.put('/allowlist', h(pm.setAllowlist));
  pmRouter.get('/', h(pm.list));
  pmRouter.post('/', h(pm.create));
  pmRouter.post('/test-health', integrationLimiter, h(pm.testHealth));
  pmRouter.post('/inspect', integrationLimiter, h(pm.inspect));
  pmRouter.post('/preview-metrics', h(pm.previewMetrics));
  pmRouter.get('/:id', h(pm.getById));
  pmRouter.put('/:id', h(pm.update));
  pmRouter.put('/:id/integration', h(pm.saveIntegration));
  pmRouter.post('/:id/test-health', integrationLimiter, h(pm.testHealth));
  pmRouter.post('/:id/inspect', integrationLimiter, h(pm.inspect));
  pmRouter.post('/:id/preview-metrics', h(pm.previewMetrics));
  pmRouter.post('/:id/validate', integrationLimiter, h(pm.validate));
  pmRouter.post('/:id/activate', h(pm.activate));
  pmRouter.post('/:id/disable', h(pm.disable));
  pmRouter.delete('/:id', h(pm.delete));
  pmRouter.get('/:id/history', h(pm.history));
  router.use('/platform-management', pmRouter);

  // Reports (platform-scoped; access re-validated per request) ------------------------
  router.get('/reports/overview', authenticate, requirePlatform({ allowAll: true }), h(reportController.overview));
  router.get('/reports/activity', authenticate, requirePlatform({ allowAll: true }), h(reportController.activity));
  router.get('/reports/settlement', authenticate, requirePlatform({ allowAll: false }), h(reportController.settlement));
  router.get('/reports/records', authenticate, requirePlatform({ allowAll: false }), h(reportController.records));
  router.get('/reports/section/:section', authenticate, requirePlatform({ allowAll: false }), h(reportController.section));

  // Exports ---------------------------------------------------------------------------
  router.get('/export/settlement', authenticate, requirePlatform({ allowAll: false }), requireRole(...EXPORT_ROLES), exportLimiter, h(exportController.settlement));
  router.get('/export/records', authenticate, requirePlatform({ allowAll: false }), requireRole(...EXPORT_ROLES), exportLimiter, h(exportController.records));

  // Users & access control ------------------------------------------------------------
  router.get('/users/roles', authenticate, requireAnyPlatformRole('Platform Admin'), h(userController.getRoles));
  router.get('/users', authenticate, requireAnyPlatformRole('Platform Admin'), h(userController.getAllUsers));
  router.get('/users/:id', authenticate, requireSuperAdmin, h(userController.getUserById));
  router.post('/users', authenticate, requireSuperAdmin, h(userController.createUser));
  router.put('/users/:id', authenticate, requireSuperAdmin, h(userController.updateUser));
  router.put('/users/:id/reset-password', authenticate, requireSuperAdmin, h(userController.resetPassword));
  router.delete('/users/:id', authenticate, requireSuperAdmin, h(userController.deleteUser));

  // Countries ---------------------------------------------------------------------------
  router.get('/countries', authenticate, h(countryController.getAllCountries));
  router.get('/countries/:id', authenticate, h(countryController.getCountryById));
  router.post('/countries', authenticate, requireSuperAdmin, h(countryController.createCountry));
  router.put('/countries/:id', authenticate, requireSuperAdmin, h(countryController.updateCountry));
  router.delete('/countries/:id', authenticate, requireSuperAdmin, h(countryController.deleteCountry));

  // Audit logs ----------------------------------------------------------------------------
  router.get('/audit-logs', authenticate, requireAnyPlatformRole('Platform Admin'), h(auditController.getAuditLogs));

  // Settings ------------------------------------------------------------------------------
  router.get('/settings', authenticate, h(settingsController.getSettings));
  router.put('/settings/profile', authenticate, h(settingsController.updateProfile));
  router.put('/settings/security', authenticate, h(settingsController.updateSecurity));

  return router;
}
