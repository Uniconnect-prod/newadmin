import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
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
    console.log('Connected to DB successfully!');
    // List tables
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('Tables in public schema:', tablesRes.rows.map(r => r.table_name));

    for (const row of tablesRes.rows) {
      const tableName = row.table_name;
      // Get columns
      const colsRes = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `, [tableName]);

      // Count
      const countRes = await client.query(`SELECT COUNT(*) FROM "${tableName}"`);
      const count = countRes.rows[0].count;

      console.log(`\n=== Table: ${tableName} (Count: ${count}) ===`);
      console.log('Columns:', colsRes.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));

      // Get sample rows
      if (parseInt(count, 10) > 0) {
        const sampleRes = await client.query(`SELECT * FROM "${tableName}" LIMIT 3`);
        console.log(`Sample rows (first ${sampleRes.rows.length}):`);
        for (const s of sampleRes.rows) {
          console.log(JSON.stringify(s, null, 2));
        }
      }
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
