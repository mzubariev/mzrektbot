import axios from 'axios';
import fs from 'fs';
import logger from './logger.js';

async function getBinanceExchangeInfo() {
  try {
    const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const data = response.data;

    // Process the data to only include relevant fields
    const formattedData = data.symbols.reduce((acc, symbolInfo) => {
      const priceFilter = symbolInfo.filters.find(filter => filter.filterType === 'PRICE_FILTER');
      const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : null;

      if (!symbolInfo.symbol.includes('USDC')) {
        acc[symbolInfo.symbol] = {
          pricePrecision: symbolInfo.pricePrecision,
          quantityPrecision: symbolInfo.quantityPrecision,
          baseAssetPrecision: symbolInfo.baseAssetPrecision,
          quotePrecision: symbolInfo.quotePrecision,
          tickSize: tickSize
        };
      }

      return acc;
    }, {});

    fs.writeFileSync('binance-exchange-info.json', JSON.stringify(formattedData, null, 2));
    logger.info('Tokens configs from Binance are updated and saved to: ./binance-exchange-info.json');

    return formattedData;
  } catch (error) {
    logger.error('Error fetching exchange info: %s', error);
  }
}

export default getBinanceExchangeInfo;