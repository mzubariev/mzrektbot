import axios from 'axios';
import fs from 'fs';
import logger from './logger.js';
import config from './configuration.js';
import { getOrderBookAvgOrderSize } from './updateBinanceOrderBookInfo.js';

const ORDERBOOK_DEPTHS = [10, 20, 50, 100, 500, 1000];

async function getBinanceExchangeInfo() {
  try {
    logger.info('Starting to parse info to: ./binance-exchange-info.json. Takes ~2 minutes...');

    const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const data = response.data;

    // Fetch the latest prices from Binance to calculate tickSizePercent
    const priceResponse = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
    const prices = priceResponse.data.reduce((acc, item) => {
      acc[item.symbol] = parseFloat(item.price);
      return acc;
    }, {});

    // Process the data to include relevant fields
    const formattedData = data.symbols.reduce((acc, symbolInfo) => {
      const priceFilter = symbolInfo.filters.find(filter => filter.filterType === 'PRICE_FILTER');
      const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : null;
      const currentPrice = prices[symbolInfo.symbol] || null;

      if (!symbolInfo.symbol.includes('USDC') && tickSize && currentPrice) {
        const orderBookStepPrcnt = (tickSize / currentPrice) * 100;

        // Find the smallest multiplier that satisfies the condition
        const orderBookMinimalDepth = ORDERBOOK_DEPTHS.find(depth => orderBookStepPrcnt * depth >= config.current.distanceFromCurrPriceToWallToCountBookMinDepthPrcnt) || 1000;

        acc[symbolInfo.symbol] = {
          quantityPrecision: symbolInfo.quantityPrecision,
          tickSize,
          orderBookStepPrcnt,
          orderBookMinimalDepth
        };
      }

      return acc;
    }, {});

    for (const symbol in formattedData) {
			// Fetch avgAsk and avgBid from Binance REST API
			const { avgAskVolume, avgBidVolume } = await getOrderBookAvgOrderSize(symbol, formattedData[symbol].orderBookMinimalDepth);

			// Update the token data
			formattedData[symbol].avgAskVolume = avgAskVolume;
			formattedData[symbol].avgBidVolume = avgBidVolume;
		}

    fs.writeFileSync('binance-exchange-info.json', JSON.stringify(formattedData, null, 2));
    logger.info('Tokens configs from Binance are updated and saved to: ./binance-exchange-info.json');

    return formattedData;
  } catch (error) {
    logger.error('Error fetching exchange info:');
    console.error(error);
  }
}

export default getBinanceExchangeInfo;
