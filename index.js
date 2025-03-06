require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Validate environment variables
const requiredEnvVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT'];
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
});

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

app.use(express.static('public'));
app.use(express.json());  // Add JSON parsing middleware

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/prices', async (req, res) => {
  try {
    const indicatorType = req.query.type || 'gold';
    const result = await pool.query(
      'SELECT timestamp, indicator_value FROM time_series WHERE indicator_type = $1 ORDER BY timestamp DESC LIMIT 100',
      [indicatorType]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching prices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/prices', async (req, res) => {
  try {
    const { type, value } = req.body;
    if (!type || typeof value !== 'number') {
      return res.status(400).json({ error: 'Invalid input' });
    }
    
    await pool.query(
      'INSERT INTO time_series (indicator_type, indicator_country, indicator_value) VALUES ($1, $2, $3)',
      [type, type === 'bitcoin' ? 'USA' : 'USA', value]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating price:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/prices/previous', async (req, res) => {
  try {
    const indicatorType = req.query.type;
    if (!indicatorType) {
      return res.status(400).json({ error: 'Indicator type is required' });
    }

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const result = await pool.query(`
      SELECT indicator_value, timestamp
      FROM time_series 
      WHERE indicator_type = $1
      AND timestamp::date = $2::date
      ORDER BY timestamp DESC
      LIMIT 1
    `, [indicatorType, yesterday.toISOString()]);

    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('Error fetching previous price:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/indicators', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT indicator_type, indicator_country FROM time_series ORDER BY indicator_country, indicator_type'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching indicators:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest_timestamps AS (
        SELECT indicator_type, MAX(timestamp) as max_timestamp
        FROM time_series
        GROUP BY indicator_type
      )
      SELECT ts.indicator_type, ts.indicator_country, ts.indicator_value, ts.timestamp
      FROM time_series ts
      INNER JOIN latest_timestamps lt 
        ON ts.indicator_type = lt.indicator_type 
        AND ts.timestamp = lt.max_timestamp
      ORDER BY ts.indicator_country, ts.indicator_type
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching latest prices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/parameters', async (req, res) => {
  try {
    const result = await pool.query('SELECT param_name, param_value FROM parameters');
    const params = {};
    result.rows.forEach(row => {
      params[row.param_name] = row.param_value;
    });
    res.json(params);
  } catch (err) {
    console.error('Error fetching parameters:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// New endpoints for the data editor
app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, timestamp, indicator_type, indicator_country, indicator_value FROM time_series ORDER BY timestamp DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching time series:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/timeseries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { timestamp, value } = req.body;
    
    await pool.query(
      'UPDATE time_series SET timestamp = $1, indicator_value = $2 WHERE id = $3',
      [timestamp, value, id]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating record:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/timeseries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM time_series WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting record:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});