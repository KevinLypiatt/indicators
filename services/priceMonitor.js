const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { Pool } = require('pg');
require('dotenv').config();

// Add tracking variables
let lastAlertPrice = null;
let lastAlertDate = null;

// ...existing connection code...

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

    // Reset alert tracking at start of each day
    const today = now.toDateString();
    if (lastAlertDate && lastAlertDate !== today) {
      lastAlertPrice = null;
      lastAlertDate = null;
      console.log('Reset alert tracking for new day');
    }

    const latestPrice = await pool.query(`
      SELECT indicator_value, timestamp 
      FROM time_series 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);

    // Compare with last alert price if exists, otherwise previous day's close
    const comparisonPrice = lastAlertPrice || await getLastClosingPrice(now);
    const currentPrice = latestPrice.rows[0] ? Number(latestPrice.rows[0].indicator_value) : null;
    const priceTimestamp = latestPrice.rows[0]?.timestamp || 'N/A';

    if (currentPrice !== null && comparisonPrice !== null) {
      const percentChange = ((currentPrice - comparisonPrice) / comparisonPrice) * 100;
      const basePrice = lastAlertPrice ? 'last alert price' : 'previous close';
      console.log(`Price check: Current=$${currentPrice.toFixed(2)}, ${basePrice}=$${comparisonPrice.toFixed(2)}, Change=${percentChange.toFixed(2)}%`);
      
      const THRESHOLD = 0.10;
      
      if (Math.abs(percentChange) >= THRESHOLD) {
        const emailBody = `
GOLD PRICE ALERT - Significant Change Detected

Current Gold Price: $${currentPrice.toFixed(2)}
Time of Last Update: ${new Date(priceTimestamp).toLocaleString()}
Comparison Price: $${comparisonPrice.toFixed(2)}
Percentage Change: ${percentChange.toFixed(2)}%

This alert was triggered because the price change exceeded the ${THRESHOLD}% threshold.
Reference price was ${lastAlertPrice ? 'last alert price' : 'previous day close'}.
        `;

        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: EMAIL_RECIPIENTS,
          subject: `Gold Price Alert - ${percentChange.toFixed(2)}% Change`,
          text: emailBody
        });

        // Update tracking after sending alert
        lastAlertPrice = currentPrice;
        lastAlertDate = today;
        console.log(`Alert sent - New reference price set to $${currentPrice.toFixed(2)}`);
      }
    }
  } catch (err) {
    console.error('Error in price monitor:', err);
  }
}

// Helper function to get previous day's closing price
async function getLastClosingPrice(now) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStart = new Date(yesterday.setHours(0, 0, 0, 0));
  const yesterdayEnd = new Date(yesterday.setHours(23, 59, 59, 999));

  const result = await pool.query(`
    SELECT indicator_value, timestamp 
    FROM time_series 
    WHERE timestamp BETWEEN $1 AND $2
    ORDER BY timestamp DESC 
    LIMIT 1
  `, [yesterdayStart, yesterdayEnd]);

  return result.rows[0] ? Number(result.rows[0].indicator_value) : null;
}

// Run at 5 minutes past every hour
cron.schedule('5 * * * *', checkPriceChange);

console.log('Price monitor service started - running at 5 minutes past every hour');