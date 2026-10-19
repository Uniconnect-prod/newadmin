import { col, COLLECTIONS, isPostgres, query, nextSequence } from '../store/index.js';
import { platformRepository } from './platformRepository.js';
import { exactCaseInsensitive, escapeRegex } from '../utils/errors.js';

function countries() {
  return col(COLLECTIONS.countries);
}

function shapeCountryRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.country_name || row.name,
    code: row.country_code || row.code,
    currency: row.currency_code || row.currency || null,
    default_timezone: row.timezone || row.default_timezone || 'UTC',
    status: row.status || 'ACTIVE',
    platformCount: Number(row.platformCount ?? row.platform_count ?? (row.platforms ? row.platforms.length : 0)),
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

export const countryRepository = {
  async listAll({ search = null, status = null } = {}) {
    if (isPostgres()) {
      const conditions = [];
      const params = [];

      if (status && status !== 'ALL') {
        params.push(String(status).toUpperCase());
        conditions.push(`c.status = $${params.length}`);
      }

      if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        conditions.push(`(c.country_name ILIKE $${params.length} OR c.country_code ILIKE $${params.length} OR c.currency_code ILIKE $${params.length})`);
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `
        SELECT c.id, c.country_name, c.country_code, c.currency_code,
               c.timezone, c.status, c.created_at, c.updated_at,
               COALESCE(
                 json_agg(
                   json_build_object(
                     'id', p.id,
                     'name', p.platform_name,
                     'code', p.platform_code,
                     'status', p.status,
                     'authorizedAdmins', (
                       SELECT COALESCE(
                         json_agg(
                           json_build_object(
                             'id', u.id,
                             'name', u.name,
                             'username', u.username,
                             'email', u.email,
                             'role', r.role_name,
                             'start_date', pa.start_date,
                             'end_date', pa.end_date,
                             'status', pa.status
                           )
                         ),
                         '[]'::json
                       )
                       FROM admin_platform_access pa
                       JOIN admin_users u ON pa.admin_id = u.id
                       JOIN admin_roles r ON pa.role_id = r.id
                       WHERE pa.platform_id = p.id AND u.deleted_at IS NULL
                     )
                   )
                 ) FILTER (WHERE p.id IS NOT NULL),
                 '[]'::json
               ) as platforms,
               COUNT(p.id) as "platformCount"
        FROM admin_countries c
        LEFT JOIN admin_platforms p ON p.country_id = c.id
        ${whereClause}
        GROUP BY c.id
        ORDER BY c.country_name ASC;
      `;
      const res = await query(sql, params);
      return res.rows.map(shapeCountryRow);
    }

    const filter = {};
    if (status && status !== 'ALL') filter.status = String(status).toUpperCase();
    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegex(String(search).trim()), 'i');
      filter.$or = [{ name: re }, { code: re }, { currency: re }];
    }
    const [rows, platforms] = await Promise.all([countries().find(filter).sort({ name: 1 }).toArray(), platformRepository.listAll()]);
    return rows.map(c => {
      const linked = platforms.filter(p => {
        const pc = (p.country || '').toLowerCase();
        return pc && (pc === (c.name || '').toLowerCase() || pc === (c.code || '').toLowerCase());
      });
      return {
        id: c.id,
        name: c.name,
        code: c.code,
        currency: c.currency || null,
        default_timezone: c.default_timezone || 'UTC',
        status: c.status || 'ACTIVE',
        platformCount: linked.length,
        platforms: linked.map(p => ({ id: p.id, name: p.name, code: p.code, status: p.status })),
        created_at: c.created_at || null,
        updated_at: c.updated_at || null
      };
    });
  },

  async findById(id) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const sql = `
        SELECT c.id, c.country_name, c.country_code, c.currency_code,
               c.timezone, c.status, c.created_at, c.updated_at,
               COALESCE(
                 json_agg(
                   json_build_object(
                     'id', p.id,
                     'name', p.platform_name,
                     'code', p.platform_code,
                     'status', p.status,
                     'authorizedAdmins', (
                       SELECT COALESCE(
                         json_agg(
                           json_build_object(
                             'id', u.id,
                             'name', u.name,
                             'username', u.username,
                             'email', u.email,
                             'role', r.role_name,
                             'start_date', pa.start_date,
                             'end_date', pa.end_date,
                             'status', pa.status
                           )
                         ),
                         '[]'::json
                       )
                       FROM admin_platform_access pa
                       JOIN admin_users u ON pa.admin_id = u.id
                       JOIN admin_roles r ON pa.role_id = r.id
                       WHERE pa.platform_id = p.id AND u.deleted_at IS NULL
                     )
                   )
                 ) FILTER (WHERE p.id IS NOT NULL),
                 '[]'::json
               ) as platforms,
               COUNT(p.id) as "platformCount"
        FROM admin_countries c
        LEFT JOIN admin_platforms p ON p.country_id = c.id
        WHERE c.id = $1
        GROUP BY c.id;
      `;
      const res = await query(sql, [idNum]);
      return shapeCountryRow(res.rows[0]);
    }

    const c = await countries().findOne({ id: idNum });
    if (!c) return null;
    const platforms = await platformRepository.listAll();
    const linked = platforms.filter(p => {
      const pc = (p.country || '').toLowerCase();
      return pc && (pc === (c.name || '').toLowerCase() || pc === (c.code || '').toLowerCase());
    });
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      currency: c.currency || null,
      default_timezone: c.default_timezone || 'UTC',
      status: c.status || 'ACTIVE',
      platformCount: linked.length,
      platforms: linked.map(p => ({ id: p.id, name: p.name, code: p.code, status: p.status })),
      created_at: c.created_at || null,
      updated_at: c.updated_at || null
    };
  },

  async findByNameOrCode(name, code, excludeId = null) {
    if (isPostgres()) {
      const sql = `
        SELECT id, country_name, country_code 
        FROM admin_countries 
        WHERE (LOWER(country_name) = LOWER($1) OR UPPER(country_code) = UPPER($2))
          AND ($3::bigint IS NULL OR id != $3)
        LIMIT 1;
      `;
      const res = await query(sql, [String(name).trim(), String(code).trim(), excludeId ? Number(excludeId) : null]);
      return res.rows[0] ? shapeCountryRow(res.rows[0]) : null;
    }

    const filter = {
      $or: [{ name: exactCaseInsensitive(name) }, { code: String(code).toUpperCase() }]
    };
    const found = await countries().findOne(filter);
    return found && found.id !== excludeId ? found : null;
  },

  async create(data) {
    if (isPostgres()) {
      const sql = `
        INSERT INTO admin_countries (country_name, country_code, currency_code, timezone, status, created_at, updated_at)
        VALUES ($1, UPPER($2), $3, $4, $5, NOW(), NOW())
        RETURNING id, country_name, country_code, currency_code, timezone, status, created_at, updated_at;
      `;
      const res = await query(sql, [
        data.name.trim(),
        data.code.trim().toUpperCase(),
        data.currency ? data.currency.trim().toUpperCase() : null,
        data.default_timezone || 'UTC',
        data.status || 'ACTIVE'
      ]);
      return shapeCountryRow({ ...res.rows[0], platforms: [], platformCount: 0 });
    }

    const now = new Date();
    const doc = {
      id: await nextSequence(COLLECTIONS.countries),
      name: data.name,
      code: data.code,
      currency: data.currency || null,
      default_timezone: data.default_timezone || 'UTC',
      status: data.status || 'ACTIVE',
      created_at: now,
      updated_at: now
    };
    await countries().insertOne(doc);
    return { ...doc, platformCount: 0, platforms: [] };
  },

  async update(id, fields) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const setClauses = ['updated_at = NOW()'];
      const params = [idNum];

      if (fields.name !== undefined) {
        params.push(fields.name.trim());
        setClauses.push(`country_name = $${params.length}`);
      }
      if (fields.code !== undefined) {
        params.push(fields.code.trim().toUpperCase());
        setClauses.push(`country_code = $${params.length}`);
      }
      if (fields.currency !== undefined) {
        params.push(fields.currency ? fields.currency.trim().toUpperCase() : null);
        setClauses.push(`currency_code = $${params.length}`);
      }
      if (fields.default_timezone !== undefined) {
        params.push(fields.default_timezone.trim());
        setClauses.push(`timezone = $${params.length}`);
      }
      if (fields.status !== undefined) {
        params.push(fields.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');
        setClauses.push(`status = $${params.length}`);
      }

      await query(`UPDATE admin_countries SET ${setClauses.join(', ')} WHERE id = $1;`, params);
      return this.findById(idNum);
    }

    await countries().updateOne({ id: idNum }, { $set: { ...fields, updated_at: new Date() } });
    return this.findById(idNum);
  },

  async delete(id) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`DELETE FROM admin_countries WHERE id = $1;`, [idNum]);
      return;
    }
    await countries().deleteOne({ id: idNum });
  },

  async deactivate(id) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_countries SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1;`, [idNum]);
      return;
    }
    await countries().updateOne({ id: idNum }, { $set: { status: 'INACTIVE', updated_at: new Date() } });
  }
};
