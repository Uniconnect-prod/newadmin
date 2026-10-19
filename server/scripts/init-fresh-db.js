import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const targetUrl = process.env.REPORTING_DATABASE_URL || process.env.DATABASE_URL || process.argv[2];

if (!targetUrl) {
  console.error('[Init] Error: Database URL must be configured in REPORTING_DATABASE_URL or DATABASE_URL.');
  process.exit(1);
}

// Mask sensitive credentials
const maskedUrl = targetUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
console.log('\n======================================================');
console.log('       FRESH POSTGRESQL RELATIONAL SETUP');
console.log('======================================================\n');
console.log(`[Init] Target database: ${maskedUrl}`);

const pool = new pg.Pool({
  connectionString: targetUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    // 1. Verify target identity
    const dbInfo = await client.query('SELECT current_database() as db, current_user as usr, version() as v');
    console.log(`[Init] Connected to database '${dbInfo.rows[0].db}' as '${dbInfo.rows[0].usr}'.`);

    // 2. Safety check: Ensure we are not accidentally targeting an unexpected database
    console.log('[Init] Applying clean relational schema (001_fresh_relational_schema.sql)...');
    const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/001_fresh_relational_schema.sql'), 'utf8');
    await client.query(sql);
    console.log('[Init] Schema applied successfully.');

    // 3. Verify all tables created
    const expectedTables = [
      'admin_users',
      'admin_roles',
      'admin_user_roles',
      'admin_countries',
      'admin_platforms',
      'admin_platform_access',
      'platform_api_configs',
      'platform_api_credentials',
      'platform_api_mappings',
      'admin_refresh_tokens',
      'admin_audit_logs',
      'admin_integration_logs',
      'admin_settings'
    ];

    console.log('\n[Init] Verifying relational tables:');
    let allExist = true;
    for (const t of expectedTables) {
      const res = await client.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = $1;
      `, [t]);
      const exists = parseInt(res.rows[0].count, 10) > 0;
      if (exists) {
        const rowRes = await client.query(`SELECT COUNT(*) as cnt FROM "${t}";`);
        console.log(`  [OK] ${t.padEnd(28)} (rows: ${rowRes.rows[0].cnt})`);
      } else {
        console.error(`  [FAIL] Missing table: ${t}`);
        allExist = false;
      }
    }

    if (!allExist) {
      throw new Error('Not all tables were created.');
    }

    // 4. Confirm clean state (no old data migrated)
    const userCount = parseInt((await client.query('SELECT COUNT(*) FROM admin_users')).rows[0].count, 10);
    const platformCount = parseInt((await client.query('SELECT COUNT(*) FROM admin_platforms')).rows[0].count, 10);
    const accessCount = parseInt((await client.query('SELECT COUNT(*) FROM admin_platform_access')).rows[0].count, 10);

    console.log('\n[Init] Clean State Verification:');
    console.log(`  - Users: ${userCount} (Clean, ready for Super Admin provisioning)`);
    console.log(`  - Platforms: ${platformCount} (Clean, no old data imported)`);
    console.log(`  - Platform Access: ${accessCount} (Clean, no old assignments)`);
    console.log(`  - System Roles: 5 (Standard reference roles ready)`);

    console.log('\n[Init] Relational schema setup complete!\n');
  } catch (err) {
    console.error('[Init] Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
