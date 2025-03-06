require('dotenv').config();
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');

// Validate environment variables
const requiredEnvVars = [
  'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT', 
  'PROMPT_GOLD', 'PROMPT_BITCOIN', 'PROMPT_UK_GILTS', 'PROMPT_US_TREASURY', 
  'PERPLEXITY_KEY'
];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const prompts = {
  gold: {
    prompt: process.env.PROMPT_GOLD,
    delay: 2000
  },
  bitcoin: {
    prompt: process.env.PROMPT_BITCOIN,
    delay: 2000
  },
  uk_gilts: {
    prompt: process.env.PROMPT_UK_GILTS,
    delay: 2000
  },
  us_treasury: {
    prompt: process.env.PROMPT_US_TREASURY,
    delay: 2000
  }
};

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

const fetchIndicator = async (key, config) => {
  try {
    console.log(`Fetching ${key} data...`);
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [{ role: 'user', content: config.prompt }]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const content = response.data.choices[0].message.content;
    console.log(`Raw ${key} response:`, content);
    
    // Enhanced JSON extraction
    let jsonContent = content;
    if (content.includes('```')) {
      const matches = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      jsonContent = matches ? matches[1] : content;
    }
    
    // Clean any remaining whitespace and attempt to parse
    jsonContent = jsonContent.trim();
    
    try {
      return JSON.parse(jsonContent);
    } catch (parseError) {
      console.error(`JSON parse error for ${key}:`, parseError.message);
      console.error('Attempted to parse:', jsonContent);
      return null;
    }
  } catch (err) {
    console.error(`Error fetching ${key}:`, err.message);
    if (err.response) {
      console.error('API response error:', err.response.data);
    }
    return null;
  }
};

const storeIndicator = async (type, country, value) => {
  if (!isNaN(value)) {
    await pool.query(
      'INSERT INTO time_series (indicator_type, indicator_country, indicator_value) VALUES ($1, $2, $3)',
      [type, country, value.toFixed(2)]
    );
    console.log(`${type} ${value.toFixed(2)} stored at ${new Date().toISOString()}`);
  } else {
    console.error(`Failed to parse ${type}:`, value);
  }
};

const dataCollector = async (collectBonds = true) => {
  try {
    let result = {};

    // Sequential fetching with delays
    for (const [key, config] of Object.entries(prompts)) {
      const data = await fetchIndicator(key, config);
      if (data) {
        result = { ...result, ...data };
      }
      console.log(`Waiting ${config.delay}ms before next request...`);
      await delay(config.delay);
    }

    console.log('Combined market data:', result);

    // Store gold price and bitcoin
    const commodities = {
      'gold_usd': ['gold', 'USA'],
      'bitcoin': ['bitcoin', 'USA']
    };

    for (const [key, [type, country]] of Object.entries(commodities)) {
      const value = Number(result[key]);
      await storeIndicator(type, country, value);
    }

    // Store UK bond yields and US treasury only if collectBonds is true
    if (collectBonds) {
      const indicators = {
        'gilt_2yr': ['gilt_2y', 'UK'],
        'gilt_10yr': ['gilt_10y', 'UK'],
        'gilt_30yr': ['gilt_30y', 'UK'],
        'us_10yr': ['treasury_10y', 'USA']
      };

      for (const [key, [type, country]] of Object.entries(indicators)) {
        const value = Number(result[key]);
        await storeIndicator(type, country, value);
      }
    }
  } catch (err) {
    console.error('Error in data collection:', err.message);
    if (err.response) {
      console.error('API response error:', err.response.data);
    }
  }
};

const startCollector = async () => {
  try {
    await createTables();
    console.log('Starting AI data collector...');
    cron.schedule('0 * * * *', async () => {
      console.log('Running scheduled data collection...');
      await dataCollector(false); // Collect without bonds data
    });
    // Initial data collection with bonds data
    await dataCollector(true);
  } catch (err) {
    console.error('Failed to start data collector:', err.stack);
    process.exit(1);
  }
};

startCollector();