import axios from 'axios';
import fs from 'fs';
import logger from './logger.js';

const ORDERBOOK_DEPTHS = [10, 20, 50, 100, 500, 1000];

async function getBinanceExchangeInfo() {
  try {
    logger.info('Starting to parse info to: ./binance-exchange-info.json. Takes ~2 minutes...');

    const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const data = response.data;

    // Process the data to include relevant fields
    const formattedData = data.symbols.reduce((acc, symbolInfo) => {
      const priceFilter = symbolInfo.filters.find(filter => filter.filterType === 'PRICE_FILTER');
      const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : null;

      acc[symbolInfo.symbol] = {
        quantityPrecision: symbolInfo.quantityPrecision,
        tickSize
      };

      return acc;
    }, {});

    fs.writeFileSync('binance-exchange-info.json', JSON.stringify(formattedData, null, 2));
    logger.info('Tokens configs from Binance are updated and saved to: ./binance-exchange-info.json');

    return formattedData;
  } catch (error) {
    logger.error('Error fetching exchange info:');
    console.error(error);
  }
}

export default getBinanceExchangeInfo;
