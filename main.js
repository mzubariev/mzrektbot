// main.js
import dotenv from 'dotenv';
import TradingLogic from './trading/trading-logic.js';
import TelegramBotWrapper from './telegram/telegram-bot.js';
import logger from './logger.js';
import cron from 'node-cron';
import getTokenData from './utils/coinmarketcap-token-data.js';

dotenv.config();

async function main() {
  try {
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
      mexcSecretKey: process.env.MEXC_SECRET_KEY,
      isTestnet: process.env.IS_TESTNET
    });
    await tradingLogic.initialize();

    // Start Telegram Bot
    const telegramBot = new TelegramBotWrapper(process.env.TELEGRAM_BOT_TOKEN);
    telegramBot.start();

    // Schedule token data update
    cron.schedule('0 0 * * *', async () => {
      try {
        const tokenData = await getTokenData();
        tradingLogic.updateTokenData(tokenData);
        logger.info('Token data updated successfully');
      } catch (error) {
        logger.error('Error updating token data:', error);
      }
    });

    // Start trading
    tradingLogic.startTrading();
  } catch (error) {
    logger.error('Bot initialization error:', error);
    process.exit(1);
  }
}

main();
