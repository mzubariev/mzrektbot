import fs from 'fs';
import logger from './logger.js';
import config from './configuration.js';
import axios from 'axios';

const ORDERBOOK_DEPTHS = [10, 20, 50, 100, 500, 1000];

export async function updateBinanceOrderBookInfo(binanceExchangeInfo) {
	try {
		logger.info('Starting to parse info into: ./binance-exchange-info.json. Takes ~2 minutes...');
		const filePath = 'binance-exchange-info.json';

		if (!binanceExchangeInfo) {
			logger.error('binanceExchangeInfo variable is empty!');
			return;
		}

		// Fetch the latest prices from Binance to calculate tickSizePercent
		const priceResponse = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
		const lastPrices = priceResponse.data.reduce((acc, item) => {
			acc[item.symbol] = parseFloat(item.price);
			return acc;
		}, {});

		// Iterate over each symbol and update order book data
		for (const symbol in binanceExchangeInfo) {
			// Recalculate orderBookStepPrcnt
			binanceExchangeInfo[symbol].orderBookStepPrcnt = (binanceExchangeInfo[symbol].tickSize / lastPrices[symbol]) * 100;

			// Find minimal depth that satisfies condition
			binanceExchangeInfo[symbol].orderBookMinimalDepth = ORDERBOOK_DEPTHS.find(depth => 
				binanceExchangeInfo[symbol].orderBookStepPrcnt * depth >= config.current.distanceFromCurrPriceToWallToCountBookMinDepthPrcnt
			) || 1000;

			// Fetch avgAsk and avgBid from Binance REST API
			const { avgAskVolume, avgBidVolume } = await getOrderBookAvgOrderSize(symbol, binanceExchangeInfo[symbol].orderBookMinimalDepth);

			// Update the token data
			binanceExchangeInfo[symbol].avgAskVolume = avgAskVolume;
			binanceExchangeInfo[symbol].avgBidVolume = avgBidVolume;
		}

		// Save updated info back to the file
		fs.writeFileSync(filePath, JSON.stringify(binanceExchangeInfo, null, 2));
		logger.info('Updated binance-exchange-info.json successfully!');

		return binanceExchangeInfo;
	} catch (error) {
		logger.error('Error updating Binance order book info:');
		console.error(error);
	}
}

export async function getOrderBookAvgOrderSize(symbol, orderBookMinimalDepth) {
	try {
		const response = await axios.get(`https://fapi.binance.com/fapi/v1/depth`, {
			params: { symbol: symbol.toUpperCase(), limit: orderBookMinimalDepth }
		});

		const { bids, asks } = response.data;

		// Calculate average bid size
		const totalBidSize = bids.reduce((sum, [_, volume]) => sum + parseFloat(volume), 0);
		const avgBidVolume = bids.length ? totalBidSize / bids.length : 0;

		// Calculate average ask size
		const totalAskSize = asks.reduce((sum, [_, volume]) => sum + parseFloat(volume), 0);
		const avgAskVolume = asks.length ? totalAskSize / asks.length : 0;

		return { avgAskVolume, avgBidVolume };

	} catch (error) {
		console.error(`Error fetching order book for ${symbol}:`, error.message);
		return { avgAskVolume: 0, avgBidVolume: 0 };
	}
}

export default { 
	updateBinanceOrderBookInfo,
	getOrderBookAvgOrderSize
};
