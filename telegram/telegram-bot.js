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

    this.bot.onText(/\/stat/, () => {
      config.emit('statistics', {});
      this.sendMsgToTgChat('Sending an intermediate trading statistics to the console and to the chat...');
    });
    
    this.bot.onText(/\/pause/, () => {
      config.emit('statusChanged', { status: 'paused' });
      this.sendMsgToTgChat('Bot paused. Use /resume to restart trading.');
    });

    this.bot.onText(/\/resume/, () => {
      config.emit('statusChanged', { status: 'running' });
      this.sendMsgToTgChat('Bot resumed. Use /pause to pause trading.');
    });

    this.bot.onText(/\/info/, () => {
      this.sendMsgToTgChat("Let's roll!\nTo change settings, type /settings");
      const currentSettings = JSON.stringify(config.current, null, 2);
      this.sendMsgToTgChat(`Current Settings: ${currentSettings}`);
    });

    this.bot.onText(/\/settings/, () => {
      const settingsKeyboard = this.getSettingsKeyboard();
      this.bot.sendMessage(this.chatId, 'Bot Settings:', {
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
      [
        { text: 'Bot trade direction. Options: trend OR rebound', callback_data: 'setting_tradeDirection' },
        { text: 'Only LONGs or only SHORTs, or BOTH directions trades. Options: "long" / "short" / "both"', callback_data: 'setting_longsOrShortsOrBoth' }
      ],
      [
        { text: 'An orderbook depth to calculate support/resistance levels (ex.: 100)', callback_data: 'setting_orderbookDepth' },
        { text: 'A multiplier to detect huge limits levels (multiply to an average order amount. ex.: 3)', callback_data: 'setting_multiplierToDetectHugeOrdersVolumeFromAvg' },
        { text: 'Percentage, how close to levels we should avoid traids (ex.: 0.97 means 3%)', callback_data: 'setting_percentageHowCloseToLevels' }
      ],
      [
        { text: 'Minutes to cut candles from both sides to avoid trades there (in milliseconds)', callback_data: 'setting_timeToCheckForCandleEdges' },
        { text: 'How many positions of one side may be opened at the same time for the same token (ex.: 4)', callback_data: 'setting_sameSymbolOrdersLimit' },
        { text: 'Time to signal to TG for stuck limit orders (in minutes)', callback_data: 'setting_timeoutToSignalToTG' }
      ]
    ];
    return settingsKeyboard;
  }

  handleSettingChange(settingKey) {
    this.sendMsgToTgChat(`Please enter the new value for ${settingKey}:`);

    this.bot.once('message', (msg) => {
      const numericValue = parseFloat(msg.text, 10);
      const newValue = numericValue ? numericValue : msg.text;
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
