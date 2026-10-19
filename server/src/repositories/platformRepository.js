import { col, COLLECTIONS, isPostgres, query, nextSequence } from '../store/index.js';
import { exactCaseInsensitive } from '../utils/errors.js';
import { credentialRepository } from './credentialRepository.js';

export const REPORTING_MODULES = ['overview', 'settlement', 'revenue', 'subscribers', 'renewals', 'churn', 'subscriber_records'];

const LEGACY_MODULE_MAP = {
  Subscribers: ['subscribers', 'subscriber_records'],
  Renewals: ['renewals'],
  Churn: ['churn'],
  Revenue: ['revenue'],
  Reports: ['overview', 'settlement']
};

export function normalizeModules(modules) {
  if (!Array.isArray(modules)) return ['overview', 'settlement'];
  const out = new Set();
  for (const m of modules) {
    if (REPORTING_MODULES.includes(m)) out.add(m);
    else if (LEGACY_MODULE_MAP[m]) LEGACY_MODULE_MAP[m].forEach(x => out.add(x));
  }
  out.add('overview');
  return REPORTING_MODULES.filter(m => out.has(m));
}

export function normalizeStatus(status) {
  if (status === 'ACTIVE') return 'ACTIVE';
  if (status === 'DISABLED' || status === 'INACTIVE') return 'DISABLED';
  return 'DRAFT';
}

function platforms() {
  return col(COLLECTIONS.platforms);
}

