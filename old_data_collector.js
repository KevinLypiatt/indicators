require('dotenv').config();
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

const createTables = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to database successfully');
    await client.query(`
      CREATE TABLE IF NOT EXISTS time_series (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        indicator_type TEXT NOT NULL,
        indicator_country TEXT NOT NULL,
        indicator_value NUMERIC(10, 2) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parameters (
        id SERIAL PRIMARY KEY,
        param_name TEXT NOT NULL,
        param_value TEXT NOT NULL
      );
    `);
    console.log('Tables created or already exist.');
    await client.query(`
      INSERT INTO parameters (param_name, param_value)
      SELECT 'start_time', '00:00'
      WHERE NOT EXISTS (SELECT 1 FROM parameters WHERE param_name = 'start_time');
      INSERT INTO parameters (param_name, param_value)
      SELECT 'end_time', '23:00'
      WHERE NOT EXISTS (SELECT 1 FROM parameters WHERE param_name = 'end_time');
    `);
    console.log('Default parameters set.');
    client.release();
  } catch (err) {
    console.error('Error creating tables:', err.stack);
    throw err;
  }
};

const dataCollector = async () => {
  try {
    const response = await axios.get('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
    const quotes = response.data;
    const goldData = quotes[0]?.spreadProfilePrices[0];
    const goldPrice = goldData?.bid;
    if (goldPrice && !isNaN(goldPrice)) {
      await pool.query(
        'INSERT INTO time_series (indicator_type, indicator_country, indicator_value) VALUES ($1, $2, $3)',
        ['gold', 'USA', Number(goldPrice).toFixed(2)]
      );
      console.log(`Gold price ${Number(goldPrice).toFixed(2)} stored at ${new Date().toISOString()}`);
    } else {
      console.error('Failed to parse gold price from Swissquote');
    }
  } catch (err) {
    console.error('Error fetching gold price:', err.message);
  }
};

const startCollector = async () => {
  try {
    await createTables();
    console.log('Starting data collector...');
    cron.schedule('0 * * * *', async () => {
      console.log('Running scheduled data collection...');
      await dataCollector();
    });
    // Initial data collection
    await dataCollector();
  } catch (err) {
    console.error('Failed to start data collector:', err.stack);
    process.exit(1);
  }
};

startCollector();