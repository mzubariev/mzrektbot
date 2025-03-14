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
      this.sendMsgToTgChat('Sending an intermediate trading statistics to the console and to the chat...');
      config.emit('statistics', {});
    });
    
    this.bot.onText(/\/pause/, () => {
      config.emit('statusChanged', { status: 'pause' });
      this.sendMsgToTgChat('Bot paused. Use /resume to restart trading.');
    });

    this.bot.onText(/\/resume/, () => {
      config.emit('statusChanged', { status: 'resume' });
      this.sendMsgToTgChat('Bot resumed. Use /pause to pause trading.');
    });

    this.bot.onText(/\/stop/, () => {
      config.emit('statusChanged', { status: 'stop' });
      this.sendMsgToTgChat('Bot stopped. Use /unstop to continue trading.');
    });

    this.bot.onText(/\/unstop/, () => {
      config.emit('statusChanged', { status: 'unstop' });
      this.sendMsgToTgChat('Bot unstopped. Use /stop to stop trading.');
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
        { text: 'Deposit Size', callback_data: 'setting_depositSize' },
        { text: 'Bid % for each trade', callback_data: 'setting_bidPercentage' }
      ],
      [
        { text: 'Profit % for each trade (ex.: 0.2)', callback_data: 'setting_profitPercentage' },
        { text: 'Time to signal to TG for stuck limit orders (in minutes)', callback_data: 'setting_timeoutToSignalToTG' }
      ],
      [
        { text: 'Bot trade direction (trend OR rebound)', callback_data: 'setting_tradeDirection' },
        { text: 'Only LONGs or only SHORTs, or BOTH directions trades ("long" / "short" / "both")', callback_data: 'setting_longsOrShortsOrBoth' },
        { text: 'Is allowed to try trading the opposite side if directly is resistance/support (1 or 0)', callback_data: 'setting_isAllowedToTradeOpposite' },
      ],
      [
        { text: 'Global candle interval (ex.: 30m-1h-4h)', callback_data: 'setting_globalCandleInterval' },
        { text: 'Local candle interval (ex.: 1m-3m-5m-15m)', callback_data: 'setting_localCandleInterval' }
      ],
      [
        { text: 'A multiplier to detect huge limits levels (* avg_bid_size (ex.: 1.5)', callback_data: 'setting_multiplierToDetectHugeOrdersVolumeFromAvg' },
        { text: 'A multiplier to detect significant Rekt volumes to trigger the trade (* avg_bid_size (ex.: 1)', callback_data: 'setting_multiplierForRektThreshold' }
      ],
      [
        { text: '%, how close to levels we should avoid traids (ex.: 0.3)', callback_data: 'setting_percentageHowCloseToLevels' },
        { text: '%, how much movement distance do we need to calculate minimal orderBook depth (ex.: 0.8)', callback_data: 'setting_distanceFromCurrPriceToWallToCountBookMinDepthPrcnt' }
      ],
      [
        { text: 'Minutes to cut the bigger candle from both sides to avoid trades there (in minutes)', callback_data: 'setting_timeToCheckForCandleEdges' },
        { text: 'How many positions of one side may be opened at the same time for the same token (ex.: 4)', callback_data: 'setting_sameSymbolOrdersLimit' }
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
      console.error(error);
    }
  }
}

export default TelegramBotWrapper;
