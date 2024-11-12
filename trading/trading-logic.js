// trading-logic.js
import BinanceWebSocket from '../wss/binance-websocket.js';
import BybitWebSocket from '../wss/bybit-websocket.js';
import OKXWebSocket from '../wss/okx-websocket.js';
import MEXCWebSocket from '../wss/mexc-websocket.js';
import logger from '../utils/logger.js';
import getTokenData from '../utils/coinmarketcap-token-data.js';
import Configuration from '../utils/configuration.js';

const config = new Configuration('./config.json');

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey, bybitApiKey, bybitSecretKey, okxApiKey, okxSecretKey, okxPassphrase, mexcApiKey, mexcSecretKey, isTestnet }) {
    this.config = config.getConfig();
    this.binanceWs = new BinanceWebSocket(binanceApiKey, binanceSecretKey, isTestnet);
    this.bybitWs = new BybitWebSocket(bybitApiKey, bybitSecretKey, isTestnet);
    this.okxWs = new OKXWebSocket(okxApiKey, okxSecretKey, okxPassphrase, isTestnet);
    this.mexcWs = new MEXCWebSocket(mexcApiKey, mexcSecretKey);
    this.tokenData = null;
    this.liquidationAccumulation = {};
    this.openOrders = new Map();
    this.isPaused = false;

    logger.info('TradingLogic initialized with config:', this.config);

    // Listen for configuration updates
    config.on('configUpdated', (newConfig) => {
      this.config = newConfig;
      logger.info('Configuration updated dynamically:', newConfig);
      this.handleConfigChange(newConfig);
    });
  }

  handleConfigChange(newConfig) {
    // Logic to handle updated config values (e.g., update internal settings or WebSocket parameters)
    logger.info('Applied new configuration settings:', newConfig);
    // Optionally, reconfigure WebSockets or other properties as needed
  }

  async initialize() {
    try {
      // Retrieve token data from CoinMarketCap
      this.tokenData = await getTokenData();

      // Connect to exchanges' WebSocket APIs
      this.binanceWs.connect();
      this.bybitWs.connect();
      this.okxWs.connect();
      this.mexcWs.connect();

      // Set up event listeners for liquidation data from each exchange
      this.setupLiquidationListeners();
    } catch (error) {
      logger.error('Error initializing Trading Logic:', error);
      throw error;
    }
  }

  /* Telegram interactions */

  pause() {
    this.isPaused = true;
    logger.info('Trading logic paused');
    // Optionally, you can add code here to cancel any pending orders or perform cleanup
  }

  resume() {
    this.isPaused = false;
    logger.info('Trading logic resumed');
    // Optionally, you can add code here to restart any necessary processes
  }

  /* Trading */

  setupLiquidationListeners() {
    // Binance
    this.binanceWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.e === 'forceOrder') {
        await this.processLiquidation(message.o, 'Binance');
      }
    });

    Bybit
    this.bybitWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.topic === 'liquidation') {
        await this.processLiquidation(message.data, 'Bybit');
      }
    });

    OKX
    this.okxWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.event === 'liquidation') {
        await this.processLiquidation(message.data[0], 'OKX');
      }
    });

    MEXC
    this.mexcWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.channel === 'push.liquidation') {
        await this.processLiquidation(message.data, 'MEXC');
      }
    });
  }

  async processLiquidation(liquidation, exchange) {
    logger.debug('Processing liquidation: %j', liquidation);

    if (this.isPaused) {
      logger.info('Liquidation processing skipped: Trading is paused');
      return;
    }

    const { s: symbol, o: orderType, q: quantity, p: price } = liquidation;
    const token = symbol.replace('USDT', '');

    logger.info('Liquidation details - Token: %s, OrderType: %s, Quantity: %s, Price: %s', token, orderType, quantity, price);

    // Check token ranking and liquidation conditions
    const tokenRanking = this.getTokenRanking(token);
    const liquidationThreshold = this.getLiquidationThreshold(tokenRanking);
    const liquidationAmount = parseFloat(quantity) * parseFloat(price);

    logger.debug('Token ranking: %s, Liquidation threshold: %s, Liquidation amount: %s', tokenRanking, liquidationThreshold, liquidationAmount);

    const tradeSide = orderType === 'SELL' ? 'BUY' : 'SELL';

    if (liquidationAmount >= liquidationThreshold) {
      // Execute trade
      try {
        await this.executeTrade(exchange, token, tradeSide, liquidationAmount);
      } catch (error) {
        logger.error('Error executing trade for %s on %s: %s', token, exchange.url, error.message);
        logger.debug('Error details: %O', error);
        // Skip the trade execution and continue with the next liquidation
        logger.warn('Skipping trade execution for %s on %s due to an error.', token, exchange.url);
        return;
      }
    } else {
      // Accumulate liquidation amount
      this.accumulateLiquidation(exchange, token, tradeSide, liquidationAmount);
    }
  }

  async executeTrade(exchange, token, orderType, liquidationAmount) {
    logger.info(`Executing trade - Exchange: ${exchange.name}, Token: ${token}, OrderType: ${orderType}, Amount: ${liquidationAmount}`);

    if (this.isPaused) {
      logger.info(`Trade execution skipped: Trading is paused (${token} on ${exchange.url})`);
      return;
    }
    
    try {
      const amount_for_bid = this.config.depositSize * this.config.bidPrcnt / 100;
      const symbol = `${token}USDT`;

      logger.info('Placing market order - Amount in USDT: %s', amount_for_bid);
      const marketOrderResult = await this.executeMarketOrder(exchange, symbol, orderType, amount_for_bid);
      logger.info('Market order result: %j', marketOrderResult);

      // Get the average price and executed quantity of the market order
      const avgPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);

      // Calculate the limit price for the closing order
      const profitPercentage = 0.001; // 0.1%
      const limitPrice = orderType === 'BUY'
        ? avgPrice * (1 + profitPercentage)
        : avgPrice * (1 - profitPercentage);

      // Place a limit order to close the position
      const limitOrder = {
        symbol: symbol,
        side: orderType === 'BUY' ? 'SELL' : 'BUY',
        type: 'LIMIT',
        quantity: executedQuantity,
        price: limitPrice.toFixed(8),
      };

      logger.info('Placing limit order - Price: %s', limitPrice.toFixed(8));
      const limitOrderResult = await exchange.send(limitOrder);
      logger.info('Limit order result: %j', limitOrderResult);

      // Set a 5-minute timer for the limit order
      this.setLimitOrderTimer(exchange, token, limitOrderResult.orderId);

      logger.info(`Executed ${orderType} order for ${token} on ${exchange.url}`);
    } catch (error) {
      logger.error('Error executing trade on %s: %s', exchange.url, error.message);
      logger.debug('Error details: %O', error);
      throw new Error(`Trade execution failed for ${token} on ${exchange.url}: ${error.message}`);
    }
  }

  async executeMarketOrder(exchange, symbol, side, quoteOrderQty) {
    logger.info(`Executing market order on ${exchange.name}: ${symbol}, ${side}, ${quoteOrderQty} USDT`);
    
    try {
      let result;
      switch (exchange.name) {
        case 'Binance':
          result = await this.executeBinanceMarketOrder(symbol, side, quoteOrderQty);
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
      
      logger.info(`Market order executed successfully on ${exchange.name}:`, result);
      return result;
    } catch (error) {
      logger.error(`Error executing market order on ${exchange.name}:`, error);
      throw error;
    }
  }

  // Binance
  async executeBinanceMarketOrder(symbol, side, quoteOrderQty) {
    const order = {
      symbol: symbol,
      side: side,
      type: 'MARKET',
      quoteOrderQty: quoteOrderQty
    };
    return await this.binanceWs.send(order);
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
    return await this.bybitWs.send(order);
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
    return await this.okxWs.send(order);
  }

  // MEXC
  async executeMEXCMarketOrder(symbol, side, quoteOrderQty) {
    const order = {
      symbol: symbol,
      side: side,
      type: 'MARKET',
      quoteOrderQty: quoteOrderQty
    };
    return await this.mexcWs.send(order);
  }

  accumulateLiquidation(exchange, token, tradeSide, amount) {
    const now = Date.now();
    if (!this.liquidationAccumulation[token]) {
      this.liquidationAccumulation[token] = {
        amount: 0,
        startTime: now,
      };
    }

    this.liquidationAccumulation[token].amount += amount;

    if (now - this.liquidationAccumulation[token].startTime >= 5000) {
      // Check if accumulated amount meets the threshold
      const tokenRanking = this.getTokenRanking(token);
      const liquidationThreshold = this.getLiquidationThreshold(tokenRanking);
      
      if (this.liquidationAccumulation[token].amount >= liquidationThreshold) {
        this.executeTrade(exchange, token, tradeSide, this.liquidationAccumulation[token].amount);
      }

      // Reset accumulation
      this.liquidationAccumulation[token] = {
        amount: 0,
        startTime: now,
      };
    }
  }

  getBestExchange() {
    // Implement logic to determine the best exchange based on liquidity, fees, etc.
    // For now, we'll just return a random exchange
    const exchanges = [this.binanceWs, this.bybitWs, this.okxWs, this.mexcWs];
    return exchanges[Math.floor(Math.random() * exchanges.length)];
  }

  setLimitOrderTimer(exchange, token, orderId) {
    const timer = setTimeout(() => {
      this.checkLimitOrder(exchange, token, orderId);
    }, 5 * 60 * 1000); // 5 minutes

    this.openOrders.set(orderId, { exchange, token, timer });
  }

  async checkLimitOrder(exchange, token, orderId) {
    try {
      const order = await exchange.getOrder(orderId);
      if (order.status === 'OPEN') {
        // Notify via Telegram
        this.telegramBot.sendMessage(this.config.telegramChatId, `Limit order for ${token} on ${exchange.url} remains unfilled after 5 minutes.`);
      }
    } catch (error) {
      logger.error(`Error checking limit order status:`, error);
    } finally {
      this.openOrders.delete(orderId);
    }
  }

  getTokenRanking(token) {
    if (this.tokenData.top20.includes(token)) {
      return 'top20';
    } else if (this.tokenData.top50.includes(token)) {
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

  updateTokenData(tokenData) {
    this.tokenData = tokenData;
  }
}

export default TradingLogic;