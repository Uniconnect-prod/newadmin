import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/userRepository.js';
import { tokenRepository } from '../repositories/tokenRepository.js';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/token.js';
import { logAudit } from '../middleware/auditLogger.js';
import { evaluateUserAccess } from '../services/accessService.js';

// Used to keep the "unknown user" path as slow as a real password check.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 10);

async function issueTokens(userId, familyId) {
  const refresh = generateRefreshToken({ userId, familyId });
  await tokenRepository.register({ jti: refresh.jti, userId, expiresAt: refresh.expiresAt, familyId: refresh.familyId });
  return { token: generateAccessToken({ userId }), refreshToken: refresh.token, jti: refresh.jti };
}

function profile(user, isSuperAdmin, activeRole) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    country: user.country || null,
    isSuperAdmin,
    activeRole,
    access_start_date: user.access_start_date ? String(user.access_start_date).slice(0, 10) : null,
    access_end_date: user.access_end_date ? String(user.access_end_date).slice(0, 10) : null
  };
}

function loginDenial(evaluated) {
  if (!evaluated.length) return { code: 'NO_PLATFORMS_ASSIGNED', message: 'Your account has no platforms assigned. Please contact an administrator.' };
  if (evaluated.every(a => a.status === 'EXPIRED')) return { code: 'PLATFORM_ACCESS_EXPIRED', message: 'Your platform access period has ended. Please contact an administrator to extend it.' };
  if (evaluated.every(a => a.status === 'UPCOMING')) return { code: 'PLATFORM_ACCESS_UPCOMING', message: 'Your platform access has not started yet.' };
  if (evaluated.every(a => a.status === 'REVOKED')) return { code: 'PLATFORM_ACCESS_REVOKED', message: 'Your platform access has been revoked.' };
  return { code: 'PLATFORM_ACCESS_DENIED', message: 'No platform is currently available to your account.' };
}

