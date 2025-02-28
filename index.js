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
  console.error('Unexpected error on idle client:', err.stack);
  process.exit(-1);
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
    console.log('Default parameters set to 24-hour collection.');
    client.release();
  } catch (err) {
    console.error('Error creating tables:', err.stack); // Full stack trace
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
    await dataCollector();
  });
};

app.get('/dashboard', async (req, res) => {
  try {
    const allData = await pool.query('SELECT timestamp, indicator_value FROM time_series ORDER BY timestamp DESC');
    console.log('All time_series entries:', allData.rows.map(row => ({
      timestamp: row.timestamp.toISOString(),
      value: Number(row.indicator_value)
    })));

    const latest = await pool.query(`
      SELECT timestamp, indicator_value 
      FROM time_series 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    const latestPrice = Number(latest.rows[0]?.indicator_value) || 0;
    const latestTime = latest.rows[0]?.timestamp.toLocaleString() || 'N/A';
    console.log('Latest price:', latestPrice, 'at', latestTime);

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
    console.error('Error loading dashboard:', err.stack);
    res.status(500).send('Error loading dashboard');
  }
});

app.get('/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM time_series ORDER BY timestamp DESC');
    let tableRows = rows.map(row => `
      <tr>
        <td>${row.id}</td>
        <td><span hx-get="/settings/edit/${row.id}/timestamp" hx-target="this" hx-swap="outerHTML">${row.timestamp.toLocaleString()}</span></td>
        <td><span hx-get="/settings/edit/${row.id}/indicator_type" hx-target="this" hx-swap="outerHTML">${row.indicator_type}</span></td>
        <td><span hx-get="/settings/edit/${row.id}/indicator_country" hx-target="this" hx-swap="outerHTML">${row.indicator_country}</span></td>
        <td><span hx-get="/settings/edit/${row.id}/indicator_value" hx-target="this" hx-swap="outerHTML">${Number(row.indicator_value).toFixed(2)}</span></td>
        <td><button hx-delete="/settings/delete/${row.id}" hx-target="closest tr" hx-swap="outerHTML" hx-confirm="Are you sure?">Delete</button></td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Settings - Gold Price Data</title>
        <script src="https://unpkg.com/htmx.org@1.9.10"></script>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          button { padding: 5px 10px; }
          input { width: 100px; }
          input[type="datetime-local"] { width: 180px; }
        </style>
      </head>
      <body>
        <h1>Settings - Edit Gold Price Data</h1>
        <form hx-post="/settings/add" hx-target="#data-table tbody" hx-swap="beforeend">
          <input type="text" name="indicator_type" value="gold" readonly>
          <input type="text" name="indicator_country" value="USA" readonly>
          <input type="number" name="indicator_value" step="0.01" placeholder="Value" required>
          <button type="submit">Add</button>
        </form>
        <table id="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Country</th>
              <th>Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
        <p><a href="/dashboard">Back to Dashboard</a></p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading settings:', err.stack);
    res.status(500).send('Error loading settings');
  }
});

app.get('/settings/edit/:id/:field', async (req, res) => {
  const { id, field } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM time_series WHERE id = $1', [id]);
    const row = rows[0];
    let inputHtml = '';
    switch (field) {
      case 'timestamp':
        const timestampISO = row.timestamp.toISOString().slice(0, 16);
        inputHtml = `<input type="datetime-local" name="timestamp" value="${timestampISO}" required>`;
        break;
      case 'indicator_type':
        inputHtml = `<input type="text" name="indicator_type" value="${row.indicator_type}" required>`;
        break;
      case 'indicator_country':
        inputHtml = `<input type="text" name="indicator_country" value="${row.indicator_country}" required>`;
        break;
      case 'indicator_value':
        inputHtml = `<input type="number" name="indicator_value" value="${Number(row.indicator_value).toFixed(2)}" step="0.01" required>`;
        break;
    }
    res.send(`
      <td>
        <form hx-put="/settings/edit/${id}" hx-target="this" hx-swap="outerHTML">
          ${inputHtml}
          <button type="submit">Save</button>
          <button hx-get="/settings/cancel/${id}/${field}" type="button">Cancel</button>
        </form>
      </td>
    `);
  } catch (err) {
    console.error('Error loading edit form:', err.stack);
    res.status(500).send('Error');
  }
});

