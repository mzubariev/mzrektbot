const axios = require('axios');

async function getTokenData() {
  try {
    const response = await axios.get('https://api.coinmarketcap.com/v1/ticker/');
    const tokenData = response.data;

    // Filter and process token data
    const top20Tokens = tokenData.slice(0, 20);
    const top50Tokens = tokenData.slice(0, 50);

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
