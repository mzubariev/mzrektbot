// const { config } = require('dotenv-vault').config();
import dotenv from 'dotenv';
const TradingLogic = require('./trading/trading-logic');
const TelegramBotWrapper = require('./telegram/telegram-bot');
const logger = require('./logger');
const cron = require('node-cron');
const getTokenData = require('./utils/coinmarketcap-token-data');

dotenv.config();

async function main() {
  try {
    // Initialize Trading Logic Module
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