app.get('/settings/cancel/:id/:field', async (req, res) => {
  const { id, field } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM time_series WHERE id = $1', [id]);
    const row = rows[0];
    let value = '';
    switch (field) {
      case 'timestamp': value = row.timestamp.toLocaleString(); break;
      case 'indicator_type': value = row.indicator_type; break;
      case 'indicator_country': value = row.indicator_country; break;
      case 'indicator_value': value = Number(row.indicator_value).toFixed(2); break;
    }
    res.send(`
      <span hx-get="/settings/edit/${id}/${field}" hx-target="this" hx-swap="outerHTML">
        ${value}
      </span>
    `);
  } catch (err) {
    console.error('Error canceling edit:', err.stack);
    res.status(500).send('Error');
  }
});

app.put('/settings/edit/:id', async (req, res) => {
  const { id } = req.params;
  const { timestamp, indicator_type, indicator_country, indicator_value } = req.body;
  try {
    const updates = {};
    if (timestamp) updates.timestamp = timestamp;
    if (indicator_type) updates.indicator_type = indicator_type;
    if (indicator_country) updates.indicator_country = indicator_country;
    if (indicator_value) updates.indicator_value = Number(indicator_value).toFixed(2);

    const fields = Object.keys(updates);
    if (fields.length > 0) {
      const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
      const values = fields.map(f => updates[f]);
      values.push(id);
      await pool.query(
        `UPDATE time_series SET ${setClause} WHERE id = $${fields.length + 1}`,
        values
      );
    }

    const { rows } = await pool.query('SELECT * FROM time_series WHERE id = $1', [id]);
    const row = rows[0];
    const field = fields[0];
    const value = field === 'timestamp' ? row.timestamp.toLocaleString() : 
                  field === 'indicator_value' ? Number(row.indicator_value).toFixed(2) : 
                  row[field];
    res.send(`
      <span hx-get="/settings/edit/${id}/${field}" hx-target="this" hx-swap="outerHTML">
        ${value}
      </span>
    `);
  } catch (err) {
    console.error('Error updating row:', err.stack);
    res.status(500).send('Error');
  }
});

app.post('/settings/add', async (req, res) => {
  const { indicator_type, indicator_country, indicator_value } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO time_series (indicator_type, indicator_country, indicator_value) VALUES ($1, $2, $3) RETURNING *',
      [indicator_type, indicator_country, Number(indicator_value).toFixed(2)]
    );
    const row = rows[0];
    res.send(`
      <tr>
        <td>${row.id}</td>
        <td><span hx-get="/settings/edit/${row.id}/timestamp" hx-target="this" hx-swap="outerHTML">${row.timestamp.toLocaleString()}</span></td>
        <td><span hx-get="/settings/edit/${row.id}/indicator_type" hx-target="this" hx-swap="outerHTML">${row.indicator_type}</span></td>
        <td><span hx-get="/settings/edit/${row.id}/indicator_country" hx-target="this" hx-swap="outerHTML">${row.indicator_country}</span></td>
        <td><span hx-get="/settings/edit/${row.id}/indicator_value" hx-target="this" hx-swap="outerHTML">${Number(row.indicator_value).toFixed(2)}</span></td>
        <td><button hx-delete="/settings/delete/${row.id}" hx-target="closest tr" hx-swap="outerHTML" hx-confirm="Are you sure?">Delete</button></td>
      </tr>
    `);
  } catch (err) {
    console.error('Error adding row:', err.stack);
    res.status(500).send('Error');
  }
});

app.delete('/settings/delete/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM time_series WHERE id = $1', [id]);
    res.send('');
  } catch (err) {
    console.error('Error deleting row:', err.stack);
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.send('Gold Price App is running! Visit <a href="/dashboard">Dashboard</a>');
});

const startApp = async () => {
  try {
    await createTables();
    scheduleDataCollection();
    app.listen(port, () => {
      console.log(`App running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start app:', err.stack); // Full stack trace
    process.exit(1);
  }
};

startApp();