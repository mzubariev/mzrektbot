// trading-logic.js
import BinanceWssRestApi from '../binance/binance-wss-rest-api.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import config from '../utils/configuration.js';
import { calculateBidAmount, getOppositeTradeSide, translatePositionSide, getTokenTrend, getBotTradeSide, getPercentChange, getCurrentTimestamp } from '../utils/helpers.js';
import { enableIsolatedMarginForAll } from '../utils/setIsolatedMarginModeBinance.js';

const STUCK_ORDER_STATUSES_TO_ALERT = ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'];
const WINDOW_SIZE = 30; // 30 minutes (1-minute intervals)
const SKIP_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'ETHBTC'];

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey }) {
    this.telegramBot = null;
    this.binanceWs = new BinanceWssRestApi(binanceApiKey, binanceSecretKey);
    this.binanceExchangeInfo = null;
    this.allTokensList = null;
    this.buffers = {};
    this.pendingTrades = [];
    this.signalLog = [];
    this.tradeResults = [];
    this.liquidationTimers = {};
    this.isPaused = false;
    this.isStopped = false;

    logger.info('BOT Initialized with config: %j', config.current);

    config.on('statusChanged', ({ status }) => {
      this.handleStatusChange(status);
    });

    config.on('statistics', ({}) => {
      this.handleGetStatisticsInfo();
    });
  }

  async initialize(telegramBot) {
    try {
      // await enableIsolatedMarginForAll();

      await this.updateBinanceExchangeInfo();

      this.allTokensList.forEach(symbol => {
        this.buffers[symbol] = {
          index: 0,
          data: new Array(WINDOW_SIZE).fill(null)
        };
      });

      this.telegramBot = telegramBot;

      await this.binanceWs.connect();
      logger.info('Starting listeners for all data from Binance...');
      this.startMinuteTickListener();
      this.setAllIntervalTradeChecks();
      this.startLiquidationsListener();

    } catch (error) {
      logger.error(`Error initializing Trading Logic:`);
      console.error(error);
      throw error;
    }
  }

  /* Trading */

  getDataWindow(symbol, minutes) {
    const buffer = this.buffers[symbol];
    const result = [];
    for (let i = 0; i < minutes; i++) {
      const index = (buffer.index - 1 - i + WINDOW_SIZE) % WINDOW_SIZE;
      const data = buffer.data[index];
      if (data) result.unshift(data);
    }
    return result;
  }

  updateBuffer(symbol, newData) {
    const buffer = this.buffers[symbol];
    buffer.data[buffer.index] = newData;
    buffer.index = (buffer.index + 1) % WINDOW_SIZE;
    console.log(`UpdateBuffer:\n${JSON.stringify(buffer, null, 2)}\n`);
  }

  startMinuteTickListener() {
    console.log(this.allTokensList.length);
    console.log(this.buffers.length);
    this.binanceWs.events.on('message:minuteTick', (data) => {
      this.updateBuffer(data.symbol, data);
    });
  }
  
  startLiquidationsListener() {
    this.binanceWs.events.on('message:liquidation', async (liquidation) => {
      this.handleLiquidation(liquidation);
    });
  }

  handleLiquidation(liquidation) {
    const { s: symbol, S: side } = liquidation;

    if (this.shouldSkipSymbol(symbol)) {
      logger.warn(`Skipping unused tokens for now...`);
      return;
    }

    if (!this.liquidationTimers[symbol]) this.liquidationTimers[symbol] = [];
  
    const timer = setTimeout(async () => {

      await this.checkIfEnoughBalanceForBid(this.binanceWs);
      if (this.isStopped || this.isPaused) {
        return;
      }
      
      const m1 = this.getDataWindow(symbol, 1);
      if (!m1) return;
      const latest = m1[m1.length - 1];
      if (!latest) return;
  
      const priceChange = getPercentChange(m1[0]?.price, latest.price);
      const oiChange = getPercentChange(m1[0]?.openInterest, latest.openInterest);
  
      const direction = side === 'LONG' ? 'LONG' : 'SHORT';
      const valid = side === 'LONG'
        ? priceChange > 0 && oiChange > 0
        : priceChange < 0 && oiChange < 0;
  
      if (valid && this.filterLiquidationTrade(symbol, direction) && this.passesMomentumFilter(symbol, direction)) {
        this.logSignal(symbol, direction, `Liquidation of ${side}s + Price/OI ${side === 'LONG' ? 'rebound' : 'drop'} (post-30s)`);
      }

      this.liquidationTimers[symbol] = this.liquidationTimers[symbol].filter(t => t !== timer); // cleanup the executed timer
    }, 10000);
  
    this.liquidationTimers[symbol].push(timer);
  }

  getTakeProfitMultiplier(reason) {
    if (reason.includes('Liquidation')) return 0.0015;
    if (reason.includes('Volume spike')) return 0.003;
    return 0.002;
  }

  sumLastMinutes(m30, field, count, offset = 0) {
    return Array.from({ length: count }, (_, i) => {
      const dataPoint = m30[m30.length - 1 - offset - i];
      return dataPoint?.[field] || 0;
    }).reduce((acc, v) => acc + v, 0);
  }

  strategyEngine(symbol) {
    const m30 = this.getDataWindow(symbol, 30);
    if (m30.length < 2) return; // not enough even for 1m trades
  
    const current = m30[m30.length - 1];
    if (!current) return;
  
    const last = (offset) => m30[m30.length - 1 - offset];

    const priceChange1m = m30.length >= 2 ? getPercentChange(last(1)?.price, current.price) : null;
    // const cvdChange1m = m30.length >= 2 ? getPercentChange(last(1)?.cvd, current.cvd) : null;
    const oiChange1m = m30.length >= 2 ? getPercentChange(last(1)?.openInterest, current.openInterest) : null;
  
    const priceChange5m = m30.length >= 6 ? getPercentChange(last(5)?.price, current.price) : null;
    const priceChange15m = m30.length >= 16 ? getPercentChange(last(15)?.price, current.price) : null;
    const priceChange20m = m30.length >= 21 ? getPercentChange(last(20)?.price, current.price) : null;
  
    const oiChange12m = m30.length >= 13 ? getPercentChange(last(12)?.openInterest, current.openInterest) : null;
    const oiChange30m = m30.length === 30 ? getPercentChange(last(29)?.openInterest, current.openInterest) : null;
  
    const funding = current.funding;
  
    // Open Interest Triggers
    if (oiChange1m <= -1 && priceChange1m < 0.1) {
      if (this.filterTrade(symbol, 'SHORT') && this.passesMomentumFilter(symbol, 'SHORT', { rsiLow: 30 })) this.logSignal(symbol, 'SHORT', 'OI -1%+ down + Price down + CVD down (1m)');
    }

    // Include Volume exploasion
    if (m30.length >= 24) {
      const recentVolume12 = this.sumLastMinutes(m30, 'volume', 12);
      const previousVolume12 = this.sumLastMinutes(m30, 'volume', 12, 12);
    
      const volumeExploded = recentVolume12 >= 2 * previousVolume12;
    
      if (oiChange12m >= 2 && priceChange1m > 0.1 && volumeExploded) {
        if (this.filterTrade(symbol, 'LONG') && this.passesMomentumFilter(symbol, 'LONG', { rsiHigh: 70 })) {
          this.logSignal(symbol, 'LONG', 'OI +2% (12m) + Price up + Volume spike');
        }
      }
    }
  
    if (oiChange30m >= 15 && priceChange1m < 0.1) {
      if (this.filterTrade(symbol, 'SHORT') && this.passesMomentumFilter(symbol, 'SHORT')) this.logSignal(symbol, 'SHORT', 'OI +15% (30m) + Price/CVD down (1m)');
    }
  
    // Price Triggers
    if (priceChange5m >= 3 && oiChange1m > 0.2) {
      if (this.filterTrade(symbol, 'LONG') && this.passesMomentumFilter(symbol, 'LONG')) this.logSignal(symbol, 'LONG', 'Price +3% (5m) + OI/CVD up (1m)');
    }
  
    if (priceChange15m <= -10 && oiChange1m > 0.2) {
      if (this.filterTrade(symbol, 'LONG') && this.passesMomentumFilter(symbol, 'LONG')) this.logSignal(symbol, 'LONG', 'Price -10% (15m) + OI/CVD up (1m)');
    }
  
    if (priceChange20m >= 10 && oiChange1m < 0.2) {
      if (this.filterTrade(symbol, 'SHORT') && this.passesMomentumFilter(symbol, 'SHORT')) this.logSignal(symbol, 'SHORT', 'Price +10% (20m) + OI/CVD down (1m)');
    }
  
    // Funding Trigger
    if (funding <= -0.1 && priceChange1m > 0.1 && oiChange1m > 0.2) {
      if (this.filterTrade(symbol, 'LONG') && this.passesMomentumFilter(symbol, 'LONG')) this.logSignal(symbol, 'LONG', 'Funding -0.1% or less + OI/Price up (1m)');
    }
  }

  logSignal(symbol, direction, reason) {
    const url = `https://www.coinglass.com/tv/Binance_${symbol.toUpperCase()}`;
    const timestamp = getCurrentTimestamp();
    const latest = this.getDataWindow(symbol, 1)[0];
    const entryPrice = latest?.price;

    const tickSize = this.binanceExchangeInfo[symbol].tickSize;
  
    const rawTP = direction === 'LONG'
      ? entryPrice * (1 + this.getTakeProfitMultiplier(reason))
      : entryPrice * (1 - this.getTakeProfitMultiplier(reason));
  
    // const tickSize = getTickSize(symbol, entryPrice); // take from my config!!!
    const minTP = direction === 'LONG'
      ? entryPrice + tickSize
      : entryPrice - tickSize;
  
    const takeProfit = direction === 'LONG'
      ? Math.max(rawTP, minTP)
      : Math.min(rawTP, minTP);
  
    const trade = {
      timestamp,
      symbol,
      direction,
      reason,
      entryPrice,
      takeProfit,
      history: [],
      closed: false
    };
  
    this.signalLog.push({ ...trade, coinglass: url });
    this.pendingTrades.push(trade);
  
    console.log(`[${symbol}] ${direction} – ${reason}`);
    console.log(`🔗 ${url}\n`);
  }

  // FILTERS

  async checkIfEnoughBalanceForBid() {
    const amountForBid = calculateBidAmount(this.binanceWs);
    const availableBalance = this.binanceWs.accountInfo.availableBalance;

    if (availableBalance < amountForBid && !this.isPaused) {
      this.pause();
      logger.warn('Skip execution since the Bot is paused because there is not enough money for a bid!');
    } else if (availableBalance >= amountForBid && this.isPaused) {
      this.resume();
    }
  }

  isOnlyLongsOrShortsAllowed(positionSide) {
    if (config.current.longsOrShortsOrBoth.toUpperCase() !== 'BOTH' && (config.current.longsOrShortsOrBoth.toUpperCase() !== positionSide.toUpperCase())) {
      logger.warn(`Skipping the trade since it is ${positionSide} while the setting is only for ${config.current.longsOrShortsOrBoth}s!`);
      return;
    }
  }
  
  isAlreadyMaximumPositionsForToken(symbol, positionSide) {
    if (this.binanceWs.positionsInfo[symbol] && this.binanceWs.positionsInfo[symbol][positionSide] && this.binanceWs.positionsInfo[symbol][positionSide].ordersAmount >= config.current.sameSymbolOrdersLimit) {
      logger.warn(`Skipping the trade since there are already ${this.binanceWs.positionsInfo[symbol][positionSide].ordersAmount} orders opened for this token! Wait till they are closed...`);
      return;
    }
  }

  shouldSkipSymbol(symbol) {
    return (
      symbol.includes('USDC') ||
      symbol.includes('_') ||
      SKIP_SYMBOLS.includes(symbol)
    );
  }
  
  calculateRSI(symbol, period = 14) {
    const data = this.getDataWindow(symbol, period + 1);
    if (data.length <= period) return null;
  
    let gains = 0, losses = 0;
    for (let i = 1; i < data.length; i++) {
      const diff = data[i].price - data[i - 1].price;
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
  
    if (gains + losses === 0) return 50;
    const rs = gains / (losses || 1e-9);
    return 100 - (100 / (1 + rs));
  }
  
  passesMomentumFilter(symbol, direction, options = {}) {
    const rsi14 = this.calculateRSI(symbol, 14);
    const rsi7 = this.calculateRSI(symbol, 7);
    if (rsi14 === null || rsi7 === null) return true;
  
    const rsiThresholds = {
      LONG: options.rsiHigh ?? 75,
      SHORT: options.rsiLow ?? 25
    };
  
    if (direction === 'LONG' && (rsi14 > rsiThresholds.LONG || rsi7 > rsiThresholds.LONG)) return false;
    if (direction === 'SHORT' && (rsi14 < rsiThresholds.SHORT || rsi7 < rsiThresholds.SHORT)) return false;
    return true;
  }

  buildVolumeProfile(symbol, windowSize = 15) {
    const m = this.getDataWindow(symbol, windowSize);
    const volumeBins = {};
    const current = m[m.length - 1];
    if (!current) return [];
  
    const tickSize = this.binanceExchangeInfo[symbol].tickSize;
  
    m.forEach(({ price, volume }) => {
      if (!price || !volume) return;
      const step = Math.max(price * 0.001, tickSize * 5); // 0.1% range
      const bucket = Math.round(price / step) * step;
      volumeBins[bucket] = (volumeBins[bucket] || 0) + volume;
    });
  
    return Object.entries(volumeBins)
      .map(([level, vol]) => ({ level: parseFloat(level), volume: vol }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 6);
  }
  
  filterTrade(symbol, direction) {
    const profile = this.buildVolumeProfile(symbol);
    const latest = this.getDataWindow(symbol, 1)[0];
    if (!latest) return true;
    const { price } = latest;
  
    for (const { level } of profile) {
      const distance = Math.abs((level - price) / price) * 100;
      if (direction === 'LONG' && level > price && distance <= 0.2) return false;
      if (direction === 'SHORT' && level < price && distance <= 0.2) return false;
    }
  
    return true;
  }

  filterLiquidationTrade(symbol, direction) {
    const profile = this.buildVolumeProfile(symbol, 5);
    const latest = this.getDataWindow(symbol, 1)[0];
    if (!latest) return false;
    const { price } = latest;
  
    for (const { level } of profile) {
      const distance = Math.abs((level - price) / price) * 100;
      if (direction === 'LONG' && level < price && distance <= 0.2) return true;
      if (direction === 'SHORT' && level > price && distance <= 0.2) return true;
    }
  
    return false;
  }

  //

  async executeTrade(symbol, tradeSide) {
    try {
      // Send Market order
      const amountForBid = calculateBidAmount(this.binanceWs);
      const positionSide = translatePositionSide(tradeSide);

      if (this.isOnlyLongsOrShortsAllowed(positionSide) || this.isAlreadyMaximumPositionsForToken(symbol, positionSide)) {
        return;
      }

      const marketOrderResult = await this.executeMarketOrder(symbol, tradeSide, positionSide, amountForBid);
      if (!marketOrderResult) {
        return; 
      }

      // Send Limit order to close the Position with 0,2% profit 
      const avgEnterPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);
      await this.sendLimitOrderToClosePosition(symbol, tradeSide, positionSide, executedQuantity, avgEnterPrice);

    } catch (error) {
      throw new Error(`Trade execution failed for ${symbol}: ${error.message}`);
    }
  }

  async executeMarketOrder(symbol, tradeSide, positionSide, amountForBid) {
    logger.info(`Executing trade -> Token: ${symbol}, TradeSide: ${tradeSide} to ${positionSide}, Amount: ${amountForBid}`);
    
    try {
      const result = await this.executeBinanceMarketOrder(symbol, tradeSide, positionSide, amountForBid);
   
      logger.info('Market order executed successfully: %j', result);
      return result;
    } catch (error) {
      logger.error(`Error executing market order.`);
      console.error(error);
      throw error;
    }
  }

  async executeBinanceMarketOrder(symbol, tradeSide, positionSide, amountForBid) {
    try {      
      const lastPrice = await this.binanceWs.getSymbolLastPrice(symbol);
    
      if (!lastPrice) {
        throw new Error(`Price for ${symbol} is not available. Ensure the ticker subscription is active.`);
      }
  
      logger.info(`Current price for ${symbol}: ${lastPrice}`);

      const quantity = (amountForBid / lastPrice);
      const formatted_quantity = this.formatTokenQuantity(symbol, quantity);

      if (formatted_quantity <= 0) {
        logger.warn(`Skipping the trade - too small Bid for this token...`);
        return;
      }

      const order = {
        symbol: symbol,
        side: tradeSide,
        positionSide: positionSide,
        type: 'MARKET',
        quantity: formatted_quantity,
        newOrderRespType: 'RESULT'
      };

      logger.info('Placing the MARKET ORDER:\n%j', order);

      return await this.binanceWs.sendOrder(order);
    } catch (error) {
      logger.error(`Error executing MARKET ORDER.`);
      console.error(error);

      this.pause();

      throw error;
    }
  }

  calculateLimitOrderClosePositionPrice(symbol, positionSide, avgPrice) {
    const tickSize = this.binanceExchangeInfo[symbol].tickSize;
    const precision = tickSize.toFixed(10).replace(/0+$/, "").split(".")[1]?.length || 0;

    let formattedLimitPrice;
    if (positionSide === 'LONG') {
      const limitPrice = avgPrice * (1 + config.current.profitPercentage / 100);
      formattedLimitPrice = Math.ceil(limitPrice / tickSize) * tickSize;
    } else {
      const limitPrice = avgPrice * (1 - config.current.profitPercentage / 100);
      formattedLimitPrice = Math.floor(limitPrice / tickSize) * tickSize;
    }

    return parseFloat(formattedLimitPrice.toFixed(precision));
  }
  
  formatTokenQuantity(symbol, number) {
    const precision = this.binanceExchangeInfo[symbol].quantityPrecision;
    const factor = Math.pow(10, precision);
    return Math.floor(number * factor) / factor; // Always round down
  }

  async sendLimitOrderToClosePosition(symbol, marketOrderSide, positionSide, quantity, avgEnterPrice) {
    try {
      const limitOrderSide = getOppositeTradeSide(marketOrderSide);

      let accumulatedQuantity = null;
      let breakevenPrice = null;
      if (this.binanceWs.positionsInfo[symbol] && this.binanceWs.positionsInfo[symbol][positionSide]) {
        accumulatedQuantity = this.binanceWs.positionsInfo[symbol][positionSide].positionAmount;
        breakevenPrice = this.binanceWs.positionsInfo[symbol][positionSide].breakevenPrice;

        const orderId = this.binanceWs.positionsInfo[symbol][positionSide].lastClosingLimitOrderId;
        await this.binanceWs.cancelOrder(orderId, symbol);
      }

      const formattedLimitPrice = this.calculateLimitOrderClosePositionPrice(symbol, positionSide, breakevenPrice || avgEnterPrice);
  
      const limitOrder = {
        symbol: symbol,
        side: limitOrderSide,
        positionSide: positionSide,
        type: 'LIMIT',
        quantity: accumulatedQuantity || quantity,
        price: formattedLimitPrice,
        timeInForce: 'GTC',
        newOrderRespType: 'RESULT'
      };
  
      logger.info('Sending LIMIT ORDER to close the position:\n%j', limitOrder);
      const limitOrderResult = await this.binanceWs.sendOrder(limitOrder);
      logger.info('Limit order result:\n%j', limitOrderResult);
  
      this.binanceWs.positionsInfo[symbol][positionSide].lastClosingLimitOrderId = limitOrderResult.orderId;

      return limitOrderResult;
    } catch (error) {
      logger.error(`Error executing LIMIT ORDER:`);
      console.error(error);

      throw error;
    }
  }

  // Configurations routine

  handleStatusChange(status) {
    logger.info('Applying new status...');

    switch (status) {
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.resume();
        break;
      case 'stop':
        this.stop();
        break;
      case 'unstop':
        this.unstop();
        break;
      default:
        throw new Error(`Unsupported status to change: ${status}`);
    }
  }

  handleGetStatisticsInfo() {
    logger.info('=== INTERMEDIATE STATISTICS for BTC ===');
    console.log(`buffers:\n${JSON.stringify(this.buffers["BTCUSDT"], null, 2)}`);
  }

  async updateBinanceExchangeInfo() {
    const { formattedData, allTokensList } = await getBinanceExchangeInfo();
    this.binanceExchangeInfo = formattedData;
    this.allTokensList = allTokensList;
    this.binanceWs.updateAllTokensList(allTokensList);
  }

  updateDepositSizeConfig() {
    logger.info('Updating Deposit Size config...');
    const walletBalance = this.binanceWs.accountInfo.walletBalance;
    config.setConfig({ "depositSize": walletBalance });
  }

  pause() {
    this.isPaused = true;
    logger.warn('Trading logic paused!');
  }

  resume() {
    this.isPaused = false;
    logger.info('Trading logic resumed!');
  }

  stop() {
    this.isStopped = true;
    logger.warn('Trading logic stopped manually!');
  }

  unstop() {
    this.isStopped = false;
    logger.info('Trading logic unstopped manually!');
  }

  // All timers and intervals

  setAllIntervalTradeChecks() {
    const now = Date.now();
    const msToNextMinute = 60000 - (now % 60000);
    setTimeout(() => {
      setInterval(() => {
        this.allTokensList.forEach(symbol => this.strategyEngine(symbol));
      
        this.pendingTrades.forEach(trade => {
          if (trade.closed) return;
      
          const current = this.getDataWindow(trade.symbol, 1)[0];
          if (!current) return;
      
          trade.history.push(current.price);
      
          const hit = trade.direction === 'LONG'
            ? current.price >= trade.takeProfit
            : current.price <= trade.takeProfit;
      
          if (hit || trade.history.length >= 30) {
            trade.closed = true;
            const maxGain = trade.direction === 'LONG'
              ? Math.max(...trade.history)
              : Math.min(...trade.history);
      
            const maxGainPct = getPercentChange(trade.entryPrice, maxGain);
            const couldHit1pct = trade.direction === 'LONG'
              ? maxGainPct >= 1
              : maxGainPct <= -1;
      
            this.tradeResults.push({
              ...trade,
              TP_hit: hit,
              hitAtMinute: hit ? trade.history.length : null,
              finalPrice: current.price,
              percentChange: getPercentChange(trade.entryPrice, current.price).toFixed(2) + '%',
              maxGain: maxGain.toFixed(2),
              maxGainPct: maxGainPct.toFixed(2),
              couldHit1pct
            });
          }
        });
      }, 60000);
    
      // Export trade results and signal log every 5 minutes
      setInterval(() => {
        try {
          fs.writeFileSync('testing/signal-log.json', JSON.stringify(this.signalLog, null, 2));
          fs.writeFileSync('testing/trade-results.json', JSON.stringify(this.tradeResults, null, 2));
          console.log('💾 Exported signal log and trade results');
        } catch (err) {
          console.error('Error exporting data:', err.message);
        }
      }, 5 * 60 * 1000);
    }, msToNextMinute);
  }
}

export default TradingLogic;