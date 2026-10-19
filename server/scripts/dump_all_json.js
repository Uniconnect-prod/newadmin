import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    const tables = [
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

    const result = {};
    for (const t of tables) {
      const res = await client.query(`SELECT * FROM "${t}"`);
      result[t] = res.rows;
    }

    const outPath = 'C:/Users/Rishi/.gemini/antigravity-ide/brain/0a674b04-f935-4b3d-87d9-002b3dfb2a3f/scratch/db_dump.json';
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log('Saved dump to', outPath);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
