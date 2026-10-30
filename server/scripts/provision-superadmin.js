import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import { sslForConnectionString } from '../src/store/pgStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.REPORTING_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[Provision] Error: Database URL not found.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString,
  ssl: sslForConnectionString(connectionString)
});

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const client = await pool.connect();
  console.log('\n======================================================');
  console.log('       INITIAL SUPER ADMIN PROVISIONING');
  console.log('======================================================\n');

  try {
    // 1. Guard check: Only allow provisioning if NO super admin exists
    const checkRes = await client.query('SELECT COUNT(*) as count FROM admin_users WHERE is_super_admin = TRUE AND deleted_at IS NULL');
    const existingSuperAdmins = parseInt(checkRes.rows[0].count, 10);

    if (existingSuperAdmins > 0) {
      console.log('[Provision] Security check: A Super Admin is already configured in this database.');
      console.log('[Provision] First-run provisioning is permanently disabled to prevent privilege escalation.');
      process.exit(0);
    }

    // 2. Obtain credentials from environment or prompt
    let username = process.env.SUPER_ADMIN_USERNAME || process.env.SEED_SUPER_ADMIN_USERNAME;
    let email = process.env.SUPER_ADMIN_EMAIL || process.env.SEED_SUPER_ADMIN_EMAIL;
    let name = process.env.SUPER_ADMIN_NAME || process.env.SEED_SUPER_ADMIN_NAME || 'Super Administrator';
    let password = process.env.SUPER_ADMIN_PASSWORD || process.env.SEED_SUPER_ADMIN_PASSWORD;

    if (!username && process.stdin.isTTY) {
      username = await prompt('Enter Super Admin Username: ');
    }
    if (!email && process.stdin.isTTY) {
      email = await prompt('Enter Super Admin Email: ');
    }
    if (!password && process.stdin.isTTY) {
      password = await prompt('Enter Super Admin Password (min 10 characters): ');
    }

    // Default fallback if running in non-interactive environment without prompts
    if (!username) username = 'superadmin';
    if (!email) email = 'superadmin@unisolution.local';
    if (!password || password.length < 10) {
      console.error('[Provision] Error: A secure password of at least 10 characters is required.');
      console.error('Set SUPER_ADMIN_PASSWORD in .env or provide it interactively.');
      process.exit(1);
    }

    console.log(`[Provision] Provisioning Initial Super Admin '${username}' (${email})...`);

    // 3. Hash password securely using bcrypt
    const passwordHash = await bcrypt.hash(password, 12);

    // 4. Insert into admin_users transactionally
    await client.query('BEGIN');

    const insertUserRes = await client.query(
      `INSERT INTO admin_users (username, email, password_hash, status, is_super_admin, name, created_at, updated_at)
       VALUES ($1, LOWER($2), $3, 'ACTIVE', TRUE, $4, NOW(), NOW())
       RETURNING id, username, email, name, status, is_super_admin, created_at;`,
      [username, email, passwordHash, name]
    );

    const adminUser = insertUserRes.rows[0];

    // Ensure role 1 (Super Admin) exists
    await client.query(
      `INSERT INTO admin_roles (id, role_name, description, permissions)
       VALUES (1, 'Super Admin', 'Universal access across all platforms and administrative modules', '["*"]'::jsonb)
       ON CONFLICT (id) DO NOTHING;`
    );

    // Assign Super Admin role in admin_user_roles
    await client.query(
      `INSERT INTO admin_user_roles (admin_id, role_id)
       VALUES ($1, 1)
       ON CONFLICT (admin_id, role_id) DO NOTHING;`,
      [adminUser.id]
    );

    // Create audit log entry
    await client.query(
      `INSERT INTO admin_audit_logs (user_id, action, entity, entity_id, metadata, created_at)
       VALUES ($1, 'PROVISION_SUPER_ADMIN', 'User', $2, '{"source": "initial_setup"}'::jsonb, NOW());`,
      [adminUser.id, String(adminUser.id)]
    );

    await client.query('COMMIT');

    console.log('\n[Provision] Super Admin created successfully!');
    console.log(`  ID:          ${adminUser.id}`);
    console.log(`  Username:    ${adminUser.username}`);
    console.log(`  Email:       ${adminUser.email}`);
    console.log(`  Role:        Super Admin`);
    console.log(`  Status:      ${adminUser.status}`);
    console.log('\n[Provision] Setup complete. You can now log into the dashboard with these credentials.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Provision] Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
