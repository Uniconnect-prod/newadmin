import pg from 'pg';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;

export async function verifyMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  console.log('\n======================================================');
  console.log('       RELATIONAL SCHEMA VERIFICATION REPORT');
  console.log('======================================================\n');

  try {
    const tables = [
      'admin_users',
      'admin_roles',
      'admin_user_roles',
      'admin_countries',
      'admin_platforms',
      'admin_platform_access',
      'platform_api_credentials',
      'platform_api_key_values',
      'admin_refresh_tokens',
      'admin_audit_logs',
      'admin_integration_logs',
      'admin_settings',
      'admin_counters'
    ];

    console.log('--- 1. Table Existence & Row Counts ---');
    for (const t of tables) {
      const res = await client.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = $1
      `, [t]);
      if (parseInt(res.rows[0].count, 10) === 0) {
        console.error(`[MISSING] Table ${t} does not exist!`);
      } else {
        const cntRes = await client.query(`SELECT COUNT(*) FROM "${t}"`);
        console.log(`[OK] ${t.padEnd(28)} : ${cntRes.rows[0].count} rows`);
      }
    }

    console.log('\n--- 2. Foreign Key References Integrity ---');
    const fkQueries = [
      {
        description: 'admin_platforms.country_id -> admin_countries.id',
        sql: `SELECT COUNT(*) FROM admin_platforms p LEFT JOIN admin_countries c ON p.country_id = c.id WHERE p.country_id IS NOT NULL AND c.id IS NULL`
      },
      {
        description: 'admin_user_roles.admin_id -> admin_users.id',
        sql: `SELECT COUNT(*) FROM admin_user_roles ur LEFT JOIN admin_users u ON ur.admin_id = u.id WHERE u.id IS NULL`
      },
      {
        description: 'admin_user_roles.role_id -> admin_roles.id',
        sql: `SELECT COUNT(*) FROM admin_user_roles ur LEFT JOIN admin_roles r ON ur.role_id = r.id WHERE r.id IS NULL`
      },
      {
        description: 'admin_platform_access.admin_id -> admin_users.id',
        sql: `SELECT COUNT(*) FROM admin_platform_access pa LEFT JOIN admin_users u ON pa.admin_id = u.id WHERE u.id IS NULL`
      },
      {
        description: 'admin_platform_access.platform_id -> admin_platforms.id',
        sql: `SELECT COUNT(*) FROM admin_platform_access pa LEFT JOIN admin_platforms p ON pa.platform_id = p.id WHERE p.id IS NULL`
      },
      {
        description: 'admin_platform_access.role_id -> admin_roles.id',
        sql: `SELECT COUNT(*) FROM admin_platform_access pa LEFT JOIN admin_roles r ON pa.role_id = r.id WHERE r.id IS NULL`
      },
      {
        description: 'platform_api_credentials.platform_id -> admin_platforms.id',
        sql: `SELECT COUNT(*) FROM platform_api_credentials pac LEFT JOIN admin_platforms p ON pac.platform_id = p.id WHERE p.id IS NULL`
      },
      {
        description: 'platform_api_key_values.credential_id -> platform_api_credentials.id',
        sql: `SELECT COUNT(*) FROM platform_api_key_values pakv LEFT JOIN platform_api_credentials pac ON pakv.credential_id = pac.id WHERE pac.id IS NULL`
      },
      {
        description: 'admin_refresh_tokens.user_id -> admin_users.id',
        sql: `SELECT COUNT(*) FROM admin_refresh_tokens rt LEFT JOIN admin_users u ON rt.user_id = u.id WHERE u.id IS NULL`
      }
    ];

    for (const q of fkQueries) {
      const res = await client.query(q.sql);
      const invalid = parseInt(res.rows[0].count, 10);
      if (invalid === 0) {
        console.log(`[PASS] ${q.description}`);
      } else {
        console.error(`[FAIL] ${q.description}: Found ${invalid} orphaned rows!`);
      }
    }

    console.log('\n--- 3. Check Constraints Integrity ---');
    const constraintQueries = [
      {
        description: 'admin_users status IN (ACTIVE, INACTIVE, SUSPENDED)',
        sql: `SELECT COUNT(*) FROM admin_users WHERE status NOT IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')`
      },
      {
        description: 'admin_countries status IN (ACTIVE, INACTIVE)',
        sql: `SELECT COUNT(*) FROM admin_countries WHERE status NOT IN ('ACTIVE', 'INACTIVE')`
      },
      {
        description: 'admin_platforms status IN (DRAFT, ACTIVE, DISABLED, INACTIVE)',
        sql: `SELECT COUNT(*) FROM admin_platforms WHERE status NOT IN ('DRAFT', 'ACTIVE', 'DISABLED', 'INACTIVE')`
      },
      {
        description: 'admin_platform_access status IN (ACTIVE, REVOKED, EXPIRED)',
        sql: `SELECT COUNT(*) FROM admin_platform_access WHERE status NOT IN ('ACTIVE', 'REVOKED', 'EXPIRED')`
      },
      {
        description: 'admin_platform_access start_date <= end_date',
        sql: `SELECT COUNT(*) FROM admin_platform_access WHERE start_date > end_date`
      }
    ];

    for (const q of constraintQueries) {
      const res = await client.query(q.sql);
      const invalid = parseInt(res.rows[0].count, 10);
      if (invalid === 0) {
        console.log(`[PASS] ${q.description}`);
      } else {
        console.error(`[FAIL] ${q.description}: Found ${invalid} violating rows!`);
      }
    }

    console.log('\n--- 4. Uniqueness Checks ---');
    const uniqueChecks = [
      { description: 'Unique usernames', sql: `SELECT username, COUNT(*) FROM admin_users GROUP BY username HAVING COUNT(*) > 1` },
      { description: 'Unique emails', sql: `SELECT email, COUNT(*) FROM admin_users GROUP BY email HAVING COUNT(*) > 1` },
      { description: 'Unique country codes', sql: `SELECT country_code, COUNT(*) FROM admin_countries GROUP BY country_code HAVING COUNT(*) > 1` },
      { description: 'Unique platform codes', sql: `SELECT platform_code, COUNT(*) FROM admin_platforms GROUP BY platform_code HAVING COUNT(*) > 1` },
      { description: 'Unique refresh token jti', sql: `SELECT jti, COUNT(*) FROM admin_refresh_tokens GROUP BY jti HAVING COUNT(*) > 1` },
      { description: 'Unique platform access per user & platform', sql: `SELECT admin_id, platform_id, COUNT(*) FROM admin_platform_access GROUP BY admin_id, platform_id HAVING COUNT(*) > 1` }
    ];

    for (const q of uniqueChecks) {
      const res = await client.query(q.sql);
      if (res.rows.length === 0) {
        console.log(`[PASS] ${q.description}`);
      } else {
        console.error(`[FAIL] ${q.description}: Found duplicates!`, res.rows);
      }
    }

    console.log('\n--- 5. Legacy Tables Status ---');
    const legacyRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE 'legacy_%' OR table_name LIKE 'snapshot_%'
      ORDER BY table_name;
    `);
    console.log('Legacy & Snapshot backup tables preserved:', legacyRes.rows.map(r => r.table_name).join(', '));

    console.log('\n======================================================');
    console.log('           VERIFICATION REPORT COMPLETE');
    console.log('======================================================\n');
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('verify-migration.js')) {
  verifyMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
