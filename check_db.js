require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

async function showDatabaseInfo() {
  try {
    // Get all tables
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);

    console.log('\n=== Database Tables ===');
    
    // For each table, get its schema and contents
    for (const table of tables.rows) {
      const tableName = table.table_name;
      
      // Get table schema
      console.log(`\n\n=== Table: ${tableName} ===`);
      const schema = await pool.query(`
        SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);
      
      console.log('\nSchema:');
      console.table(schema.rows);

      // Get table contents
      const contents = await pool.query(`SELECT * FROM ${tableName}`);
      console.log('\nContents:');
      console.table(contents.rows);
    }

    await pool.end();
  } catch (err) {
    console.error('Error:', err);
    await pool.end();
  }
}

showDatabaseInfo();