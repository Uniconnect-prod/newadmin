import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;

export async function runMigration({ connectionString = process.env.DATABASE_URL } = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  console.log('\n======================================================');
  console.log('       POSTGRESQL RELATIONAL SCHEMA MIGRATION');
  console.log('======================================================\n');

  try {
    // 1. Check current tables
    const preTablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    const existingTableNames = preTablesRes.rows.map(r => r.table_name);
    console.log('[1/5] Pre-migration check: Detected tables:', existingTableNames.join(', '));

    // Record pre-migration counts
    const coreTables = [
      'admin_users',
      'admin_roles',
      'admin_countries',
      'admin_platforms',
      'admin_platform_access',
      'admin_refresh_tokens',
      'admin_audit_logs',
      'admin_integration_logs',
      'admin_counters',
      'admin_settings'
    ];

    const preCounts = {};
    for (const t of coreTables) {
      if (existingTableNames.includes(t)) {
        const c = await client.query(`SELECT COUNT(*) FROM "${t}"`);
        preCounts[t] = parseInt(c.rows[0].count, 10);
      } else {
        preCounts[t] = 0;
      }
    }
    console.log('[1/5] Pre-migration record counts:', preCounts);

    // 2. Execute 001_relational_schema.sql
    console.log('\n[2/5] Executing 001_relational_schema.sql (Creating normalized tables and snapshotting legacy data)...');
    const sql001 = fs.readFileSync(path.resolve(__dirname, '../migrations/001_relational_schema.sql'), 'utf8');
    await client.query(sql001);
    console.log('[2/5] 001_relational_schema.sql executed successfully.');

    // 3. Execute 002_data_migration.sql
    console.log('\n[3/5] Executing 002_data_migration.sql (Migrating data into normalized columns)...');
    const sql002 = fs.readFileSync(path.resolve(__dirname, '../migrations/002_data_migration.sql'), 'utf8');
    await client.query(sql002);
    console.log('[3/5] 002_data_migration.sql executed successfully.');

    // 4. Verification queries
    console.log('\n[4/5] Running verification checks...');
    const postCounts = {};
    for (const t of coreTables) {
      const c = await client.query(`SELECT COUNT(*) FROM "${t}"`);
      postCounts[t] = parseInt(c.rows[0].count, 10);
    }

    const credCount = (await client.query('SELECT COUNT(*) FROM platform_api_credentials')).rows[0].count;
    const credKeyCount = (await client.query('SELECT COUNT(*) FROM platform_api_key_values')).rows[0].count;
    const userRoleCount = (await client.query('SELECT COUNT(*) FROM admin_user_roles')).rows[0].count;

    console.log('[4/5] Post-migration record counts:', postCounts);
    console.log(`[4/5] Child relational tables:`);
    console.log(`      - platform_api_credentials: ${credCount}`);
    console.log(`      - platform_api_key_values: ${credKeyCount}`);
    console.log(`      - admin_user_roles: ${userRoleCount}`);

    // Verify foreign key integrity
    const fkChecks = [
      {
        name: 'Platform -> Country FK',
        query: `SELECT COUNT(*) FROM admin_platforms p LEFT JOIN admin_countries c ON p.country_id = c.id WHERE p.country_id IS NOT NULL AND c.id IS NULL`
      },
      {
        name: 'Platform Access -> User FK',
        query: `SELECT COUNT(*) FROM admin_platform_access a LEFT JOIN admin_users u ON a.admin_id = u.id WHERE u.id IS NULL`
      },
      {
        name: 'Platform Access -> Platform FK',
        query: `SELECT COUNT(*) FROM admin_platform_access a LEFT JOIN admin_platforms p ON a.platform_id = p.id WHERE p.id IS NULL`
      },
      {
        name: 'Platform Access -> Role FK',
        query: `SELECT COUNT(*) FROM admin_platform_access a LEFT JOIN admin_roles r ON a.role_id = r.id WHERE r.id IS NULL`
      },
      {
        name: 'Refresh Tokens -> User FK',
        query: `SELECT COUNT(*) FROM admin_refresh_tokens t LEFT JOIN admin_users u ON t.user_id = u.id WHERE u.id IS NULL`
      },
      {
        name: 'Credentials -> Platform FK',
        query: `SELECT COUNT(*) FROM platform_api_credentials c LEFT JOIN admin_platforms p ON c.platform_id = p.id WHERE p.id IS NULL`
      }
    ];

    let allFkPassed = true;
    for (const check of fkChecks) {
      const res = await client.query(check.query);
      const invalid = parseInt(res.rows[0].count, 10);
      if (invalid > 0) {
        console.error(`      FAIL: ${check.name} found ${invalid} orphaned records!`);
        allFkPassed = false;
      } else {
        console.log(`      PASS: ${check.name} - 100% integrity`);
      }
    }

    // Verify passwords, emails, usernames preserved
    const sampleUsers = await client.query(`
      SELECT id, username, email, status, is_super_admin, 
             (password_hash IS NOT NULL AND LENGTH(password_hash) > 20) as has_password,
             (backup_password_hash IS NOT NULL) as has_backup_pw
      FROM admin_users 
      ORDER BY id
    `);
    console.log('\n[4/5] Migrated Users preview:');
    console.table(sampleUsers.rows);

    // Verify platform-country relation
    const platformsWithCountries = await client.query(`
      SELECT p.id, p.platform_name, p.platform_code, p.status, c.country_name, c.country_code, c.currency_code
      FROM admin_platforms p
      LEFT JOIN admin_countries c ON p.country_id = c.id
    `);
    console.log('[4/5] Migrated Platforms with Country FK preview:');
    console.table(platformsWithCountries.rows);

    // Verify platform credentials
    const credentials = await client.query(`
      SELECT c.id, c.platform_id, p.platform_code, c.auth_type, c.api_base_url, c.status
      FROM platform_api_credentials c
      JOIN admin_platforms p ON c.platform_id = p.id
    `);
    console.log('[4/5] Migrated Platform API Credentials preview:');
    console.table(credentials.rows);

    if (!allFkPassed) {
      throw new Error('Migration verification failed: Foreign key violations detected.');
    }

    console.log('\n[5/5] Migration completed and verified successfully!');
    return { preCounts, postCounts, allFkPassed: true };
  } catch (err) {
    console.error('\n Migration error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// If run directly from CLI
if (process.argv[1] && process.argv[1].endsWith('run-migration.js')) {
  runMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
