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

// Track last alert details in memory per indicator
const alertTracker = {
  gold: { lastPrice: null, lastDate: null },
  bitcoin: { lastPrice: null, lastDate: null }
};

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

async function getLastClosingPrice(indicatorType, now) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStart = new Date(yesterday.setHours(0, 0, 0, 0));
  const yesterdayEnd = new Date(yesterday.setHours(23, 59, 59, 999));

  const result = await pool.query(`
    SELECT indicator_value, timestamp 
    FROM time_series 
    WHERE indicator_type = $1
    AND timestamp BETWEEN $2 AND $3
    ORDER BY timestamp DESC 
    LIMIT 1
  `, [indicatorType, yesterdayStart, yesterdayEnd]);

  return result.rows[0] ? Number(result.rows[0].indicator_value) : null;
}

async function checkIndicatorPrice(indicatorType, settings, now) {
  try {
    // Reset alert tracking at start of each day
    const today = now.toDateString();
    if (alertTracker[indicatorType].lastDate && alertTracker[indicatorType].lastDate !== today) {
      alertTracker[indicatorType].lastPrice = null;
      alertTracker[indicatorType].lastDate = null;
      console.log(`Reset alert tracking for ${indicatorType} for new day`);
    }

    const latestPrice = await pool.query(`
      SELECT indicator_value, timestamp 
      FROM time_series 
      WHERE indicator_type = $1
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [indicatorType]);

    // Compare with last alert price if exists, otherwise previous day's close
    const comparisonPrice = alertTracker[indicatorType].lastPrice || await getLastClosingPrice(indicatorType, now);
    const currentPrice = latestPrice.rows[0] ? Number(latestPrice.rows[0].indicator_value) : null;
    const priceTimestamp = latestPrice.rows[0]?.timestamp || 'N/A';

    if (currentPrice !== null && comparisonPrice !== null) {
      const percentChange = ((currentPrice - comparisonPrice) / comparisonPrice) * 100;
      const basePrice = alertTracker[indicatorType].lastPrice ? 'last alert price' : 'previous close';
      console.log(`${indicatorType} check: Current=$${currentPrice.toFixed(2)}, ${basePrice}=$${comparisonPrice.toFixed(2)}, Change=${percentChange.toFixed(2)}%`);
      
      const THRESHOLD = Number(process.env.PRICE_CHANGE_THRESHOLD) || 0.25;
      
      if (Math.abs(percentChange) >= THRESHOLD) {
        const emailBody = `
${indicatorType.toUpperCase()} PRICE ALERT - Significant Change Detected

Current ${indicatorType} Price: $${currentPrice.toFixed(2)}
Time of Last Update: ${new Date(priceTimestamp).toLocaleString()}
Comparison Price: $${comparisonPrice.toFixed(2)}
Percentage Change: ${percentChange.toFixed(2)}%

This alert was triggered because the price change exceeded the ${THRESHOLD}% threshold.
Reference price was ${alertTracker[indicatorType].lastPrice ? 'last alert price' : 'previous day close'}.
        `;

        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: EMAIL_RECIPIENTS,
          subject: `${indicatorType.toUpperCase()} Price Alert - ${percentChange.toFixed(2)}% Change`,
          text: emailBody
        });

        // Update tracking after sending alert
        alertTracker[indicatorType].lastPrice = currentPrice;
        alertTracker[indicatorType].lastDate = today;
        console.log(`${indicatorType} alert sent - New reference price set to $${currentPrice.toFixed(2)}`);
      }
    }
  } catch (err) {
    console.error(`Error monitoring ${indicatorType}:`, err);
  }
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

    // Monitor both gold and bitcoin
    await checkIndicatorPrice('gold', settings, now);
    await checkIndicatorPrice('bitcoin', settings, now);
  } catch (err) {
    console.error('Error in price monitor:', err);
  }
}

// Run at 5 minutes past every hour
cron.schedule('5 * * * *', checkPriceChange);

console.log('Price monitor service started - running at 5 minutes past every hour');