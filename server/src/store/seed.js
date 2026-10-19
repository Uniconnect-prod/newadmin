import bcrypt from 'bcryptjs';
import { col, COLLECTIONS, isPostgres, query, nextSequence } from './index.js';
import { config } from '../config/index.js';

export const DEFAULT_ROLES = [
  { id: 1, name: 'Super Admin', role_name: 'Super Admin', description: 'All platforms, platform configuration, user administration and audit logs', permissions: ['*'] },
  { id: 2, name: 'Platform Admin', role_name: 'Platform Admin', description: 'Full reporting access to assigned platforms, exports and read-only user list', permissions: ['platform:*', 'reports:*', 'users:read', 'exports:create'] },
  { id: 3, name: 'Author', role_name: 'Author', description: 'Reporting access to assigned platforms (legacy content role)', permissions: ['reports:read', 'content:*'] },
  { id: 4, name: 'Analyst', role_name: 'Analyst', description: 'Reporting and CSV export on assigned platforms', permissions: ['reports:read', 'exports:create'] },
  { id: 5, name: 'Viewer', role_name: 'Viewer', description: 'Read-only dashboards and reports on assigned platforms', permissions: ['reports:read'] }
];

const DEFAULT_COUNTRIES = [
  { id: 1, name: 'Ghana', country_name: 'Ghana', code: 'GH', country_code: 'GH', currency: 'GHS', currency_code: 'GHS', default_timezone: 'Africa/Accra', timezone: 'Africa/Accra' },
  { id: 2, name: 'Nigeria', country_name: 'Nigeria', code: 'NG', country_code: 'NG', currency: 'NGN', currency_code: 'NGN', default_timezone: 'Africa/Lagos', timezone: 'Africa/Lagos' },
  { id: 3, name: 'Kenya', country_name: 'Kenya', code: 'KE', country_code: 'KE', currency: 'KES', currency_code: 'KES', default_timezone: 'Africa/Nairobi', timezone: 'Africa/Nairobi' },
  { id: 4, name: 'Uganda', country_name: 'Uganda', code: 'UG', country_code: 'UG', currency: 'UGX', currency_code: 'UGX', default_timezone: 'Africa/Kampala', timezone: 'Africa/Kampala' },
  { id: 5, name: 'South Africa', country_name: 'South Africa', code: 'ZA', country_code: 'ZA', currency: 'ZAR', currency_code: 'ZAR', default_timezone: 'Africa/Johannesburg', timezone: 'Africa/Johannesburg' }
];

async function safeIndex(collection, spec, options) {
  try {
    await collection.createIndex(spec, options);
  } catch (err) {
    // Indexes are defined in SQL schema
  }
}

/**
 * Idempotent bootstrap of reference data. Never modifies existing users or platforms.
 */
