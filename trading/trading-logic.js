// trading-logic.js
import BinanceWebSocket from '../wss/binance-websocket.js';
import BybitWebSocket from '../wss/bybit-websocket.js';
import OKXWebSocket from '../wss/okx-websocket.js';
import MEXCWebSocket from '../wss/mexc-websocket.js';
import logger from '../utils/logger.js';
import getMarketCapTokenData from '../utils/coinmarketcap-token-data.js';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import config from '../utils/configuration.js';

const ORDERS_STATUSES_TO_ALERT = ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'];

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey, bybitApiKey, bybitSecretKey, okxApiKey, okxSecretKey, okxPassphrase, mexcApiKey, mexcSecretKey }) {
    this.config = config.getConfig();
    this.telegramBot = null;
    this.binanceWs = new BinanceWebSocket(binanceApiKey, binanceSecretKey);
    // this.bybitWs = new BybitWebSocket(bybitApiKey, bybitSecretKey);
    // this.okxWs = new OKXWebSocket(okxApiKey, okxSecretKey, okxPassphrase);
    // this.mexcWs = new MEXCWebSocket(mexcApiKey, mexcSecretKey);
    this.marketCapTokenData = null;
    this.binanceExchangeInfo = null;
    this.liquidationAccumulation = {};
    this.openOrders = new Map();
    this.isPaused = false;

    logger.info('BOT Initialized with config: %j', this.config);

    config.on('configUpdated', (newConfig) => {
      this.handleConfigChange(newConfig);
    });
  }

  async initialize(telegramBot) {
    try {
      this.marketCapTokenData = await getMarketCapTokenData();
      this.binanceExchangeInfo = await getBinanceExchangeInfo();

      this.telegramBot = telegramBot;

      this.binanceWs.connect();
      // this.bybitWs.connect();
      // this.okxWs.connect();
      // this.mexcWs.connect();

      logger.info('Start liquidations listeners for all exchanges!');
      this.setupLiquidationListeners();
    } catch (error) {
      logger.error('Error initializing Trading Logic: %j', error);
      throw error;
    }
  }

  /* Trading */

  calculateBidAmount() {
    return this.config.depositSize * this.config.bidPercentage / 100;
  }

  getOppositeTradeSide(tradeSide) {
    return tradeSide === 'BUY' ? 'SELL' : 'BUY';
  }

  translatePositionSide(tradeSide) {
    return tradeSide === 'BUY' ? 'LONG' : 'SHORT';
  }

  getTokenTrend(liquidationSide) {
    return liquidationSide === 'BUY' ? 'Local DOWN-trend' : 'Local UP-trend';
  }

  getBotTradeSide(liquidationSide) {
    if (this.config.tradeDirection === 'trend') {
      return this.getOppositeTradeSide(liquidationSide);
    } else if (this.config.tradeDirection === 'rebound') {
      return liquidationSide;
    }
  }

  setupLiquidationListeners() {
    // Binance
    this.binanceWs.events.on('message', async (liquidation) => {
      await this.processLiquidation(liquidation, this.binanceWs);
    });

    // Bybit
    // this.bybitWs.events.on('message', async (liquidation) => {
    //   await this.processLiquidation(liquidation, 'Bybit');
    // });

    // OKX
    // this.okxWs.events.on('message', async (liquidation) => {
    //   await this.processLiquidation(liquidation, 'OKX');
    // });

    // MEXC
    // this.mexcWs.events.on('message', async (liquidation) => {
    //   await this.processLiquidation(liquidation, 'MEXC');
    // });
  }

  async processLiquidation(liquidation, exchange) {
    console.log('\n---Processing liquidation---');

    if (this.isPaused) {
      logger.warn('Liquidation processing skipped: Trading is paused!');
      return;
    }

    const { s: symbol, S: liquidationSide, q: quantity, ap: price } = liquidation;
    const tokenRanking = this.getTokenRanking(symbol);
    const liquidationThreshold = this.getLiquidationThreshold(tokenRanking);
    const liquidationAmount = parseFloat(quantity) * parseFloat(price);

    if (['top20', 'top50'].includes(tokenRanking)) {
      logger.warn(`Skipping ${tokenRanking} token for now...`);
      return;
    }

    logger.info(`${exchange.name}, ${symbol}, ${this.translatePositionSide(liquidationSide)} -${liquidationAmount}$ -> ${this.getTokenTrend(liquidationSide)} <- Price: ${price}$, Quantity: ${quantity} | Token rank: ${tokenRanking}, Liquidation threshold: ${liquidationThreshold}$`);

    if (liquidationAmount >= liquidationThreshold) {
      try {
        const tradeSide = this.getBotTradeSide(liquidationSide);
        await this.executeTrade(exchange, symbol, tradeSide);
      } catch (error) {
        logger.error(`Error executing trade for ${symbol} on ${exchange.name}: ${error.message}`);
        logger.debug('Error details: %j', error);
        logger.warn(`Skipping trade execution for ${symbol} on ${exchange.name} due to an error.`);
        return;
      }
    } else {
      this.accumulateLiquidation(exchange, symbol, liquidationSide, liquidationAmount);
    }
  }

  async executeTrade(exchange, symbol, tradeSide) {
    if (this.isPaused) {
      logger.warn(`Trade execution skipped: Trading is paused (${symbol} on ${exchange.name})`);
      return;
    }
    
    try {
      // Send Market order
      const amountForBid = this.calculateBidAmount();
      const positionSide = this.translatePositionSide(tradeSide);

      logger.info(`Executing trade - Exchange: ${exchange.name}, Token: ${symbol}, TradeSide: ${tradeSide} to ${positionSide}, Amount: ${amountForBid}`);
      const marketOrderResult = await this.executeMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid);
      logger.info('Market order result:\n%j', marketOrderResult);

      // Send Limit order to close the Position with 0,1% of 
      const avgPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);
      const { limitOrderSide, formattedLimitPrice } = this.calculateClosePositionLimitOrderValues(symbol, tradeSide, avgPrice);
      
      logger.info(`Send limit order to close the position - Exchange: ${exchange.name}, Token: ${symbol}, Close: ${positionSide} by a ${limitOrderSide} order, Amount: ${executedQuantity}, Price: ${formattedLimitPrice}`);
      const limitOrderResult = await this.sendLimitOrderToClosePosition(exchange, symbol, limitOrderSide, positionSide, executedQuantity, formattedLimitPrice);
      logger.info('Limit order result:\n%j', limitOrderResult);

      // Set a 5-minute timer for the limit order to report in Telegram if the order is still Opened
      this.setLimitOrderTimer(exchange, symbol, limitOrderResult.orderId);
    } catch (error) {
      logger.error(`Error executing trade on ${exchange.name}: ${error.message}`);
      logger.debug('Error details:\n%j', error);
      throw new Error(`Trade execution failed for ${symbol} on ${exchange.name}: ${error.message}`);
    }
  }

  async executeMarketOrder(exchange, symbol, side, positionSide, quoteOrderQty) {
    logger.info(`Executing market order on ${exchange.name}: ${symbol}, ${side}, ${quoteOrderQty} USDT`);
    
    try {
      let result;
      switch (exchange.name) {
        case 'Binance':
          result = await this.executeBinanceMarketOrder(symbol, side, positionSide, quoteOrderQty);
          break;
        case 'Bybit':
          result = await this.executeBybitMarketOrder(symbol, side, quoteOrderQty);
          break;
        case 'OKX':
          result = await this.executeOKXMarketOrder(symbol, side, quoteOrderQty);
          break;
        case 'MEXC':
          result = await this.executeMEXCMarketOrder(symbol, side, quoteOrderQty);
          break;
        default:
          throw new Error(`Unsupported exchange: ${exchange.name}`);
      }

      logger.info('Market order executed successfully on %s: %j', exchange.name, result);
      return result;
    } catch (error) {
      logger.error('Error executing market order on %s: %j', exchange.name, error);
      throw error;
    }
  }

  // Binance
  async executeBinanceMarketOrder(symbol, side, positionSide, quoteOrderQty) {
    try {      
      const lastPrice = this.binanceWs.tickerPrices[symbol];
    
      if (!lastPrice) {
        throw new Error(`Price for ${symbol} is not available. Ensure the ticker subscription is active.`);
      }
  
      logger.info(`Current price for ${symbol}: ${lastPrice}`);

      const quantity = (quoteOrderQty / lastPrice);
      const formatted_quantity = this.formatSpecificFloatsForToken(symbol, quantity, 'quantityPrecision');

      if (formatted_quantity <= 0) {
        logger.warn(`Skipping the trade - too small Bid for this token...`);
        return;
      }

      const order = {
        symbol: symbol,
        side: side,
        positionSide: positionSide,
        type: 'MARKET',
        quantity: formatted_quantity,
        newOrderRespType: 'RESULT'
      };

      logger.info('Placing the Order:\n%j', order);
      return await this.binanceWs.sendOrder(order);
    } catch (error) {
      logger.error('Error executing market order:\n%j', error);
      throw error;
    }
  }

  // Bybit
  async executeBybitMarketOrder(symbol, side, quoteOrderQty) {
    const order = {
      symbol: symbol,
      side: side,
      orderType: 'Market',
      orderQty: quoteOrderQty,
      orderFilter: 'Order'
    };
    return await this.bybitWs.sendOrder(order);
  }

  // OKX
  async executeOKXMarketOrder(symbol, side, quoteOrderQty) {
    const order = {
      instId: symbol,
      tdMode: 'cash',
      side: side,
      ordType: 'market',
      tgtCcy: 'quote_ccy',
      sz: quoteOrderQty
    };
    return await this.okxWs.sendOrder(order);
  }

  // MEXC
  async executeMEXCMarketOrder(symbol, side, quoteOrderQty) {
    const order = {
      symbol: symbol,
      side: side,
      type: 'MARKET',
      quoteOrderQty: quoteOrderQty
    };
    return await this.mexcWs.sendOrder(order);
  }

  calculateClosePositionLimitOrderValues(symbol, tradeSide, avgPrice) {
    const limitPrice = tradeSide === 'BUY'
      ? avgPrice * (1 + this.config.profitPercentage / 100)
      : avgPrice * (1 - this.config.profitPercentage / 100);
    const tickSizeFloat = this.getTokenPrecisions(symbol, 'tickSize');
    const formattedLimitPrice = Math.ceil(limitPrice / tickSizeFloat) * tickSizeFloat;
    const limitOrderSide = this.getOppositeTradeSide(tradeSide);

    return { limitOrderSide, formattedLimitPrice };
  }

  async sendLimitOrderToClosePosition(exchange, symbol, orderSide, positionSide, quantity, price) {
    const limitOrder = {
      symbol: symbol,
      side: orderSide,
      positionSide: positionSide,
      type: 'LIMIT',
      quantity: quantity,
      price: price,
      timeInForce: 'GTC',
      newOrderRespType: 'RESULT'
    };

    logger.info('Placing limit order:\n%j', limitOrder);
    return await exchange.sendOrder(limitOrder);
  }

  accumulateLiquidation(exchange, symbol, liquidationSide, amount) {
    const now = Date.now();
    if (!this.liquidationAccumulation[symbol]) {
      this.liquidationAccumulation[symbol] = {
        amount: 0,
        side: '',
        startTime: now,
      };
    } else if (this.liquidationAccumulation[symbol].side === liquidationSide) {
      this.liquidationAccumulation[symbol].amount += amount;
    }

    const tradeSide = this.getBotTradeSide(liquidationSide);

    // 5 seconds to accumulate the liquidations per a token
    if (now - this.liquidationAccumulation[symbol].startTime >= 5000) {
      // Check if accumulated amount meets the threshold
      const tokenRanking = this.getTokenRanking(symbol);
      const liquidationThreshold = this.getLiquidationThreshold(tokenRanking);
      
      if (this.liquidationAccumulation[symbol].amount >= liquidationThreshold) {
        logger.warn(`Executing a trade for ${symbol} after liquidations accumulation!`);
        this.executeTrade(exchange, symbol, tradeSide);
      }

      // Reset accumulation
      this.liquidationAccumulation[symbol] = {
        amount: 0,
        startTime: now,
      };
    }
  }

  setLimitOrderTimer(exchange, symbol, orderId) {
    const timer = setTimeout(() => {
      this.alertHangingLimitOrder(exchange, symbol, orderId);
    }, 5 * 60 * 1000); // 5 minutes

    const exchangeName = exchange.name;
    this.openOrders.set(orderId, { exchangeName, symbol, timer });
  }

  async alertHangingLimitOrder(exchange, symbol, orderId) {
    try {
      const order = await exchange.getOrder(orderId, symbol);
      if (ORDERS_STATUSES_TO_ALERT.includes(order.status)) {
        // Notify via Telegram
        this.telegramBot.sendMsgToTgChat(`Limit order for <strong><a href="https://www.binance.com/en/futures/${symbol}">${symbol} on ${exchange.name}</a></strong> have some issues after 5 minutes. Order status: ${order.status}`);
      }
    } catch (error) {
      logger.error(`Error checking limit order status: ${error}`);
    } finally {
      this.openOrders.delete(orderId);
    }
  }

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
        return this.config.top20Liquidation;
      case 'top50':
        return this.config.top50Liquidation;
      default:
        return this.config.smallLiquidation;
    }
  }

  getTokenPrecisions(symbol, tokenPrecisionSetting) {
    // See tokenPrecisionSetting options in ./binance-exchange-info.json
    const tokenInfo = this.binanceExchangeInfo[symbol]

    if (!tokenInfo) {
      throw new Error(`Token ${symbol} not found in exchangeInfo`);
    }
  
    return parseFloat(tokenInfo[tokenPrecisionSetting]);
  }

  formatSpecificFloatsForToken(symbol, number, tokenPrecisionSetting) {
    const numberString = number.toString();
    const decimalIndex = numberString.indexOf('.');

    if (decimalIndex === -1) {
      return number;
    }
  
    const precision = this.getTokenPrecisions(symbol, tokenPrecisionSetting);

    if (precision === 0) {
      return Math.ceil(number);
    }

    const truncated = numberString.slice(0, decimalIndex + precision + 1);
    return parseFloat(truncated);
  }

  // Configurations routine

  handleConfigChange(newConfig) {
    logger.info('Applying new config...');
    if (newConfig.status) {
      newConfig.status === 'paused' ? this.pause() : this.resume();
    } else {
      this.config = newConfig;
    }
    logger.info('Configuration updated dynamically: %j', newConfig);
  }

  updateMarketCapTokenData(tokenData) {
    this.marketCapTokenData = tokenData;
  }

  updateBinanceExchangeInfo(binanceExchangeInfo) {
    this.binanceExchangeInfo = binanceExchangeInfo;
  }

  pause() {
    this.isPaused = true;
    logger.info('Trading logic paused!');
  }

  resume() {
    this.isPaused = false;
    logger.info('Trading logic resumed!');
  }
}

export default TradingLogic;