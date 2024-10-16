const { config } = require('dotenv-vault').config();
const TradingLogic = require('./trading/trading-logic');
const TelegramBotWrapper = require('./telegram/telegram-bot');
const logger = require('./logger');
const cron = require('node-cron');
const getTokenData = require('./utils/coinmarketcap-token-data');

async function main() {
  try {
    // Initialize Trading Logic Module
    const tradingLogic = new TradingLogic({
      binanceApiKey: config.BINANCE_API_KEY,
      binanceSecretKey: config.BINANCE_SECRET_KEY,
      bybitApiKey: config.BYBIT_API_KEY,
      bybitSecretKey: config.BYBIT_SECRET_KEY,
      okxApiKey: config.OKX_API_KEY,
      okxSecretKey: config.OKX_SECRET_KEY,
      okxPassphrase: config.OKX_PASSPHRASE,
      mexcApiKey: config.MEXC_API_KEY,
      mexcSecretKey: config.MEXC_SECRET_KEY,
      isTestnet: config.IS_TESTNET
    });
    await tradingLogic.initialize();

    // Start Telegram Bot
    const telegramBot = new TelegramBotWrapper(config.TELEGRAM_BOT_TOKEN);
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