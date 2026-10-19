import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/userRepository.js';
import { accessRepository, roleRepository } from '../repositories/accessRepository.js';
import { platformRepository } from '../repositories/platformRepository.js';
import { tokenRepository } from '../repositories/tokenRepository.js';
import { formatAccessRecord } from '../utils/platformAccessHelper.js';
import { logAudit } from '../middleware/auditLogger.js';
import { badRequest, notFound, conflict } from '../utils/errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_.@-]{3,50}$/;
export const MIN_PASSWORD_LENGTH = 10;

async function validateAssignments(assignments) {
  if (assignments === undefined) return undefined;
  if (!Array.isArray(assignments)) throw badRequest('platform_assignments must be an array.');
  const [roles, platforms] = await Promise.all([roleRepository.list(), platformRepository.listAll()]);
  const roleIds = new Set(roles.map(r => r.id));
  const platformIds = new Set(platforms.map(p => p.id));
  const seen = new Set();
  return assignments.map((a, i) => {
    const platformId = parseInt(a?.platform_id, 10);
    const roleId = parseInt(a?.role_id, 10);
    if (!platformIds.has(platformId)) throw badRequest(`Assignment ${i + 1}: unknown platform.`);
    if (!roleIds.has(roleId)) throw badRequest(`Assignment ${i + 1}: unknown role.`);
    if (seen.has(platformId)) throw badRequest(`Assignment ${i + 1}: the platform is assigned more than once.`);
    seen.add(platformId);
    const start = new Date(a.start_date);
    const end = new Date(a.end_date);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest(`Assignment ${i + 1}: start and end dates are required.`);
    if (start > end) throw badRequest(`Assignment ${i + 1}: the start date must not be after the end date.`);
    return { platform_id: platformId, role_id: roleId, start_date: start, end_date: end, status: a.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE' };
  });
}

async function withAccess(users, visiblePlatformIds = null) {
  const [access, roles, platforms] = await Promise.all([accessRepository.listAll(), roleRepository.list(), platformRepository.listAll()]);
  const roleMap = new Map(roles.map(r => [r.id, r.name]));
  const platformMap = new Map(platforms.map(p => [p.id, p]));
  const now = new Date();
  return users.map(u => {
    const rows = access
      .filter(a => a.user_id === u.id && (!visiblePlatformIds || visiblePlatformIds.has(a.platform_id)))
      .map(a => formatAccessRecord({
        ...a,
        platform_name: platformMap.get(a.platform_id)?.name || `Platform #${a.platform_id}`,
        platform_code: platformMap.get(a.platform_id)?.code || null,
        role_name: roleMap.get(a.role_id) || 'Viewer'
      }, now));
    const roleNames = [...new Set(rows.map(r => r.role_name))];
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      username: u.username,
      status: u.status,
      country: u.country || null,
      is_super_admin: Boolean(u.is_super_admin || u.id === 1),
      access_start_date: u.access_start_date || null,
      access_end_date: u.access_end_date || null,
      last_login_at: u.last_login_at || null,
      created_at: u.created_at || null,
      roles: roleNames,
      platforms: rows,
      activePlatformsCount: rows.filter(r => r.isCurrentlyActive).length
    };
  });
}

function validateProfile({ name, email, username }, { partial = false } = {}) {
  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100) throw badRequest('Full name is required (2–100 characters).');
  }
  if (!partial || email !== undefined) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw badRequest('A valid email address is required.');
  }
  if (!partial || username !== undefined) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) throw badRequest('Username must be 3–50 characters: letters, digits, dot, dash or underscore.');
  }
}

