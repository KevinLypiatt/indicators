// gold_uk.js
const axios = require('axios');
const cheerio = require('cheerio');

const fetchGoldUK = async () => {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36', // Mimic a real browser
      'Accept-Language': 'en-US,en;q=0.9', // Set preferred language
      'Accept-Encoding': 'gzip, deflate, br'
    };

    const response = await axios.get('https://www.bullionbypost.co.uk/gold-price/', { headers });
    response.data = response.data.replaceAll("&#163;","£");
    const $ = cheerio.load(response.data);

    // Inspect the site for the price element (this is a guess - adjust after checking HTML)
    //After looking at the source of the page, this is where the price is contained.
    const priceText = $('#spotprice-table tbody tr:first-child td:last-child').text().trim()
    const goldPrice = parseFloat(priceText.replace(/[^0-9.]/g, '')); // Strip £, commas, etc.

    if (!isNaN(goldPrice)) {
      console.log(`Gold UK Price: £${goldPrice.toFixed(2)}`);
    } else {
      console.error('Failed to parse Gold UK price from page');
    }
  } catch (err) {
    if (err.response) {
      console.error('Error fetching Gold UK price:', err.response.status, err.response.statusText);
        if(err.response.status === 403){
            console.error("The 403 error persists, this means they are actively detecting your scraper. A different website, or a more sophisticated scraper may be needed.")
        }
    } else {
      console.error('Error fetching Gold UK price:', err.message);
    }
  }
};

fetchGoldUK();
