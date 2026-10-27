import { col, COLLECTIONS, isPostgres, query, transaction, nextSequence } from '../store/index.js';
import { TtlCache } from '../utils/ttlCache.js';

// Roles are seeded at startup and almost never change in production.
const rolesCache = new TtlCache({ ttlMs: 60_000, maxSize: 10 });

function access() {
  return col(COLLECTIONS.access);
}

function shapeRole(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.role_name || row.name,
    role_name: row.role_name || row.name,
    description: row.description || '',
    permissions: row.permissions || []
  };
}

function shapeAccess(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: Number(row.admin_id ?? row.user_id),
    admin_id: Number(row.admin_id ?? row.user_id),
    platform_id: Number(row.platform_id),
    role_id: Number(row.role_id),
    start_date: row.start_date ? new Date(row.start_date).toISOString() : null,
    end_date: row.end_date ? new Date(row.end_date).toISOString() : null,
    status: row.status,
    created_by: row.created_by ? Number(row.created_by) : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

export const roleRepository = {
  async list() {
    if (isPostgres()) {
      return rolesCache.getOrSet('roles', async () => {
        const sql = `SELECT id, role_name, description, permissions, created_at, updated_at FROM admin_roles ORDER BY id ASC;`;
        const res = await query(sql);
        return res.rows.map(shapeRole);
      });
    }
    return col(COLLECTIONS.roles).find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
  },

  async findById(id) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const sql = `SELECT id, role_name, description, permissions, created_at, updated_at FROM admin_roles WHERE id = $1;`;
      const res = await query(sql, [idNum]);
      return shapeRole(res.rows[0]);
    }
    return col(COLLECTIONS.roles).findOne({ id: idNum }, { projection: { _id: 0 } });
  }
};

/**
 * Date-windowed platform authorisations (user × platform × role × [start, end]).
 */
export const accessRepository = {
  async listForUser(userId) {
    const uid = parseInt(userId, 10);
    if (!Number.isFinite(uid)) return [];

    if (isPostgres()) {
      const sql = `
        SELECT id, admin_id, platform_id, role_id, start_date, end_date, status, created_by, created_at, updated_at
        FROM admin_platform_access
        WHERE admin_id = $1
        ORDER BY platform_id ASC;
      `;
      const res = await query(sql, [uid]);
      return res.rows.map(shapeAccess);
    }

    return access().find({ user_id: uid }).toArray();
  },

  async listAll() {
    if (isPostgres()) {
      const sql = `
        SELECT id, admin_id, platform_id, role_id, start_date, end_date, status, created_by, created_at, updated_at
        FROM admin_platform_access
        ORDER BY admin_id ASC, platform_id ASC;
      `;
      const res = await query(sql);
      return res.rows.map(shapeAccess);
    }

    return access().find({}).toArray();
  },

  async findForUserAndPlatform(userId, platformId) {
    const uid = parseInt(userId, 10);
    const pid = parseInt(platformId, 10);
    if (!Number.isFinite(uid) || !Number.isFinite(pid)) return null;

    if (isPostgres()) {
      const sql = `
        SELECT id, admin_id, platform_id, role_id, start_date, end_date, status, created_by, created_at, updated_at
        FROM admin_platform_access
        WHERE admin_id = $1 AND platform_id = $2
        LIMIT 1;
      `;
      const res = await query(sql, [uid, pid]);
      return shapeAccess(res.rows[0]);
    }

    return access().findOne({ user_id: uid, platform_id: pid });
  },

  /**
   * Replace a user's assignments with the supplied list (validated by the caller).
   */
  async replaceForUser(userId, assignments, createdBy) {
    const uid = parseInt(userId, 10);
    const creatorId = createdBy ? parseInt(createdBy, 10) : null;

    if (isPostgres()) {
      await transaction(async (client) => {
        await client.query(`DELETE FROM admin_platform_access WHERE admin_id = $1;`, [uid]);
        for (const a of assignments) {
          const pid = parseInt(a.platform_id, 10);
          const rid = parseInt(a.role_id, 10);
          const start = new Date(a.start_date);
          const end = new Date(a.end_date);
          const status = a.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE';
          await client.query(
            `INSERT INTO admin_platform_access (admin_id, platform_id, role_id, start_date, end_date, status, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
             ON CONFLICT (admin_id, platform_id) DO UPDATE SET
               role_id = EXCLUDED.role_id,
               start_date = EXCLUDED.start_date,
               end_date = EXCLUDED.end_date,
               status = EXCLUDED.status,
               updated_at = NOW();`,
            [uid, pid, rid, start, end, status, creatorId]
          );
        }
      });
      return;
    }

    await access().deleteMany({ user_id: uid });
    const now = new Date();
    for (const a of assignments) {
      await access().insertOne({
        id: await nextSequence(COLLECTIONS.access),
        user_id: uid,
        platform_id: parseInt(a.platform_id, 10),
        role_id: parseInt(a.role_id, 10),
        start_date: new Date(a.start_date).toISOString(),
        end_date: new Date(a.end_date).toISOString(),
        status: a.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
        created_by: createdBy,
        created_at: now,
        updated_at: now
      });
    }
  },

  async grant({ userId, platformId, roleId, startDate, endDate, createdBy }) {
    const uid = parseInt(userId, 10);
    const pid = parseInt(platformId, 10);
    const rid = parseInt(roleId, 10);

    if (isPostgres()) {
      await query(
        `INSERT INTO admin_platform_access (admin_id, platform_id, role_id, start_date, end_date, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, NOW(), NOW())
         ON CONFLICT (admin_id, platform_id) DO UPDATE SET
           role_id = EXCLUDED.role_id,
           start_date = EXCLUDED.start_date,
           end_date = EXCLUDED.end_date,
           status = 'ACTIVE',
           updated_at = NOW();`,
        [uid, pid, rid, startDate, endDate, createdBy ? parseInt(createdBy, 10) : null]
      );
      return;
    }

    const now = new Date();
    await access().updateOne(
      { user_id: uid, platform_id: pid },
      {
        $set: {
          role_id: rid,
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
          status: 'ACTIVE',
          updated_at: now
        },
        $setOnInsert: { id: await nextSequence(COLLECTIONS.access), created_by: createdBy, created_at: now }
      },
      { upsert: true }
    );
  },

  async revokeAllForUser(userId) {
    const uid = parseInt(userId, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_platform_access SET status = 'REVOKED', updated_at = NOW() WHERE admin_id = $1;`, [uid]);
      return;
    }
    await access().updateMany({ user_id: uid }, { $set: { status: 'REVOKED', updated_at: new Date() } });
  }
};