export const authController = {
  async login(req, res) {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Username/email and password are required.' });
    }

    const user = await userRepository.findForLogin(username.trim());
    let passwordOk = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!passwordOk && user?.backup_password_hash) {
      passwordOk = await bcrypt.compare(password, user.backup_password_hash);
    }
    if (!user || !passwordOk) {
      await logAudit(req, 'LOGIN_FAILED', 'Auth', null, { username: username.trim().slice(0, 100) }, { platformId: null });
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    }
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'This account has been disabled. Please contact an administrator.' });
    }

    // Date-wise access enforcement for non-super-admin users
    if (!user.is_super_admin && user.id !== 1) {
      const now = new Date();
      if (user.access_end_date && now >= new Date(user.access_end_date)) {
        await userRepository.deletePermanently(user.id);
        await logAudit(req, 'USER_EXPIRED_PURGED', 'User', user.id, { username: user.username });
        return res.status(403).json({ success: false, code: 'ACCOUNT_EXPIRED', message: 'Your account access period has ended and this account has been removed.' });
      }

      if (user.access_start_date && now < new Date(user.access_start_date)) {
        const startDay = new Date(user.access_start_date).toISOString().slice(0, 10);
        return res.status(403).json({ success: false, code: 'ACCOUNT_NOT_STARTED', message: `Your account access has not started yet. Access begins on ${startDay}.` });
      }
    }

    const { evaluated, isSuperAdmin, available } = await evaluateUserAccess(user);
    if (!isSuperAdmin) {
      const now = new Date();
      if (evaluated.length > 0 && evaluated.every(a => a.status === 'EXPIRED')) {
        await userRepository.deletePermanently(user.id);
        await logAudit(req, 'USER_EXPIRED_PURGED', 'User', user.id, { username: user.username });
        return res.status(403).json({ success: false, code: 'ACCOUNT_EXPIRED', message: 'Your platform access period has ended and this account has been removed.' });
      }

      if (evaluated.length > 0 && evaluated.every(a => a.status === 'UPCOMING')) {
        const earliest = evaluated.map(a => new Date(a.start_date)).sort((a, b) => a - b)[0];
        const startDay = earliest ? earliest.toISOString().slice(0, 10) : '';
        return res.status(403).json({ success: false, code: 'PLATFORM_ACCESS_UPCOMING', message: `Your platform access has not started yet. Access begins on ${startDay}.` });
      }

      if (available.length === 0) {
        const denial = loginDenial(evaluated);
        return res.status(403).json({ success: false, ...denial });
      }
    }

    const tokens = await issueTokens(user.id);
    await userRepository.touchLogin(user.id).catch(err => console.error(`[Auth] last_login_at update failed: ${err.message}`));
    await logAudit(req, 'USER_LOGIN', 'Auth', user.id, { platforms: available.length }, { platformId: null, userId: user.id });

    const activePlatform = isSuperAdmin ? { id: 'ALL', code: 'ALL', name: 'All Platforms', isAll: true } : available[0];
    return res.status(200).json({
      success: true,
      data: {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        user: profile(user, isSuperAdmin, isSuperAdmin ? 'Super Admin' : available[0].role),
        activePlatform,
        availablePlatforms: available
      }
    });
  },

  /**
   * Rotating refresh: each refresh token is single-use. Presenting an already-rotated token
   * is treated as theft and revokes the whole token family.
   */
  async refresh(req, res) {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Refresh token required.' });
    }
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ success: false, code: 'INVALID_REFRESH_TOKEN', message: 'Your session has ended. Please sign in again.' });
    }
    const record = decoded.jti ? await tokenRepository.find(decoded.jti) : null;
    if (!record || record.user_id !== decoded.userId) {
      return res.status(401).json({ success: false, code: 'INVALID_REFRESH_TOKEN', message: 'Your session has ended. Please sign in again.' });
    }
    if (record.revoked_at) {
      await tokenRepository.revokeFamily(record.family_id);
      await logAudit(req, 'REFRESH_TOKEN_REUSE', 'Auth', decoded.userId, { family: record.family_id }, { platformId: null, userId: decoded.userId });
      return res.status(401).json({ success: false, code: 'REFRESH_TOKEN_REUSED', message: 'This session was already used elsewhere and has been closed for safety. Please sign in again.' });
    }

    const user = await userRepository.findById(decoded.userId);
    if (!user || user.status !== 'ACTIVE') {
      await tokenRepository.revokeFamily(record.family_id);
      return res.status(401).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'Your account is not active.' });
    }

    if (!user.is_super_admin && user.id !== 1) {
      const now = new Date();
      if (user.access_end_date && now >= new Date(user.access_end_date)) {
        await userRepository.deletePermanently(user.id);
        await tokenRepository.revokeFamily(record.family_id);
        return res.status(401).json({ success: false, code: 'ACCOUNT_EXPIRED', message: 'Your account access period has ended and this account has been removed.' });
      }
      if (user.access_start_date && now < new Date(user.access_start_date)) {
        await tokenRepository.revokeFamily(record.family_id);
        return res.status(403).json({ success: false, code: 'ACCOUNT_NOT_STARTED', message: 'Your account access has not started yet.' });
      }
    }

    const tokens = await issueTokens(user.id, record.family_id);
    const rotated = await tokenRepository.markRotated(decoded.jti, tokens.jti);
    if (!rotated) {
      // Lost a race with a concurrent refresh using the same token: treat as reuse.
      await tokenRepository.revokeFamily(record.family_id);
      return res.status(401).json({ success: false, code: 'REFRESH_TOKEN_REUSED', message: 'Please sign in again.' });
    }
    return res.status(200).json({ success: true, data: { token: tokens.token, refreshToken: tokens.refreshToken } });
  },

  async logout(req, res) {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken === 'string' && refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        const record = decoded.jti ? await tokenRepository.find(decoded.jti) : null;
        if (record && record.user_id === req.user.id) await tokenRepository.revokeFamily(record.family_id);
      } catch {
        /* already invalid */
      }
    }
    await logAudit(req, 'USER_LOGOUT', 'Auth', req.user.id, {}, { platformId: null });
    return res.status(200).json({ success: true, message: 'Signed out.' });
  },

  async me(req, res) {
    const u = req.user;
    return res.status(200).json({
      success: true,
      data: {
        user: { id: u.id, name: u.name, email: u.email, username: u.username, country: u.country, isSuperAdmin: u.isSuperAdmin },
        availablePlatforms: u.platforms
      }
    });
  }
};