export async function seedReferenceData({ log = !config.isTest } = {}) {
  if (isPostgres()) {
    // Check roles
    const roleCount = parseInt((await query('SELECT COUNT(*) as count FROM admin_roles')).rows[0].count, 10);
    if (roleCount === 0) {
      for (const r of DEFAULT_ROLES) {
        await query(
          `INSERT INTO admin_roles (id, role_name, description, permissions, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING;`,
          [r.id, r.role_name, r.description, JSON.stringify(r.permissions)]
        );
      }
      if (log) console.log('[Seed] Roles created.');
    }

    // Check countries
    const countryCount = parseInt((await query('SELECT COUNT(*) as count FROM admin_countries')).rows[0].count, 10);
    if (countryCount === 0) {
      for (const c of DEFAULT_COUNTRIES) {
        await query(
          `INSERT INTO admin_countries (id, country_name, country_code, currency_code, timezone, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), NOW())
           ON CONFLICT (country_code) DO NOTHING;`,
          [c.id, c.country_name, c.country_code, c.currency_code, c.timezone]
        );
      }
      if (log) console.log('[Seed] Country profiles created.');
    }

    // Always keep sequences aligned with current max IDs
    await query(`SELECT setval('admin_roles_id_seq', COALESCE((SELECT MAX(id) FROM admin_roles), 1));`);
    await query(`SELECT setval('admin_countries_id_seq', COALESCE((SELECT MAX(id) FROM admin_countries), 1));`);
    await query(`SELECT setval('admin_platforms_id_seq', COALESCE((SELECT MAX(id) FROM admin_platforms), 1));`);

    // Check users
    const userCount = parseInt((await query('SELECT COUNT(*) as count FROM admin_users')).rows[0].count, 10);
    if (userCount === 0) {
      const { username, email, name, password } = config.seedSuperAdmin;
      if (!password || password.length < 10) {
        console.warn('[Seed] No users exist. Set SEED_SUPER_ADMIN_PASSWORD (min 10 chars) to create the first Super Admin.');
        return;
      }
      const hash = await bcrypt.hash(password, 12);
      const res = await query(
        `INSERT INTO admin_users (name, email, username, password_hash, status, is_super_admin, created_at, updated_at)
         VALUES ($1, LOWER($2), $3, $4, 'ACTIVE', TRUE, NOW(), NOW())
         RETURNING id;`,
        [name, email, username, hash]
      );
      const newId = res.rows[0].id;
      await query(`INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, 1) ON CONFLICT DO NOTHING;`, [newId]);
      if (log) console.log(`[Seed] First Super Admin '${username}' created from SEED_SUPER_ADMIN_* settings.`);
    }
    return;
  }

  // Memory store fallback for unit testing
  const roles = col(COLLECTIONS.roles);
  if ((await roles.countDocuments({})) === 0) {
    await roles.insertMany(DEFAULT_ROLES);
    if (log) console.log('[Seed] Roles created.');
  }

  const countries = col(COLLECTIONS.countries);
  if ((await countries.countDocuments({})) === 0) {
    const now = new Date();
    await countries.insertMany(DEFAULT_COUNTRIES.map(c => ({ ...c, status: 'ACTIVE', created_at: now, updated_at: now })));
    if (log) console.log('[Seed] Country profiles created.');
  }

  const users = col(COLLECTIONS.users);
  await safeIndex(users, { username: 1 }, { unique: true });
  await safeIndex(users, { email: 1 }, { unique: true });
  await safeIndex(users, { id: 1 }, { unique: true });
  await safeIndex(col(COLLECTIONS.platforms), { id: 1 }, { unique: true });
  await safeIndex(col(COLLECTIONS.platforms), { code: 1 }, { unique: true });
  await safeIndex(col(COLLECTIONS.access), { user_id: 1, platform_id: 1 });
  await safeIndex(countries, { id: 1 }, { unique: true });
  await safeIndex(countries, { code: 1 }, { unique: true });
  await safeIndex(col(COLLECTIONS.audit), { created_at: -1 });
  await safeIndex(col(COLLECTIONS.refreshTokens), { jti: 1 }, { unique: true });
  await safeIndex(col(COLLECTIONS.integrationLogs), { platform_id: 1, created_at: -1 });

  if ((await users.countDocuments({})) === 0) {
    const { username, email, name, password } = config.seedSuperAdmin;
    if (!password || password.length < 10) {
      console.warn('[Seed] No users exist. Set SEED_SUPER_ADMIN_PASSWORD (min 10 chars) to create the first Super Admin.');
      return;
    }
    const now = new Date();
    const id = await nextSequence(COLLECTIONS.users);
    await users.insertOne({
      id,
      name,
      email,
      username,
      password_hash: await bcrypt.hash(password, 12),
      status: 'ACTIVE',
      is_super_admin: true,
      country: null,
      last_login_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null
    });
    if (log) console.log(`[Seed] First Super Admin '${username}' created from SEED_SUPER_ADMIN_* settings.`);
  }
}
