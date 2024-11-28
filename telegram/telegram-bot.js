// telegram-bot.js
import TelegramBot from 'node-telegram-bot-api';
import config from '../utils/configuration.js';
import logger from '../utils/logger.js';

class TelegramBotWrapper {
  constructor(token, chatId) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
  }

  start() {
    logger.info('Telegram Bot started!');

    this.bot.onText(/\/pause/, () => {
      config.emit('configUpdated', { status: 'paused' });
      this.sendMsgToTgChat('Bot paused. Use /resume to restart.');
    });

    this.bot.onText(/\/resume/, () => {
      config.emit('configUpdated', { status: 'running' });
      this.sendMsgToTgChat('Bot resumed.');
    });

    this.bot.onText(/\/start/, () => {
      this.sendMsgToTgChat("Let's roll!\nTo change settings, type /settings");
      const currentSettings = JSON.stringify(config.config, null, 2);
      this.sendMsgToTgChat(`Current Settings: ${currentSettings}`);
    });

    this.bot.onText(/\/settings/, () => {
      const settingsKeyboard = this.getSettingsKeyboard();
      this.sendMsgToTgChat('Bot Settings:', {
        reply_markup: {
          inline_keyboard: settingsKeyboard,
        },
      });
    });

    this.bot.on('callback_query', (callbackQuery) => {
      const data = callbackQuery.data;

      if (data.startsWith('setting_')) {
        const settingKey = data.replace('setting_', '');
        this.handleSettingChange(settingKey);
      }
    });
  }

  getSettingsKeyboard() {
    const settingsKeyboard = [
      [
        { text: 'Top20 tokens Liquidation amount', callback_data: 'setting_top20Liquidation' },
        { text: 'Top50 tokens Liquidation amount', callback_data: 'setting_top50Liquidation' },
        { text: 'Small tokens Liquidation amount', callback_data: 'setting_smallLiquidation' }
      ],
      [
        { text: 'Deposit Size', callback_data: 'setting_depositSize' },
        { text: 'Bid % for each trade', callback_data: 'setting_bidPercentage' },
        { text: 'Profit % for each trade', callback_data: 'setting_profitPercentage' }
      ],
      [{ text: 'Bot trade direction. Options: trend OR rebound', callback_data: 'setting_tradeDirection' }]
    ];
    return settingsKeyboard;
  }

  handleSettingChange(settingKey) {
    this.sendMsgToTgChat(`Please enter the new value for ${settingKey}:`);

    this.bot.once('message', (msg) => {
      const newValue = parseInt(msg.text, 10);
      config.setConfig({ [settingKey]: newValue });
      logger.info(`Setting ${settingKey} updated to ${newValue}`);
      this.sendMsgToTgChat(`Setting ${settingKey} updated to ${newValue}`);
    });
  }

  sendMsgToTgChat(msg) {
    try {
      this.bot.sendMessage(this.chatId, msg, { 
        disable_web_page_preview: true, 
        parse_mode: 'HTML' 
      });
    } catch(error) {
      logger.error(error);
    }
  }
}

export default TelegramBotWrapper;
