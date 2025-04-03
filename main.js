// main.js
import dotenv from 'dotenv';
import TradingLogic from './trading/trading-logic.js';
import TelegramBotWrapper from './telegram/telegram-bot.js';
import logger from './utils/logger.js';
import cron from 'node-cron';
import { enableIsolatedMarginForAll } from './utils/setIsolatedMarginModeBinance.js';

dotenv.config();

async function main() {
  try {
    // Start Telegram Bot
    const telegramBot = new TelegramBotWrapper(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    telegramBot.start();

    // Initialize Trading Logic Module with sensitive information from .env
    const tradingLogic = new TradingLogic({
      binanceApiKey: process.env.BINANCE_API_KEY,
      binanceSecretKey: process.env.BINANCE_SECRET_KEY
    });
    // Start trading
    await tradingLogic.initialize(telegramBot);

    // Schedule isolated margin mode update for all tokens on Binance - every Sunday at 00:00
    cron.schedule('0 0 * * 0', () => {
      try {
        logger.info('CRON: Set Isolated margin mode to all USDT pairs on Binance!');
        enableIsolatedMarginForAll();
        logger.info('The Isolated margin mode has been set for all USDT pairs on Binance!');
      } catch (error) {
        logger.error(`Error setting Isolated margin mode to all USDT pairs on Binance.`);
        console.error(error);
      }
    });

    // Schedule Binance all tokens info updates - every day at 00:00
    cron.schedule('0 0 * * *', async () => {
      try {
        logger.info('CRON: Running Binance info updates!');

        await tradingLogic.updateBinanceExchangeInfo();
        logger.info('Binance Exchnage info with all tokens details updated successfully!');
      } catch (error) {
        logger.error(`Error updating data via cron task:`);
        console.error(error);
      }
    });

    // Schedule Wallet Amount (deposit size) auto-update in config - at the start of every hour
    cron.schedule('0 * * * *', () => {
      try {
        logger.info('CRON: Running Deposit Size update!');

        tradingLogic.updateDepositSizeConfig();
        
        logger.info('Deposit Size config updated successfully!');
      } catch (error) {
        logger.error(`Error updating deposit size config via cron task:`);
        console.error(error);
      }
    });
  } catch (error) {
    logger.error(`Bot initialization error:`);
    console.error(error);
    process.exit(1);
  }
}

main();
