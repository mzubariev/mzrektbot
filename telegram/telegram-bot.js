// telegram-bot.js
import TelegramBot from 'node-telegram-bot-api';
import Configuration from '../utils/configuration.js';
import logger from '../utils/logger.js';

const config = new Configuration('./config.json');

class TelegramBotWrapper {
  constructor(token) {
    this.bot = new TelegramBot(token, { polling: true });
    this.isRunning = true;
  }

  start() {
    this.bot.onText(/\/pause/, (msg) => {
      const chatId = msg.chat.id;
      this.isRunning = false;
      config.emit('configUpdated', { status: 'paused' });
      this.bot.sendMessage(chatId, 'Bot paused. Use /resume to restart.');
    });

    this.bot.onText(/\/resume/, (msg) => {
      const chatId = msg.chat.id;
      this.isRunning = true;
      config.emit('configUpdated', { status: 'running' });
      this.bot.sendMessage(chatId, 'Bot resumed.');
    });

    this.bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      this.bot.sendMessage(chatId, 'Welcome to the Crypto Trading Bot!');
    });

    this.bot.onText(/\/settings/, (msg) => {
      const chatId = msg.chat.id;
      const settingsKeyboard = this.getSettingsKeyboard();
      this.bot.sendMessage(chatId, 'Bot Settings:', {
        reply_markup: {
          inline_keyboard: settingsKeyboard,
        },
      });
    });

    this.bot.on('callback_query', (callbackQuery) => {
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;

      if (data.startsWith('setting_')) {
        const settingKey = data.replace('setting_', '');
        this.handleSettingChange(chatId, settingKey);
      }
    });

    // Listen for real-time config updates and notify the bot
    config.on('configUpdated', (newConfig) => {
      logger.info('Configuration updated via Telegram:', newConfig);
      // Optionally broadcast updates to active users or logs without referencing chatId
    });
  }

  getSettingsKeyboard() {
    const settingsKeyboard = [
      [
        { text: 'Top20 tokens Liquidation amount', callback_data: 'setting_top20Liquidation' },
        { text: 'Top50 tokens Liquidation amount', callback_data: 'setting_top50Liquidation' },
      ],
      [
        { text: 'Small tokens Liquidation amount', callback_data: 'setting_smallLiquidation' },
        { text: 'Deposit Size', callback_data: 'setting_depositSize' },
      ],
      [{ text: 'Bid % for each trade', callback_data: 'setting_bidPrcnt' }],
    ];
    return settingsKeyboard;
  }

  handleSettingChange(chatId, settingKey) {
    this.bot.sendMessage(chatId, `Please enter the new value for ${settingKey}:`);

    this.bot.once('message', (msg) => {
      const newValue = parseInt(msg.text, 10);
      config.setConfig({ [settingKey]: newValue });
      logger.info(`Setting ${settingKey} updated to ${newValue}`);
      this.bot.sendMessage(chatId, `Setting ${settingKey} updated to ${newValue}`);

      // Emit a config update with context for potential logging or other uses
      config.emit('configUpdated', { [settingKey]: newValue });
    });
  }
}

export default TelegramBotWrapper;
