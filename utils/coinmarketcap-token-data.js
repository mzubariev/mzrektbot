import dotenv from 'dotenv';
const axios = require('axios');

dotenv.config();

async function getTokenData() {
  try {
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
      },
      params: {
        limit: 100,  // Fetch top 100 to ensure we have enough data
        convert: 'USDT'
      }
    });

    const tokenData = response.data.data;

    // Filter and process token data
    const top20Tokens = tokenData.slice(0, 20).map(token => token.symbol);
    const top50Tokens = tokenData.slice(0, 50).map(token => token.symbol);

    // Save token data to JSON file
    const fs = require('fs');
    fs.writeFileSync('token-data.json', JSON.stringify({ top20: top20Tokens, top50: top50Tokens }));

    return { top20: top20Tokens, top50: top50Tokens };
  } catch (error) {
    console.error('Error retrieving token data from CoinMarketCap:', error);
    throw error;
  }
}

module.exports = getTokenData;