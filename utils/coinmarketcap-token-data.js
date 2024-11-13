import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import logger from '../utils/logger.js';

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
    fs.writeFileSync('token-data.json', JSON.stringify({ top20: top20Tokens, top50: top50Tokens }));
    logger.info('All top tokens just got updated from CoinMarketCap!');

    return { top20: top20Tokens, top50: top50Tokens };
  } catch (error) {
    logger.error('Error retrieving token data from CoinMarketCap:', error);
    throw error;
  }
}

export default getTokenData;