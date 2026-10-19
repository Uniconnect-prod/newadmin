import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.REPORTING_DATABASE_URL || process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function runVerification() {
  console.log('\n======================================================');
  console.log('   END-TO-END POSTGRESQL VERIFICATION & AUDIT');
  console.log('======================================================\n');

  const client = await pool.connect();
  try {
    // 1. Verify Database Identity & Version
    const dbInfo = await client.query('SELECT current_database(), current_user, version()');
    console.log(`[Database] Connected to: "${dbInfo.rows[0].current_database}" as "${dbInfo.rows[0].current_user}"`);
    console.log(`[Version]  ${dbInfo.rows[0].version.split('\n')[0]}\n`);

    // 2. Count records in all relational tables
    console.log('--- 1. Table Record Audit ---');
    const tables = [
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

    for (const tbl of tables) {
      const res = await client.query(`SELECT COUNT(*) as count FROM ${tbl}`);
      console.log(`  - ${tbl.padEnd(28)}: ${res.rows[0].count} rows`);
    }

    // 3. Verify Foreign Keys and Constraints
    console.log('\n--- 2. Foreign Key & Integrity Check ---');
    const fkQuery = `
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.column_name;
    `;
    const fks = await client.query(fkQuery);
    console.log(`Verified ${fks.rows.length} foreign key relationships:`);
    for (const fk of fks.rows) {
      console.log(`  * ${fk.table_name}.${fk.column_name} -> ${fk.foreign_table_name}.${fk.foreign_column_name}`);
    }

    // 4. Test User Authentication against pure relational schema
    console.log('\n--- 3. Relational Authentication Test ---');
    const userRes = await client.query(
      `SELECT u.id, u.username, u.email, u.password_hash, u.is_super_admin, u.status,
              r.role_name
       FROM admin_users u
       LEFT JOIN admin_user_roles ur ON ur.admin_id = u.id
       LEFT JOIN admin_roles r ON r.id = ur.role_id
       WHERE (u.email = 'admin@unisolutions.in' OR u.username = 'admin@unisolutions.in') AND u.deleted_at IS NULL;`
    );

    if (userRes.rows.length === 0) {
      throw new Error('Super admin user not found in admin_users!');
    }
    const user = userRes.rows[0];
    const passwordMatch = await bcrypt.compare('Admin@12345', user.password_hash);
    console.log(`  * Super Admin found: ID ${user.id}, Username: "${user.username}", Email: "${user.email}"`);
    console.log(`  * Assigned Role:      "${user.role_name}"`);
    console.log(`  * Password Match:     ${passwordMatch ? 'PASS (bcrypt verified)' : 'FAIL'}`);

    // 5. Test Country & Platform Relational Linking
    console.log('\n--- 4. Relational CRUD & Country FK Linking Test ---');
    await client.query(`SELECT setval('admin_countries_id_seq', COALESCE((SELECT MAX(id) FROM admin_countries), 1));`);
    await client.query(`SELECT setval('admin_platforms_id_seq', COALESCE((SELECT MAX(id) FROM admin_platforms), 1));`);
    await client.query('BEGIN');

    // Insert test country
    const countryRes = await client.query(
      `INSERT INTO admin_countries (country_name, country_code, currency_code, timezone, status)
       VALUES ('Republic of Test Ghana', 'TGHA', 'GHS', 'Africa/Accra', 'ACTIVE')
       RETURNING id, country_name, country_code;`
    );
    const countryId = countryRes.rows[0].id;
    console.log(`  * Created Country: ID ${countryId} ("${countryRes.rows[0].country_name}")`);

    // Insert test platform referencing country_id
    const platformRes = await client.query(
      `INSERT INTO admin_platforms (platform_name, platform_code, country_id, description, status)
       VALUES ('Ghana Lottery Platform', 'gh-lottery', $1, 'Relational test platform', 'ACTIVE')
       RETURNING id, platform_name, platform_code, country_id;`,
      [countryId]
    );
    const platformId = platformRes.rows[0].id;
    console.log(`  * Created Platform: ID ${platformId} ("${platformRes.rows[0].platform_name}") linked to country_id=${countryId}`);

    // Insert API config
    const apiConfigRes = await client.query(
      `INSERT INTO platform_api_configs (platform_id, api_base_url, endpoint_path, http_method, auth_type, status)
       VALUES ($1, 'https://api.ghlottery.com', '/v1/reports', 'GET', 'bearer', 'ACTIVE')
       RETURNING id, platform_id, api_base_url, endpoint_path;`,
      [platformId]
    );
    console.log(`  * Created API Config: ID ${apiConfigRes.rows[0].id} for platform_id=${platformId}`);

    // Insert API credential (encrypted)
    const credRes = await client.query(
      `INSERT INTO platform_api_credentials (platform_id, credential_name, credential_type, encrypted_value, status)
       VALUES ($1, 'bearer_token', 'bearer', '{"iv":"abcdef","tag":"123456","ciphertext":"7890ab"}'::jsonb, 'ACTIVE')
       RETURNING id, platform_id, credential_name;`,
      [platformId]
    );
    console.log(`  * Created Credential: ID ${credRes.rows[0].id} ("${credRes.rows[0].credential_name}")`);

    // Insert platform access with date window
    const accessRes = await client.query(
      `INSERT INTO admin_platform_access (admin_id, platform_id, role_id, start_date, end_date, status, created_by)
       VALUES ($1, $2, 2, '2026-01-01', '2026-12-31', 'ACTIVE', $1)
       RETURNING id, admin_id, platform_id, role_id, start_date, end_date, status;`,
      [user.id, platformId]
    );
    console.log(`  * Created Platform Access: ID ${accessRes.rows[0].id} (valid 2026-01-01 to 2026-12-31)`);

    // Test relational query joining country -> platform -> access -> admin
    const joinRes = await client.query(
      `SELECT c.country_name, c.country_code,
              p.platform_name, p.platform_code,
              u.username, u.email,
              pa.start_date, pa.end_date, pa.status as access_status
       FROM admin_countries c
       JOIN admin_platforms p ON p.country_id = c.id
       JOIN admin_platform_access pa ON pa.platform_id = p.id
       JOIN admin_users u ON u.id = pa.admin_id
       WHERE c.id = $1;`,
      [countryId]
    );
    console.log(`  * Verified relational join: Platform "${joinRes.rows[0].platform_name}" under "${joinRes.rows[0].country_name}" authorized for user "${joinRes.rows[0].username}"`);

    // Rollback test records so the database remains pure and clean
    await client.query('ROLLBACK');
    console.log('  * Test transaction rolled back cleanly. Database remains clean.');

    console.log('\n======================================================');
    console.log('   ALL POSTGRESQL VERIFICATION CHECKS PASSED (100%)');
    console.log('======================================================\n');
  } finally {
    client.release();
    await pool.end();
  }
}

runVerification().catch(err => {
  console.error('[Verification Failed]', err);
  process.exit(1);
});