export const userController = {
  async getRoles(req, res) {
    res.json({ success: true, data: await roleRepository.list() });
  },

  async getAllUsers(req, res) {
    try {
      await userRepository.cleanupExpiredUsers();
    } catch (err) {
      console.warn('[Users] Expired user cleanup error:', err.message);
    }
    const users = await userRepository.list();
    if (req.user.isSuperAdmin) {
      return res.json({ success: true, data: await withAccess(users) });
    }
    // Platform Admins only see users and assignments on platforms they administer.
    const adminOf = new Set(req.user.access.filter(a => a.isCurrentlyActive && a.role_name === 'Platform Admin').map(a => a.platform_id));
    const all = await withAccess(users, adminOf);
    return res.json({ success: true, data: all.filter(u => u.platforms.length > 0) });
  },

  async getUserById(req, res) {
    const user = await userRepository.findById(req.params.id);
    if (!user) throw notFound('User not found.');
    const [withPlatforms] = await withAccess([user]);
    res.json({ success: true, data: withPlatforms });
  },

  async createUser(req, res) {
    const { name, email, username, password, status, country, access_start_date, access_end_date } = req.body || {};
    validateProfile({ name, email, username });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (await userRepository.existsWithEmailOrUsername(email.trim(), username.trim())) throw conflict('A user with this email or username already exists.');
    const assignments = (await validateAssignments(req.body.platform_assignments)) || [];

    let finalStartDate = null;
    let finalEndDate = null;
    if (access_start_date) {
      const d = new Date(access_start_date);
      if (Number.isNaN(d.getTime())) throw badRequest('Access start date is invalid.');
      finalStartDate = d;
    }
    if (access_end_date) {
      const d = new Date(access_end_date);
      if (Number.isNaN(d.getTime())) throw badRequest('Access end date is invalid.');
      finalEndDate = d;
    }
    if (finalStartDate && finalEndDate && finalStartDate > finalEndDate) {
      throw badRequest('Access start date must not be after access end date.');
    }

    if (!finalStartDate && assignments.length > 0) {
      const minAssignStart = assignments.map(a => a.start_date).sort((a, b) => a - b)[0];
      if (minAssignStart) finalStartDate = minAssignStart;
    }
    if (!finalEndDate && assignments.length > 0) {
      const maxAssignEnd = assignments.map(a => a.end_date).sort((a, b) => b - a)[0];
      if (maxAssignEnd) finalEndDate = maxAssignEnd;
    }

    const created = await userRepository.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      username: username.trim(),
      password_hash: await bcrypt.hash(password, 12),
      status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      country: country ? String(country).trim().slice(0, 80) : null,
      access_start_date: finalStartDate,
      access_end_date: finalEndDate
    });
    await accessRepository.replaceForUser(created.id, assignments, req.user.id);
    await logAudit(req, 'CREATE_USER', 'User', created.id, { username: created.username, assignments: assignments.length }, { platformId: null });
    const [out] = await withAccess([created]);
    res.status(201).json({ success: true, message: 'User created.', data: out });
  },

  async updateUser(req, res) {
    const id = parseInt(req.params.id, 10);
    const existing = await userRepository.findById(id);
    if (!existing) throw notFound('User not found.');
    const { name, email, username, status, country, access_start_date, access_end_date } = req.body || {};
    validateProfile({ name, email, username }, { partial: true });
    if (status !== undefined && !['ACTIVE', 'INACTIVE'].includes(status)) throw badRequest('Status must be ACTIVE or INACTIVE.');
    if (id === req.user.id && status === 'INACTIVE') throw badRequest('You cannot deactivate your own account.');
    if ((email !== undefined || username !== undefined)
      && await userRepository.existsWithEmailOrUsername((email ?? existing.email).trim(), (username ?? existing.username).trim(), id)) {
      throw conflict('Another user already has this email or username.');
    }

    let finalStartDate = undefined;
    let finalEndDate = undefined;
    if (access_start_date !== undefined) {
      if (access_start_date === null || access_start_date === '') {
        finalStartDate = null;
      } else {
        const d = new Date(access_start_date);
        if (Number.isNaN(d.getTime())) throw badRequest('Access start date is invalid.');
        finalStartDate = d;
      }
    }
    if (access_end_date !== undefined) {
      if (access_end_date === null || access_end_date === '') {
        finalEndDate = null;
      } else {
        const d = new Date(access_end_date);
        if (Number.isNaN(d.getTime())) throw badRequest('Access end date is invalid.');
        finalEndDate = d;
      }
    }
    const checkStart = finalStartDate !== undefined ? finalStartDate : (existing.access_start_date ? new Date(existing.access_start_date) : null);
    const checkEnd = finalEndDate !== undefined ? finalEndDate : (existing.access_end_date ? new Date(existing.access_end_date) : null);
    if (checkStart && checkEnd && checkStart > checkEnd) {
      throw badRequest('Access start date must not be after access end date.');
    }

    const assignments = await validateAssignments(req.body.platform_assignments);

    await userRepository.update(id, {
      name: name?.trim(),
      email: email?.trim().toLowerCase(),
      username: username?.trim(),
      status,
      country: country === undefined ? undefined : (country ? String(country).trim().slice(0, 80) : null),
      access_start_date: finalStartDate,
      access_end_date: finalEndDate
    });
    if (assignments) await accessRepository.replaceForUser(id, assignments, req.user.id);
    if (status === 'INACTIVE') await tokenRepository.revokeAllForUser(id);
    await logAudit(req, 'UPDATE_USER', 'User', id, { fields: Object.keys(req.body || {}).filter(k => k !== 'platform_assignments'), assignments: assignments?.length }, { platformId: null });
    const [out] = await withAccess([await userRepository.findById(id)]);
    res.json({ success: true, message: 'User updated.', data: out });
  },

  async resetPassword(req, res) {
    const id = parseInt(req.params.id, 10);
    const { newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (!(await userRepository.findById(id))) throw notFound('User not found.');
    await userRepository.setPasswordHash(id, await bcrypt.hash(newPassword, 12));
    await tokenRepository.revokeAllForUser(id);
    await logAudit(req, 'RESET_PASSWORD', 'User', id, {}, { platformId: null });
    res.json({ success: true, message: 'Password reset. Existing sessions for this user were signed out.' });
  },

  async deleteUser(req, res) {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) throw badRequest('You cannot delete your own account.');
    const existing = await userRepository.findById(id);
    if (!existing) throw notFound('User not found.');
    await userRepository.deletePermanently(id);
    await logAudit(req, 'DELETE_USER', 'User', id, { username: existing.username }, { platformId: null });
    res.json({ success: true, message: 'User permanently removed from the database.' });
  }
};
