const BinanceWebSocket = require('../wss/binance-websocket');
const BybitWebSocket = require('../wss/bybit-websocket');
const OKXWebSocket = require('../wss/okx-websocket');
const MEXCWebSocket = require('../wss/mexc-websocket');
const logger = require('../utils/logger');

class TradingLogic {
  constructor(config) {
    this.config = config;
    this.binanceWs = new BinanceWebSocket(config.binanceApiKey, config.binanceSecretKey, config.isTestnet);
    this.bybitWs = new BybitWebSocket(config.bybitApiKey, config.bybitSecretKey, config.isTestnet);
    this.okxWs = new OKXWebSocket(config.okxApiKey, config.okxSecretKey, config.okxPassphrase, config.isTestnet);
    this.mexcWs = new MEXCWebSocket(config.mexcApiKey, config.mexcSecretKey);
    this.tokenData = null;
    this.liquidationAccumulation = {};
    this.openOrders = new Map();
    this.isPaused = false;

    logger.info('TradingLogic initialized with config: %j', config);
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

  setupLiquidationListeners() {
    // Binance
    this.binanceWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.e === 'forceOrder') {
        await this.processLiquidation(message, 'Binance');
      }
    });

    // Bybit
    this.bybitWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.topic === 'liquidation') {
        await this.processLiquidation(message.data, 'Bybit');
      }
    });

    // OKX
    this.okxWs.ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.event === 'liquidation') {
        await this.processLiquidation(message.data[0], 'OKX');
      }
    });

    // MEXC
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

    if (liquidationAmount >= liquidationThreshold) {
      // Execute trade
      const tradeSide = orderType === 'SELL' ? 'BUY' : 'SELL';
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
      this.accumulateLiquidation(exchange, token, liquidationAmount);
    }
  }

  accumulateLiquidation(exchange, token, amount) {
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
        this.executeTrade(exchange, token, 'BUY', this.liquidationAccumulation[token].amount);
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

  async executeTrade(exchange, token, orderType, liquidationAmount) {
    logger.info('Executing trade - Exchange: %s, Token: %s, OrderType: %s, Amount: %s', exchange.url, token, orderType, liquidationAmount);

    if (this.isPaused) {
      logger.info(`Trade execution skipped: Trading is paused (${token} on ${exchange.url})`);
      return;
    }
    
    try {
      const amount = this.config.depositSize * this.config.bidPrcnt / 100;

      // Fetch the current market price of the token
      const tickerResponse = await exchange.fetchTicker(`${token}USDT`);
      const currentPrice = tickerResponse.last;

      logger.debug('Current price for %s: %s', token, currentPrice);

      // Calculate the quantity based on the total amount and current price
      const quantity = (amount / currentPrice).toFixed(8);

      logger.info('Placing market order - Quantity: %s', quantity);

      // Place a market order to buy the token
      /* Some exchanges has a parameter { quoteOrderQty: amount } instead of quantity - it is as "to buy/fill-in by a cost"
      We need to ask exchanges support about that */
      const marketOrder = {
        symbol: `${token}USDT`,
        side: orderType,
        type: 'MARKET',
        quantity: quantity,
      };
      const marketOrderResult = await exchange.send(marketOrder);

      logger.info('Market order result: %j', marketOrderResult);

      // Get the average price and executed quantity of the market order
      const avgPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);

      // Calculate the limit price based on the average price and the desired profit percentage
      const profitPercentage = 0.001; // 0.1%
      const limitPrice = orderType === 'BUY'
        ? avgPrice * (1 + profitPercentage)
        : avgPrice * (1 - profitPercentage);

      logger.info('Placing limit order - Price: %s, Quantity: %s', limitPrice.toFixed(8), executedQuantity);

      // Place a limit order to close the position
      const limitOrder = {
        symbol: `${token}USDT`,
        side: orderType === 'BUY' ? 'SELL' : 'BUY',
        type: 'LIMIT',
        quantity: executedQuantity,
        price: limitPrice.toFixed(8),
      };
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

module.exports = TradingLogic;