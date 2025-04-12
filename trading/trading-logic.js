// trading-logic.js
import BinanceWssRestApi from '../binance/binance-wss-rest-api.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import getMarketCapTokenData from '../utils/coinmarketcap-token-data.js';
import config from '../utils/configuration.js';
import { calculateBidAmount, getOppositeTradeSide, translatePositionSideToTradeSide, getPercentChange, getCurrentTimestamp, sumLastMinutes, shouldSkipSymbol } from '../utils/helpers.js';

const WINDOW_SIZE = 30; // 30 minutes (1-minute intervals)
const DEFAULT_SLIPPAGE_FOR_TESTING = 0.0012;
const DEFAULT_SPREAD_FOR_TESTING = 0.0006;

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey }) {
    this.telegramBot = null;
    this.binanceWs = new BinanceWssRestApi(binanceApiKey, binanceSecretKey);
    this.binanceExchangeInfo = null;
    this.marketCapTokenData = null;
    this.allTokensList = null;
    this.buffers = {};
    this.pendingTrades = [];
    this.signalLog = [];
    this.tradeResults = [];
    this.executionDiagnostics = [];
    this.tradeHistory = [];
    this.liquidationVolumeBySymbol = {};
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
      await this.updateMarketCapTokenData(); 
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

  /* Subscriptions to the Binance events to collect a data */

  startMinuteTickListener() {
    this.binanceWs.events.on('message:minuteTick', (data) => {
      this.updateBuffer(data.symbol, data);
    });
  }
  
  startLiquidationsListener() {
    this.binanceWs.events.on('message:liquidation', async (liquidation) => {
      this.handleLiquidation(liquidation);
    });
  }

  updateBuffer(symbol, data) {
    this.buffers[symbol].data[this.buffers[symbol].index] = data;
    this.buffers[symbol].index = (this.buffers[symbol].index + 1) % WINDOW_SIZE;
  }

  getDataWindow(symbol, minutes) {
    const buffer = this.buffers[symbol];
    const result = [];
    for (let i = 0; i < minutes; i++) {
      const index = (buffer.index - 1 - i + WINDOW_SIZE) % WINDOW_SIZE;
      const data = buffer.data[index];
      if (!data || !data.price) break; // stop collecting if gap
      result.unshift(data);
    }
    return result;
  }

  /* All timers and intervals to heck and log signals */

  setAllIntervalTradeChecks() {
    const now = Date.now();
    const msToNextMinute = 60000 - (now % 60000);
  
    setTimeout(() => {
      // === Every Minute: Run strategy + track trades
      setInterval(() => {
        try {
          this.allTokensList.forEach(symbol => this.strategyEngine(symbol));
  
          if (config.current.env === 'test' || config.current.withDetailedLog) {
            this.pendingTrades.forEach(trade => {
              if (trade.closed) return;
            
              const current = this.getDataWindow(trade.symbol, 1)[0];
              if (!current) return;
            
              trade.history.push(current);
            
              // Simulate TP hit (but don't close yet)
              const hit = trade.direction === 'LONG'
                ? current.high >= trade.takeProfit * 1.0002
                : current.low <= trade.takeProfit * 0.9998;
            
              // Store TP hit moment once
              if (hit && trade.hitAtMinute == null) {
                trade.hitAtMinute = trade.history.length;
                trade.TP_hit = true;
              }
            
              // After 30 minutes of data → finalize
              if (trade.history.length >= 30) {
                trade.closed = true;
            
                const maxGain = trade.direction === 'LONG'
                  ? Math.max(...trade.history.map(d => d.high ?? d.price))
                  : Math.min(...trade.history.map(d => d.low ?? d.price));
            
                const maxGainPct = getPercentChange(trade.entryPrice, maxGain);
            
                const couldHit1pct = trade.direction === 'LONG'
                  ? maxGainPct >= 1
                  : maxGainPct <= -1;
            
                const { history, ...tradeWithoutHistory } = trade;

                const finalizedTrade = {
                  ...tradeWithoutHistory,
                  TP_hit: trade.TP_hit || false,
                  hitAtMinute: trade.hitAtMinute || null,
                  finalPrice: current.price,
                  percentChange: getPercentChange(trade.entryPrice, current.price).toFixed(2) + '%',
                  maxGain: maxGain.toFixed(2),
                  maxGainPct: maxGainPct.toFixed(2),
                  couldHit1pct,
                  closed: true
                };
                
                this.tradeResults.push(finalizedTrade);

                // Save history separately
                this.tradeHistory.push({
                  timestamp: trade.timestamp,
                  symbol: trade.symbol,
                  direction: trade.direction,
                  reason: trade.reason,
                  history
                });
              }
            });
          }
        } catch (err) {
          logger.error(`[${symbol}] - Error in an Interval to run the Strategy: ${err.message}`);
          console.error('Error in strategyEngine interval:', err.message);
        }
      }, 60000);
  
      // === Every Minute: Check 1m liquidation clusters
      setInterval(async () => {
        try {
          for (const symbol of this.allTokensList) {
            const totalLiquidation = this.liquidationVolumeBySymbol[symbol] || 0;
            const tokenRanking = this.getTokenRanking(symbol);
            const threshold = this.getLiquidationThreshold(tokenRanking);
    
            if (totalLiquidation >= threshold) {
              await this.checkIfEnoughBalanceForBid(this.binanceWs);
  
              if (this.isStopped || this.isPaused) {
                logger.warn('⏸ Bot paused, skipping liquidation signal check');
              } else {
                logger.info(`[${symbol}] 🔥 ${Math.round(totalLiquidation)} USDT in liquidations (1m)`);
    
                const m1 = this.getDataWindow(symbol, 1);
                const latest = m1?.[m1.length - 1];
                if (m1 && latest) {
                  const priceChange = getPercentChange(m1[0]?.price, latest.price);
                  const oiChange = getPercentChange(m1[0]?.openInterest, latest.openInterest);
    
                  const direction = priceChange > 0 && oiChange > 0
                    ? 'LONG'
                    : priceChange < 0 && oiChange < 0
                      ? 'SHORT'
                      : null;
    
                  if (direction && this.filterLiquidationTrade(symbol, direction)/* && this.passesRsiFilter(symbol, direction)*/) {
                    this.processSignalAccordingToEnv(
                      symbol,
                      direction,
                      `🔥 (1m) Liquidation Cluster (${Math.round(totalLiquidation)} USDT) + Price/OI up (1m)`
                    );
                  }
                }
              }
            }
    
            // Reset for next minute
            this.liquidationVolumeBySymbol[symbol] = 0;
          }
        } catch (err) {
          logger.error(`[${symbol}] - Error in an Interval to run the Liquidation check: ${err.message}`);
          console.error('Error in Liquidation check interval:', err.message);
        }
      }, 60000);
  
      if (config.current.env === 'test' || config.current.withDetailedLog) {
        // === Every 5 Minutes: Export logs
        setInterval(this.saveResultsToFiles(), 5 * 60 * 1000);
      }
    }, msToNextMinute);
  }

  /* Process signals */

  handleLiquidation(liquidation) {
    const { s: symbol, S: side, q: quantity, ap: price } = liquidation;

    if (shouldSkipSymbol(symbol)) {
      return;
    }

    const liquidationAmount = parseFloat(quantity) * parseFloat(price);
    // Track total liquidation amount per symbol per minute
    if (!this.liquidationVolumeBySymbol[symbol]) {
      this.liquidationVolumeBySymbol[symbol] = 0;
    }
    this.liquidationVolumeBySymbol[symbol] += liquidationAmount;
  }

  async strategyEngine(symbol) {
    try {
      if (shouldSkipSymbol(symbol)) {
        return;
      }
  
      await this.checkIfEnoughBalanceForBid(this.binanceWs);
      if (this.isStopped || this.isPaused) {
        logger.warn('Skip execution since the Bot is paused!');
        return;
      }
  
      const m30 = this.getDataWindow(symbol, 30);
      if (m30.length < 2) return; // not enough even for 1m trades
    
      const current = m30[m30.length - 1];
      if (!current) return;
    
      const last = (offset) => m30[m30.length - 1 - offset];
  
      const priceChange1m = m30.length >= 2 ? getPercentChange(last(1)?.price, current.price) : null;
      const oiChange1m = m30.length >= 2 ? getPercentChange(last(1)?.openInterest, current.openInterest) : null;
      const volumeChange1m = m30.length >= 2 ? getPercentChange(last(1)?.volume, current.volume) : null;
    
      const priceChange5m = m30.length >= 6 ? getPercentChange(last(5)?.price, current.price) : null;
      const priceChange15m = m30.length >= 16 ? getPercentChange(last(15)?.price, current.price) : null;
      const priceChange20m = m30.length >= 21 ? getPercentChange(last(20)?.price, current.price) : null;
    
      const oiChange12m = m30.length >= 13 ? getPercentChange(last(12)?.openInterest, current.openInterest) : null;
      const oiChange30m = m30.length >= 30 ? getPercentChange(last(29)?.openInterest, current.openInterest) : null;
    
      const funding = current.funding;
    
      // Open Interest Triggers
      if (oiChange1m <= -1 && priceChange1m < 0.1) {
        if (this.filterTrade(symbol, 'SHORT') && this.passesRsiFilter(symbol, 'SHORT', { rsiLow: 30 })) this.processSignalAccordingToEnv(symbol, 'SHORT', 'OI -1% (1m) + Price/CVD down (1m)');
      }
  
      // Include Volume exploasion
      if (oiChange12m >= 2 && priceChange1m > 0.1) {
        if (volumeChange1m >= 50) {
          if (this.filterTrade(symbol, 'LONG') && this.passesRsiFilter(symbol, 'LONG', { rsiHigh: 70 })) {
            this.processSignalAccordingToEnv(symbol, 'LONG', 'OI +2% (12m) + Price up + Volume spike (1m)');
          }
        } else {
          if (this.filterTrade(symbol, 'LONG') && this.passesRsiFilter(symbol, 'LONG', { rsiHigh: 70 })) {
            this.processSignalAccordingToEnv(symbol, 'LONG', 'OI +2% (12m) + Price up (1m)');
          }
        }
      }
    
      if (oiChange30m >= 15 && priceChange1m < 0.1) {
        if (this.filterTrade(symbol, 'SHORT') && this.passesRsiFilter(symbol, 'SHORT')) this.processSignalAccordingToEnv(symbol, 'SHORT', 'OI +15% (30m) + Price/CVD down (1m)');
      }
    
      // Price Triggers
      if (priceChange5m >= 3 && oiChange1m > 0.2) {
        if (this.filterTrade(symbol, 'LONG') && this.passesRsiFilter(symbol, 'LONG')) this.processSignalAccordingToEnv(symbol, 'LONG', 'Price +3% (5m) + OI/CVD up (1m)');
      }
    
      if (priceChange15m <= -10 && oiChange1m > 0.2) {
        if (this.filterTrade(symbol, 'LONG') && this.passesRsiFilter(symbol, 'LONG')) this.processSignalAccordingToEnv(symbol, 'LONG', 'Price -10% (15m) + OI/CVD up (1m)');
      }
    
      if (priceChange20m >= 10 && oiChange1m < 0.2) {
        if (this.filterTrade(symbol, 'SHORT') && this.passesRsiFilter(symbol, 'SHORT')) this.processSignalAccordingToEnv(symbol, 'SHORT', 'Price +10% (20m) + OI/CVD down (1m)');
      }
    
      // Funding Trigger
      if (funding <= -0.1 && priceChange1m > 0.1 && oiChange1m > 0.2) {
        if (this.filterTrade(symbol, 'LONG') && this.passesRsiFilter(symbol, 'LONG')) this.processSignalAccordingToEnv(symbol, 'LONG', 'Funding -0.1% or less + OI/Price up (1m)');
      }
    } catch (err) {
      logger.error(`[${symbol}] strategyEngine error: ${err.message}`);
      console.error('Error in strategyEngine:', err.message);
    }
  }

  // FILTERS

  async checkIfEnoughBalanceForBid() {
    const amountForBid = calculateBidAmount(this.binanceWs);
    const availableBalance = this.binanceWs.accountInfo.availableBalance;

    if (availableBalance < amountForBid && !this.isPaused) {
      this.pause();
      logger.warn('Pause the Bot because there is not enough money for a bid!');
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
  
  passesRsiFilter(symbol, direction, options = {}) {
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

  buildVolumeProfile(symbol, windowSize = 30) {
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

  // Log / Execute trades

  processSignalAccordingToEnv(symbol, direction, reason) {
    try {
      if (config.current.env === 'prod') this.executeTrade(symbol, direction, reason);
      if (config.current.env === 'test' || config.current.withDetailedLog) this.logSignal(symbol, direction, reason);
    } catch (err) {
      logger.error(`[${symbol}] - Error to run the processSignalAccordingToEnv: ${err.message}`);
      console.error('Error in processSignalAccordingToEnv:', err.message);
    }
  }

  logSignal(symbol, direction, reason) {
    const sameSymbolOpenTrades = this.pendingTrades.filter(
      t => t.symbol === symbol && !t.closed
    );
    if (sameSymbolOpenTrades.length >= config.current.sameSymbolOrdersLimit) {
      logger.warn(`The same symbol ${symbol} and the same ${direction} direction trades are going to be more than limit ${config.current.sameSymbolOrdersLimit}. Skipping the trade...`);
      return;
    }

    const simTradeData = this.generateSimulatedTradeData(symbol, direction, reason);
    const { simEntryPrice, takeProfit, slippagePct, timestamp } = simTradeData;
  
    const url = `https://www.coinglass.com/tv/Binance_${symbol.toUpperCase()}`;
  
    const trade = {
      timestamp,
      symbol,
      direction,
      reason,
      entryPrice: simEntryPrice,
      dynamicSlippagePcnt: slippagePct,
      takeProfit,
      history: [],
      closed: false
    };
  
    this.signalLog.push({ ...trade, coinglass: url });
    this.pendingTrades.push(trade);
  
    // Add to diagnostics with null real entry
    this.executionDiagnostics.push({ ...simTradeData, realEntryPrice: null, diffAbs: null, diffPct: null });
  
    console.log(`[${symbol}] ${direction} – ${reason}`);
    console.log(`🔗 ${url}\n`);
  }

  generateSimulatedTradeData(symbol, direction, reason) {
    const timestamp = getCurrentTimestamp();
    const latest = this.getDataWindow(symbol, 1)[0];
    const entryPrice = latest?.price;
  
    const slippagePct = this.dynamicSlippagePcnt(symbol, entryPrice);
    const simEntryPrice = direction === 'LONG'
      ? entryPrice * (1 + slippagePct)
      : entryPrice * (1 - slippagePct);
  
    const takeProfit = this.calculateTakeProfit(symbol, direction, simEntryPrice, reason);
  
    return {
      timestamp,
      symbol,
      direction,
      reason,
      simEntryPrice,
      slippagePct,
      takeProfit
    };
  }

  dynamicSlippagePcnt(symbol, entryPrice) {
    const recentWindow = this.getDataWindow(symbol, 5);
    if (recentWindow.length !== 5 || !entryPrice) return DEFAULT_SLIPPAGE_FOR_TESTING;

    const tickSize = this.binanceExchangeInfo[symbol].tickSize || 0.0001; // fallback
    const minSlippageTicks = tickSize * 3;
    const tickBasedSlippage = minSlippageTicks / entryPrice;

    // ATR-style average range (not %)
    const ranges = recentWindow.map(c => c.high - c.low);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const atrBasedSlippage = avgRange * 0.3;

    // Use the larger of volatility or tick-based slip
    let slippage = Math.max(tickBasedSlippage, atrBasedSlippage);
    slippage += DEFAULT_SPREAD_FOR_TESTING;

    // Cap by price level to avoid wild behavior
    const maxSlippage = entryPrice < 0.01 ? 0.0015 : 0.0025;
    const finalSlippage = Math.min(slippage, maxSlippage);

    if (finalSlippage > 0.005) {
      logger.warn(`[${symbol}] ⚠️ Simulated slippage too high: ${(finalSlippage * 100).toFixed(2)}%`);
    }

    return finalSlippage;
  }

  async executeTrade(symbol, positionSide, reason) {
    try {
      // Send Market order
      const amountForBid = calculateBidAmount(this.binanceWs);
      const tradeSide = translatePositionSideToTradeSide(positionSide);

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
      await this.sendLimitOrderToClosePosition(symbol, tradeSide, positionSide, executedQuantity, avgEnterPrice, reason);

      if (config.current.env === 'test' || config.current.withDetailedLog) {
        const simTradeData = this.generateSimulatedTradeData(symbol, positionSide, reason);
        this.executionDiagnostics.push({
          ...simTradeData,
          realEntryPrice: avgEnterPrice,
          diffAbs: Math.abs(avgEnterPrice - simTradeData.simEntryPrice),
          diffPct: getPercentChange(simTradeData.simEntryPrice, avgEnterPrice)
        });
      }

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
  
  formatTokenQuantity(symbol, number) {
    const precision = this.binanceExchangeInfo[symbol].quantityPrecision;
    const factor = Math.pow(10, precision);
    return Math.floor(number * factor) / factor; // Always round down
  }

  calculateTakeProfit(symbol, direction, entryPrice, reason = null) {
    const tickSize = this.binanceExchangeInfo[symbol].tickSize;
    const precision = tickSize.toFixed(10).replace(/0+$/, "").split(".")[1]?.length || 0;
  
    // Decide percentage based on reason or config
    let percentage;
    if (reason?.includes('Liquidation')) percentage = 0.0015;
    else if (reason?.includes('Volume spike')) percentage = 0.003;
    else percentage = config.current.profitPercentage / 100;
  
    // Raw TP calculation
    let rawTP = direction === 'LONG'
      ? entryPrice * (1 + percentage)
      : entryPrice * (1 - percentage);
  
    // Respect minimum tick-based TP
    let minTP = direction === 'LONG'
      ? entryPrice + tickSize
      : entryPrice - tickSize;
  
    let takeProfit = direction === 'LONG'
      ? Math.max(rawTP, minTP)
      : Math.min(rawTP, minTP);
  
    return parseFloat(takeProfit.toFixed(precision));
  }

  async sendLimitOrderToClosePosition(symbol, marketOrderSide, positionSide, quantity, avgEnterPrice, reason) {
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

      const formattedTakeProfitPrice = this.calculateTakeProfit(symbol, positionSide, breakevenPrice || avgEnterPrice, reason);
  
      const limitOrder = {
        symbol: symbol,
        side: limitOrderSide,
        positionSide: positionSide,
        type: 'LIMIT',
        quantity: accumulatedQuantity || quantity,
        price: formattedTakeProfitPrice,
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

  getTokenRanking(symbol) {
    const token = symbol.replace('USDT', '');
    if (this.marketCapTokenData.top20.includes(token)) {
      return 'top20';
    } else if (this.marketCapTokenData.top50.includes(token)) {
      return 'top50';
    } else {
      return 'small';
    }
  }

  getLiquidationThreshold(tokenRanking) {
    switch (tokenRanking) {
      case 'top20':
        return config.current.top20Liquidation;
      case 'top50':
        return config.current.top50Liquidation;
      default:
        return config.current.smallLiquidation;
    }
  }

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

  async updateMarketCapTokenData() {
    this.marketCapTokenData = await getMarketCapTokenData();
  }

  updateDepositSizeConfig() {
    logger.info('Updating Deposit Size config...');
    const walletBalance = this.binanceWs.accountInfo.walletBalance;
    config.setConfig({ "depositSize": walletBalance });
  }

  saveResultsToFiles(withTradeHistory = false) {
    try {
      fs.writeFileSync('testing/signal-log.json', JSON.stringify(this.signalLog, null, 2));
      fs.writeFileSync('testing/trade-results.json', JSON.stringify(this.tradeResults, null, 2));
      fs.writeFileSync('testing/execution-diagnostics.json', JSON.stringify(this.executionDiagnostics, null, 2));
      if (withTradeHistory) fs.writeFileSync('testing/trade-history.json', JSON.stringify(this.tradeHistory, null, 2));
      console.log('💾 Exported signal log and trade results');
    } catch (err) {
      console.error('Error exporting data:', err.message);
    }
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
}

export default TradingLogic;