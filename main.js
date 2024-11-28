// main.js
import dotenv from 'dotenv';
import TradingLogic from './trading/trading-logic.js';
import TelegramBotWrapper from './telegram/telegram-bot.js';
import logger from './utils/logger.js';
import cron from 'node-cron';
import getMarketCapTokenData from './utils/coinmarketcap-token-data.js';
import getBinanceExchangeInfo from './utils/binance-exchange-info.js';

dotenv.config();

async function main() {
  try {
    // Start Telegram Bot
    const telegramBot = new TelegramBotWrapper(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    telegramBot.start();

    // Initialize Trading Logic Module with sensitive information from .env
    const tradingLogic = new TradingLogic({
      binanceApiKey: process.env.BINANCE_API_KEY,
      binanceSecretKey: process.env.BINANCE_SECRET_KEY,
      bybitApiKey: process.env.BYBIT_API_KEY,
      bybitSecretKey: process.env.BYBIT_SECRET_KEY,
      okxApiKey: process.env.OKX_API_KEY,
      okxSecretKey: process.env.OKX_SECRET_KEY,
      okxPassphrase: process.env.OKX_PASSPHRASE,
      mexcApiKey: process.env.MEXC_API_KEY,
      mexcSecretKey: process.env.MEXC_SECRET_KEY
    });
    // Start trading
    await tradingLogic.initialize(telegramBot);

    // Schedule token data update
    cron.schedule('0 0 * * *', async () => {
      try {
        logger.info('CRON: Running CMC and Binance info updates!');

        const tokenData = await getMarketCapTokenData();
        tradingLogic.updateMarketCapTokenData(tokenData);
        logger.info('Token data updated successfully!');

        const binanceExchangeInfo = await getBinanceExchangeInfo();
        tradingLogic.updateBinanceExchangeInfo(binanceExchangeInfo);
        logger.info('Binance Exchnage data updated successfully!');
      } catch (error) {
        logger.error('Error updating data via cron task: %j', error);
      }
    });
  } catch (error) {
    logger.error('Bot initialization error: %j', error);
    process.exit(1);
  }
}

main();
