// trading-logic.js
import BinanceWssRestApi from '../binance/binance-wss-rest-api.js';
import logger from '../utils/logger.js';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import config from '../utils/configuration.js';
import { calculateBidAmount, getOppositeTradeSide, translatePositionSide, getTokenTrend, getBotTradeSide } from '../utils/helpers.js';
import { enableIsolatedMarginForAll } from '../utils/setIsolatedMarginModeBinance.js';

const STUCK_ORDER_STATUSES_TO_ALERT = ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'];

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey }) {
    this.telegramBot = null;
    this.binanceWs = new BinanceWssRestApi(binanceApiKey, binanceSecretKey);
    this.binanceExchangeInfo = null;
    this.allTokensList = null;
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
      const { binanceExchangeInfo, allTokensList } = await getBinanceExchangeInfo();
      this.binanceExchangeInfo = binanceExchangeInfo;
      this.allTokensList = allTokensList;

      this.telegramBot = telegramBot;

      await this.binanceWs.connect();

      logger.info('Start liquidations listeners for all exchanges!');
      this.startBinanceDataListeners();
    } catch (error) {
      logger.error(`Error initializing Trading Logic:`);
      console.error(error);
      throw error;
    }
  }

  /* Trading */

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

  startBinanceDataListeners() {
    // Binance
    this.binanceWs.events.on('message', async (liquidation) => {

      await this.checkIfEnoughBalanceForBid(this.binanceWs);
      if (this.isStopped || this.isPaused) {
        return;
      }

      

      await this.processTradeDecision(liquidation, this.binanceWs);
    });
  }

  async processTradeDecision() {
    // if (symbol.includes('BTCUSDT') || symbol.includes('ETHUSDT')) {
      //   logger.warn(`Skipping BTCUSDT and ETHUSDT for now...`);
      //   return;
      // }

  }

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
    logger.info('=== INTERMEDIATE STATISTICS ===');
    console.log('INSERT new data');
  }

  updateBinanceExchangeInfo({ binanceExchangeInfo, allTokensList }) {
    this.binanceExchangeInfo = binanceExchangeInfo;
    this.allTokensList = allTokensList;
  }

  async updateDepositSizeConfig() {
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
}

export default TradingLogic;