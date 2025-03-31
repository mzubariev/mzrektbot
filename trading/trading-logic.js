// trading-logic.js
import BinanceWssRestApi from '../binance/binance-wss-rest-api.js';
import logger from '../utils/logger.js';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import { enableIsolatedMarginForAll } from '../utils/setIsolatedMarginModeBinance.js';
import config from '../utils/configuration.js';
import { calculateBidAmount, getOppositeTradeSide, translatePositionSide, getTokenTrend, getBotTradeSide } from '../utils/helpers.js';

const STUCK_ORDER_STATUSES_TO_ALERT = ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'];

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey }) {
    this.telegramBot = null;
    this.binanceWs = new BinanceWssRestApi(binanceApiKey, binanceSecretKey);
    this.binanceExchangeInfo = null;
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
      this.binanceExchangeInfo = await getBinanceExchangeInfo();

      this.telegramBot = telegramBot;

      await this.binanceWs.connect();

      logger.info('Start liquidations listeners for all exchanges!');
      this.startExchangeDataListeners();
    } catch (error) {
      logger.error(`Error initializing Trading Logic:`);
      console.error(error);
      throw error;
    }
  }

  /* Trading */

  startExchangeDataListeners() {
    // Binance
    this.binanceWs.events.on('message', async (liquidation) => {

      // this means stopped manualy and may be unstopped only manually via tg command (important - to average/close trades manually on Binance UI)
      if (this.isStopped) {
        return;
      }

      await this.checkIfEnoughBalanceForBid(this.binanceWs);

      // paused by Bot; will be unpaused once it is enough available money for a bid
      if (this.isPaused) {
        return;
      }

      // if (symbol.includes('BTCUSDT') || symbol.includes('ETHUSDT')) {
      //   logger.warn(`Skipping BTCUSDT and ETHUSDT for now...`);
      //   return;
      // }

      await this.processTradeDecision(liquidation, this.binanceWs);
    });
  }

  async checkIfEnoughBalanceForBid(exchange) {
    const amountForBid = calculateBidAmount(exchange);
    const availableBalance = exchange.accountInfo.availableBalance;

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
  
  isAlreadyMaximumPositionsForToken(exchange, symbol, positionSide) {
    if (exchange.positionsInfo[symbol] && exchange.positionsInfo[symbol][positionSide] && exchange.positionsInfo[symbol][positionSide].ordersAmount >= config.current.sameSymbolOrdersLimit) {
      logger.warn(`Skipping the trade since there are already ${exchange.positionsInfo[symbol][positionSide].ordersAmount} orders opened for this token! Wait till they are closed...`);
      return;
    }
  }

  async processTradeDecision() {
    
  }

  async executeTrade(exchange, symbol, tradeSide) {
    try {
      // Send Market order
      const amountForBid = calculateBidAmount(exchange);
      const positionSide = translatePositionSide(tradeSide);

      if (this.isOnlyLongsOrShortsAllowed(positionSide) || this.isAlreadyMaximumPositionsForToken(exchange, symbol, positionSide)) {
        return;
      }

      const marketOrderResult = await this.executeMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid);
      if (!marketOrderResult) {
        return; 
      }

      // Send Limit order to close the Position with 0,2% profit 
      const avgEnterPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);

      await this.sendLimitOrderToClosePosition(exchange, symbol, tradeSide, positionSide, executedQuantity, avgEnterPrice);

    } catch (error) {
      throw new Error(`Trade execution failed for ${symbol} on ${exchange.name}: ${error.message}`);
    }
  }

  async executeMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid) {
    logger.info(`Executing trade - Exchange: ${exchange.name}, Token: ${symbol}, TradeSide: ${tradeSide} to ${positionSide}, Amount: ${amountForBid}`);
    
    try {
      const result = await this.executeBinanceMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid);
   
      logger.info('Market order executed successfully on %s: %j', exchange.name, result);
      return result;
    } catch (error) {
      logger.error(`Error executing market order on %s: ${exchange.name}.`);
      console.error(error);
      throw error;
    }
  }

  // Binance
  async executeBinanceMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid) {
    try {      
      const lastPrice = await exchange.getSymbolLastPrice(symbol);
    
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

  async sendLimitOrderToClosePosition(exchange, symbol, marketOrderSide, positionSide, quantity, avgEnterPrice) {
    try {
      const limitOrderSide = getOppositeTradeSide(marketOrderSide);

      let accumulatedQuantity = null;
      let breakevenPrice = null;
      if (exchange.positionsInfo[symbol] && exchange.positionsInfo[symbol][positionSide]) {
        accumulatedQuantity = exchange.positionsInfo[symbol][positionSide].positionAmount;
        breakevenPrice = exchange.positionsInfo[symbol][positionSide].breakevenPrice;

        const orderId = exchange.positionsInfo[symbol][positionSide].lastClosingLimitOrderId;
        await exchange.cancelOrder(orderId, symbol);
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
      const limitOrderResult = await exchange.sendOrder(limitOrder);
      logger.info('Limit order result:\n%j', limitOrderResult);
  
      exchange.positionsInfo[symbol][positionSide].lastClosingLimitOrderId = limitOrderResult.orderId;

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

  updateBinanceExchangeInfo(binanceExchangeInfo) {
    this.binanceExchangeInfo = binanceExchangeInfo;
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