function shapePlatform(row) {
  if (!row) return null;
  const secrets = row.integration_secrets || {};
  return {
    id: Number(row.id),
    code: row.platform_code || row.code,
    name: row.platform_name || row.name,
    description: row.description || '',
    logo_url: row.logo_url || '',
    accent_color: row.accent_color || '#2A58FF',
    country: row.country_name || row.country || null,
    country_id: row.country_id ? Number(row.country_id) : null,
    country_code: row.country_code || null,
    business_timezone: row.business_timezone || 'UTC',
    currency: row.currency || row.currency_code || null,
    enabled_modules: normalizeModules(row.enabled_modules),
    status: normalizeStatus(row.status),
    integration: row.integration || null,
    integration_secrets: secrets,
    published_integration: row.published_integration || null,
    published_config_hash: row.published_config_hash || null,
    published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    published_by: row.published_by ? Number(row.published_by) : null,
    validation: row.validation || { status: 'NOT_RUN' },
    integration_health: row.integration_health || {},
    config_version: Number(row.config_version || 1),
    created_by: row.created_by ? Number(row.created_by) : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

/**
 * Explicit allow-list projection for Super Admin views. Secrets and legacy database
 * connection strings are never included.
 */
export function toAdminView(p) {
  if (!p) return null;
  const secrets = p.integration_secrets || {};
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description || '',
    logo_url: p.logo_url || '',
    accent_color: p.accent_color || '#2A58FF',
    country: p.country || null,
    country_id: p.country_id || null,
    business_timezone: p.business_timezone || 'UTC',
    currency: p.currency || null,
    enabled_modules: normalizeModules(p.enabled_modules),
    status: normalizeStatus(p.status),
    integration: p.integration || null,
    secrets_configured: {
      token: Boolean(secrets.token),
      api_key: Boolean(secrets.api_key),
      username: Boolean(secrets.username),
      password: Boolean(secrets.password)
    },
    secrets_updated_at: secrets.updated_at || null,
    published: p.published_integration
      ? {
          at: p.published_at || null,
          by: p.published_by || null,
          config_hash: p.published_config_hash || null
        }
      : null,
    validation: p.validation || { status: 'NOT_RUN' },
    integration_health: p.integration_health || null,
    legacy_source: null,
    config_version: p.config_version || 1,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null
  };
}

export const platformRepository = {
  async findByIdOrCode(idOrCode, { raw = true } = {}) {
    if (idOrCode === undefined || idOrCode === null || idOrCode === '') return null;
    const str = String(idOrCode).trim();

    if (isPostgres()) {
      const isNum = /^\d+$/.test(str);
      const sql = `
        SELECT p.id, p.platform_name, p.platform_code, p.country_id,
               c.country_name, c.country_code,
               p.status, p.description, p.logo_url, p.accent_color, p.business_timezone,
               COALESCE(p.currency, c.currency_code) as currency,
               p.enabled_modules, p.config_version, p.integration, p.published_integration,
               p.published_config_hash, p.published_at, p.published_by, p.validation,
               p.integration_health, p.created_by, p.created_at, p.updated_at,
               COALESCE(
                 (
                   SELECT jsonb_object_agg(pac.credential_name, pac.encrypted_value)
                   FROM platform_api_credentials pac
                   WHERE pac.platform_id = p.id
                 ),
                 '{}'::jsonb
               ) as integration_secrets
        FROM admin_platforms p
        LEFT JOIN admin_countries c ON p.country_id = c.id
        WHERE UPPER(p.platform_code) = UPPER($1) ${isNum ? 'OR p.id = $2' : ''}
        LIMIT 1;
      `;
      const params = isNum ? [str, Number(str)] : [str];
      const res = await query(sql, params);
      const doc = shapePlatform(res.rows[0]);
      return raw ? doc : toAdminView(doc);
    }

    const or = [{ code: exactCaseInsensitive(str) }];
    if (/^\d+$/.test(str)) or.push({ id: parseInt(str, 10) });
    const doc = await platforms().findOne({ $or: or });
    return raw ? doc : toAdminView(doc);
  },

  async findById(id) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const sql = `
        SELECT p.id, p.platform_name, p.platform_code, p.country_id,
               c.country_name, c.country_code,
               p.status, p.description, p.logo_url, p.accent_color, p.business_timezone,
               COALESCE(p.currency, c.currency_code) as currency,
               p.enabled_modules, p.config_version, p.integration, p.published_integration,
               p.published_config_hash, p.published_at, p.published_by, p.validation,
               p.integration_health, p.created_by, p.created_at, p.updated_at,
               COALESCE(
                 (
                   SELECT jsonb_object_agg(pac.credential_name, pac.encrypted_value)
                   FROM platform_api_credentials pac
                   WHERE pac.platform_id = p.id
                 ),
                 '{}'::jsonb
               ) as integration_secrets
        FROM admin_platforms p
        LEFT JOIN admin_countries c ON p.country_id = c.id
        WHERE p.id = $1;
      `;
      const res = await query(sql, [idNum]);
      return shapePlatform(res.rows[0]);
    }

    return platforms().findOne({ id: idNum });
  },

  async listAll() {
    if (isPostgres()) {
      const sql = `
        SELECT p.id, p.platform_name, p.platform_code, p.country_id,
               c.country_name, c.country_code,
               p.status, p.description, p.logo_url, p.accent_color, p.business_timezone,
               COALESCE(p.currency, c.currency_code) as currency,
               p.enabled_modules, p.config_version, p.integration, p.published_integration,
               p.published_config_hash, p.published_at, p.published_by, p.validation,
               p.integration_health, p.created_by, p.created_at, p.updated_at,
               COALESCE(
                 (
                   SELECT jsonb_object_agg(pac.credential_name, pac.encrypted_value)
                   FROM platform_api_credentials pac
                   WHERE pac.platform_id = p.id
                 ),
                 '{}'::jsonb
               ) as integration_secrets
        FROM admin_platforms p
        LEFT JOIN admin_countries c ON p.country_id = c.id
        ORDER BY p.id ASC;
      `;
      const res = await query(sql);
      return res.rows.map(shapePlatform);
    }

    return platforms().find({}).sort({ id: 1 }).toArray();
  },

  async listActive() {
    const all = await this.listAll();
    return all.filter(p => normalizeStatus(p.status) === 'ACTIVE');
  },

  async create(data, createdBy) {
    const code = String(data.code).trim().toUpperCase();

    if (isPostgres()) {
      // Check duplicate code
      const dup = await query(`SELECT id FROM admin_platforms WHERE UPPER(platform_code) = UPPER($1);`, [code]);
      if (dup.rows.length > 0) {
        const err = new Error(`A platform with code '${code}' already exists.`);
        err.code = 'DUPLICATE_CODE';
        throw err;
      }

      // Resolve country_id
      let countryId = data.country_id ? Number(data.country_id) : null;
      if (!countryId && data.country) {
        const cRes = await query(
          `SELECT id FROM admin_countries WHERE LOWER(country_name) = LOWER($1) OR UPPER(country_code) = UPPER($1) LIMIT 1;`,
          [String(data.country).trim()]
        );
        if (cRes.rows[0]) countryId = Number(cRes.rows[0].id);
      }

      const sql = `
        INSERT INTO admin_platforms (
          platform_name, platform_code, country_id, status, description, logo_url,
          accent_color, business_timezone, currency, enabled_modules, config_version,
          integration, validation, integration_health, created_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'DRAFT', $4, $5,
          $6, $7, $8, $9, 1,
          $10, '{"status": "NOT_RUN"}'::jsonb, '{}'::jsonb, $11, NOW(), NOW()
        )
        RETURNING id;
      `;
      const res = await query(sql, [
        data.name,
        code,
        countryId,
        data.description || '',
        data.logo_url || '',
        data.accent_color || '#2A58FF',
        data.business_timezone || 'UTC',
        data.currency || null,
        JSON.stringify(normalizeModules(data.enabled_modules)),
        data.integration ? JSON.stringify(data.integration) : null,
        createdBy ? parseInt(createdBy, 10) : null
      ]);

      const createdId = Number(res.rows[0].id);

      // Initialize credentials entry
      if (data.integration) {
        await credentialRepository.syncPlatformCredentials(createdId, {
          authType: data.integration.auth?.type || 'none',
          baseUrl: data.integration.base_url || ''
        });
      }

      return this.findById(createdId);
    }

    const existing = await platforms().findOne({ code: exactCaseInsensitive(code) });
    if (existing) {
      const err = new Error(`A platform with code '${code}' already exists.`);
      err.code = 'DUPLICATE_CODE';
      throw err;
    }
    const now = new Date();
    const doc = {
      id: await nextSequence(COLLECTIONS.platforms),
      code,
      name: data.name,
      description: data.description || '',
      logo_url: data.logo_url || '',
      accent_color: data.accent_color || '#2A58FF',
      country: data.country || null,
      business_timezone: data.business_timezone || 'UTC',
      currency: data.currency || null,
      enabled_modules: normalizeModules(data.enabled_modules),
      status: 'DRAFT',
      integration: data.integration || null,
      integration_secrets: {},
      published_integration: null,
      validation: { status: 'NOT_RUN' },
      integration_health: {},
      config_version: 1,
      created_by: createdBy,
      created_at: now,
      updated_at: now
    };
    await platforms().insertOne(doc);
    return doc;
  },

  async updateDetails(id, fields) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      const setClauses = ['updated_at = NOW()'];
      const params = [idNum];

      if (fields.name !== undefined) {
        params.push(fields.name);
        setClauses.push(`platform_name = $${params.length}`);
      }
      if (fields.description !== undefined) {
        params.push(fields.description || '');
        setClauses.push(`description = $${params.length}`);
      }
      if (fields.logo_url !== undefined) {
        params.push(fields.logo_url || '');
        setClauses.push(`logo_url = $${params.length}`);
      }
      if (fields.accent_color !== undefined) {
        params.push(fields.accent_color || '#2A58FF');
        setClauses.push(`accent_color = $${params.length}`);
      }
      if (fields.country_id !== undefined) {
        params.push(fields.country_id ? Number(fields.country_id) : null);
        setClauses.push(`country_id = $${params.length}`);
      } else if (fields.country !== undefined) {
        let cid = null;
        if (fields.country) {
          const cRes = await query(
            `SELECT id FROM admin_countries WHERE LOWER(country_name) = LOWER($1) OR UPPER(country_code) = UPPER($1) LIMIT 1;`,
            [String(fields.country).trim()]
          );
          if (cRes.rows[0]) cid = Number(cRes.rows[0].id);
        }
        params.push(cid);
        setClauses.push(`country_id = $${params.length}`);
      }
      if (fields.business_timezone !== undefined) {
        params.push(fields.business_timezone || 'UTC');
        setClauses.push(`business_timezone = $${params.length}`);
      }
      if (fields.currency !== undefined) {
        params.push(fields.currency || null);
        setClauses.push(`currency = $${params.length}`);
      }
      if (fields.enabled_modules !== undefined) {
        params.push(JSON.stringify(normalizeModules(fields.enabled_modules)));
        setClauses.push(`enabled_modules = $${params.length}::jsonb`);
      }

      await query(`UPDATE admin_platforms SET ${setClauses.join(', ')} WHERE id = $1;`, params);
      return this.findById(idNum);
    }

    const allowed = ['name', 'description', 'logo_url', 'accent_color', 'country', 'business_timezone', 'currency'];
    const set = { updated_at: new Date() };
    for (const key of allowed) if (fields[key] !== undefined) set[key] = fields[key];
    if (fields.enabled_modules !== undefined) set.enabled_modules = normalizeModules(fields.enabled_modules);
    await platforms().updateOne({ id: idNum }, { $set: set });
    return this.findById(idNum);
  },

  async saveIntegrationDraft(id, integration) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      await query(
        `UPDATE admin_platforms
         SET integration = $2, config_version = config_version + 1, updated_at = NOW()
         WHERE id = $1;`,
        [idNum, JSON.stringify(integration)]
      );

      await credentialRepository.syncPlatformCredentials(idNum, {
        authType: integration.auth?.type || 'none',
        baseUrl: integration.base_url || ''
      });

      return this.findById(idNum);
    }

    await platforms().updateOne(
      { id: idNum },
      { $set: { integration, updated_at: new Date() }, $inc: { config_version: 1 } }
    );
    return this.findById(idNum);
  },

  async saveSecrets(id, secrets) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return null;

    if (isPostgres()) {
      // Sync into relational platform_api_key_values
      const p = await this.findById(idNum);
      const authType = p?.integration?.auth?.type || 'none';
      const baseUrl = p?.integration?.base_url || '';

      await credentialRepository.syncPlatformCredentials(idNum, {
        authType,
        baseUrl,
        secrets
      });

      await query(
        `UPDATE admin_platforms SET config_version = config_version + 1, updated_at = NOW() WHERE id = $1;`,
        [idNum]
      );
      return this.findById(idNum);
    }

    await platforms().updateOne(
      { id: idNum },
      { $set: { integration_secrets: { ...secrets, updated_at: new Date() }, updated_at: new Date() }, $inc: { config_version: 1 } }
    );
    return this.findById(idNum);
  },

  async saveValidation(id, validation) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_platforms SET validation = $2, updated_at = NOW() WHERE id = $1;`, [idNum, JSON.stringify(validation)]);
      return;
    }
    await platforms().updateOne({ id: idNum }, { $set: { validation, updated_at: new Date() } });
  },

  async publish(id, { integration, configHash, userId }) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(
        `UPDATE admin_platforms
         SET status = 'ACTIVE',
             published_integration = $2,
             published_config_hash = $3,
             published_at = NOW(),
             published_by = $4,
             updated_at = NOW()
         WHERE id = $1;`,
        [idNum, JSON.stringify(integration), configHash, userId ? Number(userId) : null]
      );
      return this.findById(idNum);
    }

    const now = new Date();
    await platforms().updateOne(
      { id: idNum },
      {
        $set: {
          status: 'ACTIVE',
          published_integration: integration,
          published_config_hash: configHash,
          published_at: now,
          published_by: userId,
          updated_at: now
        }
      }
    );
    return this.findById(idNum);
  },

  async setStatus(id, status) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(`UPDATE admin_platforms SET status = $2, updated_at = NOW() WHERE id = $1;`, [idNum, status]);
      return this.findById(idNum);
    }
    await platforms().updateOne({ id: idNum }, { $set: { status, updated_at: new Date() } });
    return this.findById(idNum);
  },

  async recordHealth(id, health) {
    const idNum = parseInt(id, 10);
    if (isPostgres()) {
      await query(
        `UPDATE admin_platforms 
         SET integration_health = COALESCE(integration_health, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
         WHERE id = $1;`,
        [idNum, JSON.stringify(health)]
      );
      return;
    }
    const set = {};
    for (const [k, v] of Object.entries(health)) set[`integration_health.${k}`] = v;
    await platforms().updateOne({ id: idNum }, { $set: set });
  },

  async delete(id) {
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum)) return false;

    if (isPostgres()) {
      // Foreign keys with CASCADE will automatically remove platform_api_credentials,
      // platform_api_key_values, and admin_platform_access!
      await query(`DELETE FROM admin_platforms WHERE id = $1;`, [idNum]);
      await query(`DELETE FROM admin_integration_logs WHERE platform_id = $1;`, [idNum]);
      return true;
    }

    await platforms().deleteOne({ id: idNum });
    await col(COLLECTIONS.access).deleteMany({ platform_id: idNum });
    await col(COLLECTIONS.integrationLogs).deleteMany({ platform_id: idNum });
    return true;
  }
};
