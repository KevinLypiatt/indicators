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

const THRESHOLD = parseFloat(process.env.PRICE_CHANGE_THRESHOLD) || 0.49;
const EMAIL_RECIPIENTS = process.env.ALERT_EMAILS.split(',');

async function checkPriceChange() {
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
    const prevPrice = latestYesterday.rows[0] ? Number(latestYesterday.rows[0].indicator_value) : null;

    if (latestPrice !== null && prevPrice !== null) {
      const percentChange = ((latestPrice - prevPrice) / prevPrice) * 100;
      
      if (Math.abs(percentChange) >= THRESHOLD) {
        const emailBody = `
Current Gold Price: $${latestPrice.toFixed(2)}
Percentage Change: ${percentChange.toFixed(2)}%
Previous Price: $${prevPrice.toFixed(2)}
        `;

        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: EMAIL_RECIPIENTS,
          subject: 'Gold Price Alert',
          text: emailBody
        });

        console.log(`Alert sent: ${percentChange.toFixed(2)}% change detected`);
      }
    }
  } catch (err) {
    console.error('Error in price monitor:', err);
  }
}

// Run at 5 minutes past every hour
cron.schedule('5 * * * *', checkPriceChange);

console.log('Price monitor service started');