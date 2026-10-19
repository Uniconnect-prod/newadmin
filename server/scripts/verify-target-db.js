import pg from 'pg';

const targetUrl = process.env.TARGET_DATABASE_URL || process.argv[2];

if (!targetUrl) {
  console.error('Error: Target database URL must be provided via TARGET_DATABASE_URL or as argument.');
  process.exit(1);
}

// Mask credentials for display
const maskedUrl = targetUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
console.log(`Connecting to target database: ${maskedUrl}`);

const pool = new pg.Pool({
  connectionString: targetUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    const infoRes = await client.query('SELECT current_database() as db, current_user as usr, version() as v');
    console.log(`Verified database connection!`);
    console.log(`  Database Name: ${infoRes.rows[0].db}`);
    console.log(`  User:          ${infoRes.rows[0].usr}`);
    console.log(`  PostgreSQL:    ${infoRes.rows[0].v.split(' ')[0]} ${infoRes.rows[0].v.split(' ')[1]}`);

    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log(`  Tables found in public schema (${tablesRes.rows.length}):`);
    if (tablesRes.rows.length === 0) {
      console.log('  -> Target database is EMPTY. Ready for clean relational schema setup.');
    } else {
      for (const r of tablesRes.rows) {
        console.log(`     - ${r.table_name}`);
      }
    }
  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
