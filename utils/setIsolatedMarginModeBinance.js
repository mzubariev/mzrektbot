import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

const apiKey = process.env.BINANCE_HMAC_API_KEY;
const apiSecret = process.env.BINANCE_HMAC_SECRET_KEY;

const apiBaseURL = 'https://fapi.binance.com';

function generateSignature(queryString) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function fetchUSDTTradingPairs() {
  try {
    const response = await axios.get(`${apiBaseURL}/fapi/v1/exchangeInfo`);
    const pairs = response.data.symbols
      .filter((symbolInfo) => symbolInfo.quoteAsset === 'USDT')
      .map((symbolInfo) => symbolInfo.symbol);
    logger.info(`Fetched ${pairs.length} USDT pairs.`);
    return pairs;
  } catch (error) {
    logger.error('Error fetching trading pairs: %j', error.response?.data || error.message);
    throw error;
  }
}

async function enableIsolatedMargin(symbol) {
  const timestamp = Date.now();
  const params = new URLSearchParams({
    symbol,
    marginType: 'ISOLATED', // CROSSED
    timestamp,
  });

  const signature = generateSignature(params.toString());
  params.append('signature', signature);

  try {
    const response = await axios.post(
      `${apiBaseURL}/fapi/v1/marginType`,
      params,
      {
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
      }
    );
    logger.info(`Isolated margin enabled for ${symbol}: %j`, response.data);
  } catch (error) {
    logger.error(`Error enabling isolated margin for ${symbol}: %j`, error.response?.data || error.message);
  }
}

export async function enableIsolatedMarginForAll() {
  try {
    const usdtPairs = await fetchUSDTTradingPairs();

    for (const pair of usdtPairs) {
      await enableIsolatedMargin(pair);
      await new Promise((resolve) => setTimeout(resolve, 500)); // Add delay to avoid rate limits
    }

    logger.info('Isolated margin mode set for all USDT pairs.');
  } catch (error) {
    logger.error(`Error enabling isolated margin for all pairs:`);
    console.error(error);
  }
}
