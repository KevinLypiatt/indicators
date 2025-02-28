require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

const createTables = async () => {
  try {
    const client = await pool.connect();
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
      SELECT 'start_time', '08:00'
      WHERE NOT EXISTS (SELECT 1 FROM parameters WHERE param_name = 'start_time');
      INSERT INTO parameters (param_name, param_value)
      SELECT 'end_time', '17:00'
      WHERE NOT EXISTS (SELECT 1 FROM parameters WHERE param_name = 'end_time');
    `);
    console.log('Default parameters set.');
    client.release();
  } catch (err) {
    console.error('Error creating tables:', err.message);
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
    console.error('Error fetching gold price from Swissquote:', err.message);
  }
};

const scheduleDataCollection = () => {
  cron.schedule('0 * * * *', async () => {
    const { rows } = await pool.query('SELECT param_name, param_value FROM parameters');
    const params = Object.fromEntries(rows.map(row => [row.param_name, row.param_value]));
    const now = new Date();
    const currentHour = now.getHours();
    const startHour = parseInt(params.start_time.split(':')[0], 10);
    const endHour = parseInt(params.end_time.split(':')[0], 10);

    if (currentHour >= startHour && currentHour <= endHour) {
      await dataCollector();
    }
  });
};

app.get('/dashboard', async (req, res) => {
  try {
    // Log all time_series entries for debugging
    const allData = await pool.query('SELECT timestamp, indicator_value FROM time_series ORDER BY timestamp DESC');
    console.log('All time_series entries:', allData.rows.map(row => ({
      timestamp: row.timestamp.toISOString(),
      value: Number(row.indicator_value)
    })));

    // Get the latest price
    const latest = await pool.query(`
      SELECT timestamp, indicator_value 
      FROM time_series 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    const latestPrice = Number(latest.rows[0]?.indicator_value) || 0;
    const latestTime = latest.rows[0]?.timestamp.toLocaleString() || 'N/A';
    console.log('Latest price:', latestPrice, 'at', latestTime);

    // Get the last price from the previous day (any time)
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStart = new Date(yesterday.setHours(0, 0, 0, 0));
    const yesterdayEnd = new Date(yesterday.setHours(23, 59, 59, 999));

    const prevDayLast = await pool.query(`
      SELECT indicator_value, timestamp
      FROM time_series 
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [yesterdayStart, yesterdayEnd]);
    
    const prevPrice = prevDayLast.rows[0] ? Number(prevDayLast.rows[0].indicator_value) : null;
    const prevTime = prevDayLast.rows[0]?.timestamp.toLocaleString() || 'N/A';
    console.log('Previous day last price:', prevPrice, 'at', prevTime);

    const percentChange = prevPrice !== null ? (((latestPrice - prevPrice) / prevPrice) * 100).toFixed(2) : 'N/A';

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Gold Price Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .price { font-size: 2em; color: #FFD700; }
          .change-positive { color: green; }
          .change-negative { color: red; }
        </style>
      </head>
      <body>
        <h1>Gold Price Dashboard</h1>
        <div class="price">$${latestPrice.toFixed(2)}</div>
        <p>Last Updated: ${latestTime}</p>
        <p>Change from Yesterday's Last (at ${prevTime}): 
          <span class="${percentChange > 0 ? 'change-positive' : 'change-negative'}">
            ${percentChange !== 'N/A' ? percentChange + '%' : 'N/A'}
          </span>
        </p>
        <p><a href="/settings">Go to Settings</a></p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading dashboard:', err.message);
    res.status(500).send('Error loading dashboard');
  }
});

// Settings routes (unchanged from previous)
// [Omitted for brevity, same as last version]

app.get('/', (req, res) => {
  res.send('Gold Price App is running! Visit <a href="/dashboard">Dashboard</a>');
});

const startApp = async () => {
  try {
    await createTables();
    scheduleDataCollection();
    // await dataCollector(); // Commented out after testing
    app.listen(port, () => {
      console.log(`App running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start app:', err.message);
    process.exit(1);
  }
};

startApp();