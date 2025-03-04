const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

const EMAIL_RECIPIENTS = process.env.ALERT_EMAILS.split(',');

async function getMonitoringSettings() {
  const result = await pool.query(`
    SELECT param_name, param_value
    FROM parameters 
    WHERE param_name IN ('start_time', 'end_time')
  `);
  
  const settings = {
    startTime: '08:00',  // default values
    endTime: '17:00'
  };

  result.rows.forEach(row => {
    if (row.param_name === 'start_time') settings.startTime = row.param_value;
    if (row.param_name === 'end_time') settings.endTime = row.param_value;
  });
  
  console.log('Monitoring settings:', settings);
  return settings;
}

async function checkPriceChange() {
  try {
    const settings = await getMonitoringSettings();
    const now = new Date();
    const monitoringTime = now.getHours().toString().padStart(2, '0') + ':' + 
                          now.getMinutes().toString().padStart(2, '0');
    
    if (monitoringTime < settings.startTime || monitoringTime > settings.endTime) {
      console.log(`Outside monitoring hours (${settings.startTime}-${settings.endTime}): ${monitoringTime}`);
      return;
    }

    // Get latest price
    const latestPrice = await pool.query(`
      SELECT indicator_value, timestamp 
      FROM time_series 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);

    // Get last price from previous day
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStart = new Date(yesterday.setHours(0, 0, 0, 0));
    const yesterdayEnd = new Date(yesterday.setHours(23, 59, 59, 999));

    const lastYesterdayPrice = await pool.query(`
      SELECT indicator_value, timestamp 
      FROM time_series 
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [yesterdayStart, yesterdayEnd]);

    const currentPrice = latestPrice.rows[0] ? Number(latestPrice.rows[0].indicator_value) : null;
    const priceTimestamp = latestPrice.rows[0]?.timestamp || 'N/A';
    const prevPrice = lastYesterdayPrice.rows[0] ? Number(lastYesterdayPrice.rows[0].indicator_value) : null;
    const prevTimestamp = lastYesterdayPrice.rows[0]?.timestamp || 'N/A';

    if (currentPrice !== null && prevPrice !== null) {
      const percentChange = ((currentPrice - prevPrice) / prevPrice) * 100;
      console.log(`Price check: Current=$${currentPrice.toFixed(2)}, Previous=$${prevPrice.toFixed(2)}, Change=${percentChange.toFixed(2)}%`);
      
      // Using fixed threshold for now
      const THRESHOLD = 0.10;
      
      if (Math.abs(percentChange) >= THRESHOLD) {
        const emailBody = `
GOLD PRICE ALERT - Significant Change Detected

Current Gold Price: $${currentPrice.toFixed(2)}
Time of Last Update: ${new Date(priceTimestamp).toLocaleString()}
Previous Day's Last Price: $${prevPrice.toFixed(2)}
Previous Time: ${new Date(prevTimestamp).toLocaleString()}
Percentage Change: ${percentChange.toFixed(2)}%

This alert was triggered because the price change exceeded the ${THRESHOLD}% threshold.
        `;

        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: EMAIL_RECIPIENTS,
          subject: `Gold Price Alert - ${percentChange.toFixed(2)}% Change`,
          text: emailBody
        });

        console.log(`Alert email sent - ${percentChange.toFixed(2)}% change detected`);
      }
    }
  } catch (err) {
    console.error('Error in price monitor:', err);
  }
}

// Run every 5 minutes
cron.schedule('*/5 * * * *', checkPriceChange);

console.log('Price monitor service started');