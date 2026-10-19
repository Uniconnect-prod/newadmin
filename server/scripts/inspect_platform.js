import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.REPORTING_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const res = await pool.query('SELECT data FROM admin_platforms WHERE id = 1');
  console.log('Platform 1:', JSON.stringify(res.rows[0]?.data, null, 2));
  await pool.end();
}
main();
