import { col, COLLECTIONS, isPostgres, query, nextSequence } from '../store/index.js';
import { exactCaseInsensitive } from '../utils/errors.js';

const PUBLIC_FIELDS = { password_hash: 0, backup_password_hash: 0 };

function users() {
  return col(COLLECTIONS.users);
}

function shapeUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    username: row.username,
    status: row.status,
    country: row.country || null,
    is_super_admin: Boolean(row.is_super_admin),
    access_start_date: row.access_start_date ? new Date(row.access_start_date).toISOString() : null,
    access_end_date: row.access_end_date ? new Date(row.access_end_date).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    ...(row.password_hash !== undefined ? { password_hash: row.password_hash } : {}),
    ...(row.backup_password_hash !== undefined ? { backup_password_hash: row.backup_password_hash } : {})
  };
}

export const userRepository = {
  async findForLogin(identifier) {
    if (isPostgres()) {
      const sql = `
        SELECT id, username, email, password_hash, status, is_super_admin, name, country,
               access_start_date, access_end_date,
               created_at, updated_at, last_login_at, deleted_at, backup_password_hash
        FROM admin_users
        WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))
          AND deleted_at IS NULL
        LIMIT 1;
      `;
      const res = await query(sql, [String(identifier).trim()]);
      return shapeUser(res.rows[0]);
    }

    const re = exactCaseInsensitive(identifier);
    return users().findOne({ $or: [{ username: re }, { email: re }], deleted_at: null });
  },

  async findById(id, { includePassword = false } = {}) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const sql = `
        SELECT id, username, email, status, is_super_admin, name, country,
               access_start_date, access_end_date,
               created_at, updated_at, last_login_at, deleted_at
               ${includePassword ? ', password_hash, backup_password_hash' : ''}
        FROM admin_users
        WHERE id = $1 AND deleted_at IS NULL;
      `;
      const res = await query(sql, [idNum]);
      return shapeUser(res.rows[0]);
    }

    return users().findOne({ id: idNum, deleted_at: null }, includePassword ? {} : { projection: PUBLIC_FIELDS });
  },

  async list() {
    if (isPostgres()) {
      const sql = `
        SELECT id, username, email, status, is_super_admin, name, country,
               access_start_date, access_end_date,
               created_at, updated_at, last_login_at, deleted_at
        FROM admin_users
        WHERE deleted_at IS NULL
        ORDER BY id ASC;
      `;
      const res = await query(sql);
      return res.rows.map(shapeUser);
    }

    return users().find({ deleted_at: null }, { projection: PUBLIC_FIELDS }).sort({ id: 1 }).toArray();
  },

  async existsWithEmailOrUsername(email, username, excludeId = null) {
    if (isPostgres()) {
      const sql = `
        SELECT id FROM admin_users
        WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2))
          AND deleted_at IS NULL
          AND ($3::bigint IS NULL OR id != $3)
        LIMIT 1;
      `;
      const res = await query(sql, [String(email).trim(), String(username).trim(), excludeId ? Number(excludeId) : null]);
      return res.rows.length > 0;
    }

    const filter = {
      deleted_at: null,
      $or: [{ email: exactCaseInsensitive(email) }, { username: exactCaseInsensitive(username) }]
    };
    const found = await users().findOne(filter, { projection: { id: 1 } });
    return Boolean(found && found.id !== excludeId);
  },

  async create({ name, email, username, password_hash, status = 'ACTIVE', country = null, is_super_admin = false, access_start_date = null, access_end_date = null }) {
    if (isPostgres()) {
      const sql = `
        INSERT INTO admin_users (name, email, username, password_hash, status, country, is_super_admin, access_start_date, access_end_date, created_at, updated_at)
        VALUES ($1, LOWER($2), $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        RETURNING id, name, email, username, status, country, is_super_admin, access_start_date, access_end_date, created_at, updated_at, last_login_at, deleted_at;
      `;
      const res = await query(sql, [name, email, username, password_hash, status, country, Boolean(is_super_admin), access_start_date ? new Date(access_start_date) : null, access_end_date ? new Date(access_end_date) : null]);
      const created = shapeUser(res.rows[0]);

      if (is_super_admin) {
        await query(
          `INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, 1) ON CONFLICT DO NOTHING;`,
          [created.id]
        );
      }
      return created;
    }

    const now = new Date();
    const id = await nextSequence(COLLECTIONS.users);
    const doc = {
      id,
      name,
      email,
      username,
      password_hash,
      status,
      country,
      is_super_admin: Boolean(is_super_admin),
      access_start_date: access_start_date ? new Date(access_start_date).toISOString() : null,
      access_end_date: access_end_date ? new Date(access_end_date).toISOString() : null,
      last_login_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null
    };
    await users().insertOne(doc);
    const { password_hash: _omit, ...publicDoc } = doc;
    return publicDoc;
  },

  async update(id, fields) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const allowed = ['name', 'email', 'username', 'status', 'country', 'is_super_admin', 'access_start_date', 'access_end_date'];
      const setClauses = ['updated_at = NOW()'];
      const params = [idNum];

      for (const key of allowed) {
        if (fields[key] !== undefined) {
          let val = fields[key];
          if (key === 'email') val = String(val).toLowerCase();
          else if (key === 'access_start_date' || key === 'access_end_date') val = val ? new Date(val) : null;
          params.push(val);
          setClauses.push(`"${key}" = $${params.length}`);
        }
      }

      await query(
        `UPDATE admin_users SET ${setClauses.join(', ')} WHERE id = $1 AND deleted_at IS NULL;`,
        params
      );

      if (fields.is_super_admin !== undefined) {
        if (fields.is_super_admin) {
          await query(`INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, 1) ON CONFLICT DO NOTHING;`, [idNum]);
        } else {
          await query(`DELETE FROM admin_user_roles WHERE admin_id = $1 AND role_id = 1;`, [idNum]);
        }
      }

      return this.findById(idNum);
    }

    const allowed = ['name', 'email', 'username', 'status', 'country', 'is_super_admin', 'access_start_date', 'access_end_date'];
    const set = { updated_at: new Date() };
    for (const key of allowed) if (fields[key] !== undefined) set[key] = fields[key];
    await users().updateOne({ id: idNum, deleted_at: null }, { $set: set });
    return this.findById(id);
  },

  async setPasswordHash(id, passwordHash) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_users SET password_hash = $2, updated_at = NOW() WHERE id = $1;`, [idNum, passwordHash]);
      return;
    }
    await users().updateOne({ id: idNum }, { $set: { password_hash: passwordHash, updated_at: new Date() } });
  },

  async touchLogin(id) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1;`, [idNum]);
      return;
    }
    await users().updateOne({ id: idNum }, { $set: { last_login_at: new Date() } });
  },

  async softDelete(id) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_users SET deleted_at = NOW(), status = 'INACTIVE', updated_at = NOW() WHERE id = $1;`, [idNum]);
      return;
    }
    const now = new Date();
    await users().updateOne({ id: idNum }, { $set: { deleted_at: now, status: 'INACTIVE', updated_at: now } });
  },

  async deletePermanently(id) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return;
    if (isPostgres()) {
      await query(`DELETE FROM admin_users WHERE id = $1;`, [idNum]);
      return;
    }
    await users().deleteOne({ id: idNum });
    await col(COLLECTIONS.access).deleteMany({ user_id: idNum });
  },

  async cleanupExpiredUsers() {
    if (isPostgres()) {
      const sql = `
        DELETE FROM admin_users
        WHERE is_super_admin = FALSE
          AND (
            (access_end_date IS NOT NULL AND access_end_date <= NOW())
            OR (
              id IN (
                SELECT a.admin_id
                FROM admin_platform_access a
                GROUP BY a.admin_id
                HAVING MAX(a.end_date) <= NOW()
              )
            )
          )
        RETURNING id, username;
      `;
      const res = await query(sql);
      return res.rows;
    }

    const now = new Date();
    const allUsers = await users().find({ is_super_admin: false }).toArray();
    const removed = [];
    for (const u of allUsers) {
      if (u.access_end_date && new Date(u.access_end_date) <= now) {
        await this.deletePermanently(u.id);
        removed.push(u);
      } else {
        const userAccess = await col(COLLECTIONS.access).find({ user_id: u.id }).toArray();
        if (userAccess.length > 0 && userAccess.every(a => new Date(a.end_date) <= now)) {
          await this.deletePermanently(u.id);
          removed.push(u);
        }
      }
    }
    return removed;
  },

  async namesByIds(ids) {
    const unique = [...new Set(ids.filter(v => v !== null && v !== undefined).map(v => Number(v)).filter(Number.isFinite))];
    if (!unique.length) return new Map();

    if (isPostgres()) {
      const res = await query(`SELECT id, name, email FROM admin_users WHERE id = ANY($1::bigint[]);`, [unique]);
      return new Map(res.rows.map(r => [Number(r.id), { id: Number(r.id), name: r.name, email: r.email }]));
    }

    const rows = await users().find({ id: { $in: unique } }, { projection: { id: 1, name: 1, email: 1 } }).toArray();
    return new Map(rows.map(r => [r.id, r]));
  }
};
