import { col, COLLECTIONS, isPostgres, query } from '../store/index.js';

/**
 * Connection and validation history for platform API integrations.
 * Stores request metadata only (host, path, status, timing, error code) — never
 * credentials, headers, query values or response bodies.
 */
export const integrationLogRepository = {
  async insert(entry) {
    const pid = entry.platformId !== null && entry.platformId !== undefined ? Number(entry.platformId) : null;
    const uid = entry.userId !== null && entry.userId !== undefined ? Number(entry.userId) : null;

    if (isPostgres()) {
      await query(
        `INSERT INTO admin_integration_logs (
          platform_id, platform_code, kind, ok, http_status, error_code,
          message, host, path, duration_ms, bytes, summary, user_id, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, NOW()
        );`,
        [
          pid,
          entry.platformCode ?? null,
          entry.kind,
          Boolean(entry.ok),
          entry.httpStatus ?? null,
          entry.errorCode ?? null,
          entry.message ? String(entry.message).slice(0, 500) : null,
          entry.host ?? null,
          entry.path ?? null,
          entry.durationMs ?? null,
          entry.bytes ?? null,
          entry.summary ? JSON.stringify(entry.summary) : null,
          uid
        ]
      );
      return;
    }

    await col(COLLECTIONS.integrationLogs).insertOne({
      platform_id: pid,
      platform_code: entry.platformCode ?? null,
      kind: entry.kind,
      ok: Boolean(entry.ok),
      http_status: entry.httpStatus ?? null,
      error_code: entry.errorCode ?? null,
      message: entry.message ? String(entry.message).slice(0, 500) : null,
      host: entry.host ?? null,
      path: entry.path ?? null,
      duration_ms: entry.durationMs ?? null,
      bytes: entry.bytes ?? null,
      summary: entry.summary ?? null,
      user_id: uid,
      created_at: new Date()
    });
  },

  async list({ platformId = null, kind = null, ok = null, page = 1, limit = 25 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const offset = (safePage - 1) * safeLimit;

    if (isPostgres()) {
      const conditions = [];
      const params = [];

      if (platformId !== null && platformId !== undefined) {
        params.push(Number(platformId));
        conditions.push(`platform_id = $${params.length}`);
      }
      if (kind) {
        params.push(kind);
        conditions.push(`kind = $${params.length}`);
      }
      if (ok !== null && ok !== undefined) {
        params.push(Boolean(ok));
        conditions.push(`ok = $${params.length}`);
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRes = await query(`SELECT COUNT(*) as count FROM admin_integration_logs ${whereClause};`, params);
      const total = parseInt(countRes.rows[0].count, 10);

      params.push(safeLimit);
      const limitIdx = params.length;
      params.push(offset);
      const offsetIdx = params.length;

      const dataSql = `
        SELECT id, platform_id, platform_code, kind, ok, http_status, error_code,
               message, host, path, duration_ms, bytes, summary, user_id, created_at
        FROM admin_integration_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx};
      `;
      const dataRes = await query(dataSql, params);

      return {
        records: dataRes.rows.map(r => ({
          id: String(r.id),
          platformId: r.platform_id ? Number(r.platform_id) : null,
          platformCode: r.platform_code,
          kind: r.kind,
          ok: r.ok,
          httpStatus: r.http_status,
          errorCode: r.error_code,
          message: r.message,
          host: r.host,
          path: r.path,
          durationMs: r.duration_ms,
          bytes: r.bytes,
          summary: r.summary,
          userId: r.user_id ? Number(r.user_id) : null,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
        })),
        pagination: { totalRecords: total, totalPages: Math.max(1, Math.ceil(total / safeLimit)), currentPage: safePage, limit: safeLimit }
      };
    }

    const filter = {};
    if (platformId !== null) filter.platform_id = parseInt(platformId, 10);
    if (kind) filter.kind = kind;
    if (ok !== null) filter.ok = ok;
    const logs = col(COLLECTIONS.integrationLogs);
    const [total, rows] = await Promise.all([
      logs.countDocuments(filter),
      logs.find(filter).sort({ created_at: -1 }).skip(offset).limit(safeLimit).toArray()
    ]);
    return {
      records: rows.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })),
      pagination: { totalRecords: total, totalPages: Math.max(1, Math.ceil(total / safeLimit)), currentPage: safePage, limit: safeLimit }
    };
  }
};
