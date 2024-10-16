const TelegramBot = require('node-telegram-bot-api');

class TelegramBotWrapper {
  constructor(token, config, tradingLogic) {
    this.bot = new TelegramBot(token, { polling: true });
    this.config = config;
    this.tradingLogic = tradingLogic;
    this.isRunning = true;
  }

  start() {
    this.bot.onText(/\/pause/, (msg) => {
      const chatId = msg.chat.id;
      this.isRunning = false;
      this.tradingLogic.pause();
      this.bot.sendMessage(chatId, 'Bot paused. Use /resume to restart.');
    });

    this.bot.onText(/\/resume/, (msg) => {
      const chatId = msg.chat.id;
      this.isRunning = true;
      this.tradingLogic.resume();
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
      const newValue = msg.text;
      this.config.setConfig({ [settingKey]: newValue });
      this.bot.sendMessage(chatId, `Setting ${settingKey} updated to ${newValue}`);
    });
  }

  sendMessage(chatId, message) {
    this.bot.sendMessage(chatId, message);
  }
}

module.exports = TelegramBotWrapper;
