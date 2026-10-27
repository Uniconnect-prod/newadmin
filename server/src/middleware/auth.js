import { verifyAccessToken } from '../utils/token.js';
import { userRepository } from '../repositories/userRepository.js';
import { evaluateUserAccess } from '../services/accessService.js';
import { TtlCache } from '../utils/ttlCache.js';

// Cache the result of evaluateUserAccess (3 parallel DB queries) per user for 15 s.
// Fine-grained access changes take effect within the TTL window, which is acceptable
// since the JWT itself is already a ~1-hour credential.
const accessCache = new TtlCache({ ttlMs: 15_000, maxSize: 500 });

/** Call after any platform-access or user-status change to flush the affected user. */
export function invalidateUserAccessCache(userId) {
  accessCache.delete(`access:${userId}`);
}

export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Authentication required.' });
    }

    let decoded;
    try {
      decoded = verifyAccessToken(header.slice(7));
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', message: 'Your session has expired. Refreshing…' });
      }
      return res.status(401).json({ success: false, code: 'INVALID_TOKEN', message: 'Invalid session. Please sign in again.' });
    }

    const user = await userRepository.findById(decoded.userId);
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'Your account is not active.' });
    }

    if (!user.is_super_admin && user.id !== 1) {
      const now = new Date();
      if (user.access_end_date && now >= new Date(user.access_end_date)) {
        await userRepository.deletePermanently(user.id);
        return res.status(403).json({ success: false, code: 'ACCOUNT_EXPIRED', message: 'Your account access period has ended and this account has been removed.' });
      }
      if (user.access_start_date && now < new Date(user.access_start_date)) {
        return res.status(403).json({ success: false, code: 'ACCOUNT_NOT_STARTED', message: 'Your account access has not started yet.' });
      }
    }

    const { evaluated, isSuperAdmin, available } = await accessCache.getOrSet(
      `access:${user.id}`,
      () => evaluateUserAccess(user)
    );
    if (!isSuperAdmin) {
      if (evaluated.length > 0 && evaluated.every(a => a.status === 'EXPIRED')) {
        await userRepository.deletePermanently(user.id);
        return res.status(403).json({ success: false, code: 'ACCOUNT_EXPIRED', message: 'Your platform access period has ended and this account has been removed.' });
      }
      if (evaluated.length > 0 && evaluated.every(a => a.status === 'UPCOMING')) {
        return res.status(403).json({ success: false, code: 'PLATFORM_ACCESS_UPCOMING', message: 'Your platform access has not started yet.' });
      }
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      country: user.country || null,
      isSuperAdmin,
      access_start_date: user.access_start_date || null,
      access_end_date: user.access_end_date || null,
      access: evaluated,
      platforms: available
    };
    return next();
  } catch (err) {
    return next(err);
  }
}
