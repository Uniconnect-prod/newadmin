import { col, COLLECTIONS, isPostgres, query } from '../store/index.js';
import { userRepository } from './userRepository.js';

const SENSITIVE_KEY = /(password|secret|token|api[_-]?key|authorization|cookie|credential)/i;

/**
 * Remove anything that looks like a credential before it is persisted in an audit record.
 */
export function scrubMetadata(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => scrubMetadata(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export const auditRepository = {
  async insert({ userId = null, platformId = null, action, entity, entityId = null, metadata = {}, ip = null }) {
    const uid = userId ? Number(userId) : null;
    const pid = platformId ? Number(platformId) : null;
    const scrubbed = scrubMetadata(metadata);

    if (isPostgres()) {
      await query(
        `INSERT INTO admin_audit_logs (user_id, platform_id, action, entity, entity_id, metadata, ip_address, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());`,
        [uid, pid, action, entity, entityId === null || entityId === undefined ? null : String(entityId), JSON.stringify(scrubbed), ip]
      );
      return;
    }

    await col(COLLECTIONS.audit).insertOne({
      user_id: uid,
      platform_id: pid,
      action,
      entity,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      metadata: scrubbed,
      ip_address: ip,
      created_at: new Date()
    });
  },

  async search({ platformIds = null, action, entity, userId, from, to, page = 1, limit = 25 }) {
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const offset = (safePage - 1) * safeLimit;

    if (isPostgres()) {
      const conditions = [];
      const params = [];

      if (platformIds && Array.isArray(platformIds)) {
        params.push(platformIds.map(Number));
        conditions.push(`platform_id = ANY($${params.length}::bigint[])`);
      }
      if (action) {
        params.push(action);
        conditions.push(`action = $${params.length}`);
      }
      if (entity) {
        params.push(entity);
        conditions.push(`entity = $${params.length}`);
      }
      if (userId) {
        params.push(Number(userId));
        conditions.push(`user_id = $${params.length}`);
      }
      if (from) {
        params.push(new Date(from));
        conditions.push(`created_at >= $${params.length}`);
      }
      if (to) {
        params.push(new Date(to));
        conditions.push(`created_at <= $${params.length}`);
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const countSql = `SELECT COUNT(*) as count FROM admin_audit_logs ${whereClause};`;
      const countRes = await query(countSql, params);
      const total = parseInt(countRes.rows[0].count, 10);

      params.push(safeLimit);
      const limitParamIdx = params.length;
      params.push(offset);
      const offsetParamIdx = params.length;

      const dataSql = `
        SELECT id, user_id, platform_id, action, entity, entity_id, metadata, ip_address, created_at
        FROM admin_audit_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx};
      `;
      const dataRes = await query(dataSql, params);
      const rows = dataRes.rows;

      const names = await userRepository.namesByIds(rows.map(r => r.user_id));

      return {
        records: rows.map(r => ({
          id: String(r.id),
          action: r.action,
          entity: r.entity,
          entityId: r.entity_id,
          userId: r.user_id ? Number(r.user_id) : null,
          user: names.get(Number(r.user_id))?.name || (r.user_id ? `User #${r.user_id}` : 'System'),
          platformId: r.platform_id ? Number(r.platform_id) : null,
          metadata: r.metadata || {},
          ip: r.ip_address,
          timestamp: r.created_at ? new Date(r.created_at).toISOString() : null
        })),
        pagination: { totalRecords: total, totalPages: Math.max(1, Math.ceil(total / safeLimit)), currentPage: safePage, limit: safeLimit }
      };
    }

    const filter = {};
    if (platformIds) filter.platform_id = { $in: platformIds };
    if (action) filter.action = action;
    if (entity) filter.entity = entity;
    if (userId) filter.user_id = parseInt(userId, 10);
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = from;
      if (to) filter.created_at.$lte = to;
    }
    const audit = col(COLLECTIONS.audit);
    const [total, rows] = await Promise.all([
      audit.countDocuments(filter),
      audit.find(filter).sort({ created_at: -1 }).skip(offset).limit(safeLimit).toArray()
    ]);
    const names = await userRepository.namesByIds(rows.map(r => r.user_id));
    return {
      records: rows.map(r => ({
        id: String(r._id || r.id),
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        userId: r.user_id,
        user: names.get(r.user_id)?.name || (r.user_id ? `User #${r.user_id}` : 'System'),
        platformId: r.platform_id,
        metadata: r.metadata || {},
        ip: r.ip_address,
        timestamp: r.created_at
      })),
      pagination: { totalRecords: total, totalPages: Math.max(1, Math.ceil(total / safeLimit)), currentPage: safePage, limit: safeLimit }
    };
  },

  async distinctActions() {
    if (isPostgres()) {
      const res = await query(`SELECT DISTINCT action FROM admin_audit_logs ORDER BY action ASC;`);
      return res.rows.map(r => r.action).filter(Boolean);
    }

    const rows = await col(COLLECTIONS.audit).find({}, { projection: { action: 1 } }).sort({ created_at: -1 }).limit(2000).toArray();
    return [...new Set(rows.map(r => r.action).filter(Boolean))].sort();
  }
};
