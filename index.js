require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const moment = require('moment');

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

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', async (req, res) => {
  try {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    
    const todayStart = new Date(today.setHours(0, 0, 0, 0));
    const todayEnd = new Date(today.setHours(23, 59, 59, 999));
    
    const latestToday = await pool.query(`
      SELECT indicator_value, timestamp 
      FROM time_series 
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [todayStart, todayEnd]);

    const yesterdayStart = new Date(yesterday.setHours(0, 0, 0, 0));
    const yesterdayEnd = new Date(yesterday.setHours(23, 59, 59, 999));

    const latestYesterday = await pool.query(`
      SELECT indicator_value, timestamp
      FROM time_series 
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [yesterdayStart, yesterdayEnd]);

    const latestPrice = latestToday.rows[0] ? Number(latestToday.rows[0].indicator_value) : null;
    const latestTime = latestToday.rows[0]?.timestamp ? moment(latestToday.rows[0].timestamp).format('YYYY-MM-DD HH:mm:ss') : 'N/A';
    const prevPrice = latestYesterday.rows[0] ? Number(latestYesterday.rows[0].indicator_value) : null;
    const prevTime = latestYesterday.rows[0]?.timestamp ? moment(latestYesterday.rows[0].timestamp).format('YYYY-MM-DD HH:mm:ss') : 'N/A';

    let percentChange = 'N/A';
    if (latestPrice !== null && prevPrice !== null) {
      percentChange = (((latestPrice - prevPrice) / prevPrice) * 100).toFixed(2);
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gold Price Dashboard</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
      </head>
      <body class="bg-light min-vh-100 d-flex align-items-center justify-content-center">
        <div class="container">
          <div class="card shadow-sm mx-auto" style="max-width: 400px;">
            <div class="card-body text-center">
              <h1 class="card-title h3 mb-4">Gold Price Dashboard</h1>
              <div class="display-4 text-warning mb-3">$${latestPrice ? latestPrice.toFixed(2) : 'N/A'}</div>
              <p class="text-muted">Last Updated: ${latestTime}</p>
              <p class="mb-3">Change from Yesterday's Last (at ${prevTime}): 
                <span class="badge ${percentChange > 0 ? 'bg-success' : percentChange < 0 ? 'bg-danger' : 'bg-secondary'}">
                  ${percentChange !== 'N/A' ? percentChange + '%' : 'N/A'}
                </span>
              </p>
              <div>
                <a href="/settings" class="btn btn-primary">Settings</a>
                <a href="/data" class="btn btn-info ms-2">Manage Data</a>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading dashboard:', err.stack);
    res.status(500).send('Error loading dashboard');
  }
});

app.get('/data', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, timestamp, indicator_type, indicator_country, indicator_value 
      FROM time_series 
      ORDER BY timestamp DESC 
      LIMIT 100
    `);
    
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Data Management - Gold Price Dashboard</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
      </head>
      <body class="bg-light">
        <div class="container py-5">
          <div class="card shadow-sm">
            <div class="card-body">
              <h2 class="card-title mb-4">Data Management</h2>
              <div class="table-responsive">
                <table class="table table-striped">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Timestamp</th>
                      <th>Type</th>
                      <th>Country</th>
                      <th>Value</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${result.rows.map(row => `
                      <tr>
                        <td>${row.id}</td>
                        <td>${moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss')}</td>
                        <td>${row.indicator_type}</td>
                        <td>${row.indicator_country}</td>
                        <td>
                          <form action="/data/${row.id}/update" method="POST" class="d-inline">
                            <input type="number" step="0.01" name="value" 
                                   value="${row.indicator_value}" class="form-control form-control-sm" 
                                   style="width: 120px;">
                            <button type="submit" class="btn btn-sm btn-primary">Save</button>
                          </form>
                        </td>
                        <td>
                          <form action="/data/${row.id}/delete" method="POST" class="d-inline">
                            <button type="submit" class="btn btn-sm btn-danger">Delete</button>
                          </form>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
              <a href="/dashboard" class="btn btn-secondary">Back to Dashboard</a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading data:', err.stack);
    res.status(500).send('Error loading data');
  }
});

app.post('/data/:id/update', async (req, res) => {
  try {
    const { id } = req.params;
    const { value } = req.body;
    await pool.query(
      'UPDATE time_series SET indicator_value = $1 WHERE id = $2',
      [value, id]
    );
    res.redirect('/data');
  } catch (err) {
    console.error('Error updating data:', err.stack);
    res.status(500).send('Error updating data');
  }
});

app.post('/data/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM time_series WHERE id = $1', [id]);
    res.redirect('/data');
  } catch (err) {
    console.error('Error deleting data:', err.stack);
    res.status(500).send('Error deleting data');
  }
});

app.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM parameters ORDER BY param_name');
    
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Settings - Gold Price Dashboard</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
      </head>
      <body class="bg-light">
        <div class="container py-5">
          <div class="card shadow-sm">
            <div class="card-body">
              <h2 class="card-title mb-4">Settings</h2>
              <form action="/settings/update" method="POST">
                ${result.rows.map(param => `
                  <div class="mb-3">
                    <label class="form-label">${param.param_name}</label>
                    <input type="text" class="form-control" name="${param.param_name}" 
                           value="${param.param_value}" required>
                  </div>
                `).join('')}
                <button type="submit" class="btn btn-primary">Save Settings</button>
                <a href="/dashboard" class="btn btn-secondary">Back to Dashboard</a>
              </form>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading settings:', err.stack);
    res.status(500).send('Error loading settings');
  }
});

app.post('/settings/update', async (req, res) => {
  try {
    const updates = Object.entries(req.body);
    for (const [param_name, param_value] of updates) {
      await pool.query(
        'UPDATE parameters SET param_value = $1 WHERE param_name = $2',
        [param_value, param_name]
      );
    }
    res.redirect('/settings');
  } catch (err) {
    console.error('Error updating settings:', err.stack);
    res.status(500).send('Error updating settings');
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const result = await pool.query(`
      SELECT timestamp, indicator_value 
      FROM time_series 
      WHERE timestamp >= NOW() - INTERVAL '${days} days'
      ORDER BY timestamp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching price history:', err.stack);
    res.status(500).json({ error: 'Error fetching price history' });
  }
});

const startApp = async () => {
  try {
    app.listen(port, () => {
      console.log(`Web interface running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start web interface:', err.stack);
    process.exit(1);
  }
};

startApp();