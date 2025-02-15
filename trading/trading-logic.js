// trading-logic.js
import BinanceWebSocket from '../wss/binance-websocket.js';
import BybitWebSocket from '../wss/bybit-websocket.js';
import OKXWebSocket from '../wss/okx-websocket.js';
import MEXCWebSocket from '../wss/mexc-websocket.js';
import logger from '../utils/logger.js';
import getMarketCapTokenData from '../utils/coinmarketcap-token-data.js';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import config from '../utils/configuration.js';
import { roundDownToTwoDecimals, calculateBidAmount, getOppositeTradeSide, translatePositionSide, getTokenTrend, getBotTradeSide } from '../utils/helpers.js';

const STUCK_ORDER_STATUSES_TO_ALERT = ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'];
const TIMEOUT_TO_SIGNAL_TO_TG = 20; // minutes

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey, bybitApiKey, bybitSecretKey, okxApiKey, okxSecretKey, okxPassphrase, mexcApiKey, mexcSecretKey }) {
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

    logger.info('BOT Initialized with config: %j', config.current);

    config.on('statusChanged', ({ status }) => {
      this.handleStatusChange(status);
    });
  }

  async initialize(telegramBot) {
    try {
      this.marketCapTokenData = await getMarketCapTokenData();
      this.binanceExchangeInfo = await getBinanceExchangeInfo();

      this.telegramBot = telegramBot;

      await this.binanceWs.connect();
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

  setupLiquidationListeners() {
    // Binance
    this.binanceWs.events.on('message', async (liquidation) => {
      await this.checkIfEnoughBalanceForBid(this.binanceWs);

      if (this.isPaused) {
        return;
      }

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

  async processLiquidation(liquidation, exchange) {
    const { s: symbol, S: liquidationSide, q: quantity, ap: price } = liquidation;
    const tokenRanking = this.getTokenRanking(symbol);
    const liquidationThreshold = this.getLiquidationThreshold(tokenRanking);
    const liquidationAmount = parseFloat(quantity) * parseFloat(price);

    if (['top20', 'top50'].includes(tokenRanking)) {
      logger.warn(`Skipping ${tokenRanking} token for now...`);
      return;
    }

    logger.info('\n---Processing liquidation---');
    logger.info(`${exchange.name}, ${symbol}, ${translatePositionSide(liquidationSide)} -${liquidationAmount}$ -> ${getTokenTrend(liquidationSide)} <- Price: ${price}$, Quantity: ${quantity} | Token rank: ${tokenRanking}, Liquidation threshold: ${liquidationThreshold}$`);

    if (liquidationAmount >= liquidationThreshold) {
      try {
        const tradeSide = getBotTradeSide(liquidationSide);
        const positionSide = translatePositionSide(tradeSide);

        if (config.current.longsOrShortsOrBoth.toUpperCase() === 'LONG' && tradeSide.toUpperCase() === 'SELL') {
          logger.warn(`Skipping the trade since it is ${tradeSide} while the setting is only for ${config.current.longsOrShortsOrBoth}s!`);
          return;
        } else if (config.current.longsOrShortsOrBoth.toUpperCase() === 'SHORT' && tradeSide.toUpperCase() === 'BUY') {
          logger.warn(`Skipping the trade since it is ${tradeSide} while the setting is only for ${config.current.longsOrShortsOrBoth}s!`);
          return;
        }

        if (exchange.positionsInfo[symbol] && exchange.positionsInfo[symbol][positionSide] && exchange.positionsInfo[symbol][positionSide].ordersAmount >= 2) {
          logger.warn(`Skipping the trade since there are already ${exchange.positionsInfo[symbol][positionSide].ordersAmount} orders opened for this token! Wait till they are closed...`);
          return;
        }


        /* Протестировать три варанта проверок: 
        - Проверить интервалы 1-3-5-15-30 минут (для эфира больший, для монеты меньший)
        - Пробовать суммы мелких ликвидаций по 1000
        1) если тренд и tradeSide совпали - только тогда входим
        2) если tradeSide, 1-4-часовой тренд эфира и тренд монеты совпали - тогда входим, если нет - тогда входим если совпали тренд эфира и tradeSide
        3) если tradeSide, 1-4-часовой тренд эфира и тренд монеты совпали - тогда входим
        4) куда тренд - туда сразу и залетам
        */

        const candleTrend = await exchange.getTokenCandleTrend(symbol);
        // if (tradeSide === candleTrend) {
          await this.executeTrade(exchange, symbol, candleTrend); 
        // }

        return;
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
    try {
      // Send Market order
      const amountForBid = calculateBidAmount(exchange);
      const positionSide = translatePositionSide(tradeSide);
      const marketOrderResult = await this.executeMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid);

      if (!marketOrderResult) {
        return;
      }

      // Send Limit order to close the Position with 0,2% of 
      const avgPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);
      const formattedLimitPrice = this.calculateLimitOrderClosePositionPrice(symbol, positionSide, avgPrice);
      const limitOrderSide = getOppositeTradeSide(tradeSide); 
      const limitOrderResult = await this.sendLimitOrderToClosePosition(exchange, symbol, limitOrderSide, positionSide, executedQuantity, formattedLimitPrice);

      // Set a 20-minute timer for the limit order to report in Telegram if the order is still Opened
      // this.setLimitOrderTimer(exchange, symbol, limitOrderResult.orderId);
    } catch (error) {
      logger.error(`Error executing trade on ${exchange.name}: ${error.message}`);
      logger.debug('Error details:\n%j', error);
      throw new Error(`Trade execution failed for ${symbol} on ${exchange.name}: ${error.message}`);
    }
  }

  async executeMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid) {
    logger.info(`Executing trade - Exchange: ${exchange.name}, Token: ${symbol}, TradeSide: ${tradeSide} to ${positionSide}, Amount: ${amountForBid}`);
    
    try {
      let result;
      switch (exchange.name) {
        case 'Binance':
          result = await this.executeBinanceMarketOrder(symbol, tradeSide, positionSide, amountForBid);
          break;
        case 'Bybit':
          result = await this.executeBybitMarketOrder(symbol, tradeSide, amountForBid);
          break;
        case 'OKX':
          result = await this.executeOKXMarketOrder(symbol, tradeSide, amountForBid);
          break;
        case 'MEXC':
          result = await this.executeMEXCMarketOrder(symbol, tradeSide, amountForBid);
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
  async executeBinanceMarketOrder(symbol, tradeSide, positionSide, amountForBid) {
    try {      
      const lastPrice = this.binanceWs.tickerPrices[symbol];
    
      if (!lastPrice) {
        throw new Error(`Price for ${symbol} is not available. Ensure the ticker subscription is active.`);
      }
  
      logger.info(`Current price for ${symbol}: ${lastPrice}`);

      const quantity = (amountForBid / lastPrice);
      const formatted_quantity = this.formatSpecificFloatsForToken(symbol, quantity, 'quantityPrecision');

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

      logger.info('Placing the Order:\n%j', order);
      return await this.binanceWs.sendOrder(order);
    } catch (error) {
      logger.error('Error executing market order:\n%j', error);

      this.pause();

      throw error;
    }
  }

  // Bybit
  async executeBybitMarketOrder(symbol, tradeSide, amountForBid) {
    const order = {
      symbol: symbol,
      side: tradeSide,
      orderType: 'Market',
      orderQty: amountForBid,
      orderFilter: 'Order'
    };
    return await this.bybitWs.sendOrder(order);
  }

  // OKX
  async executeOKXMarketOrder(symbol, tradeSide, amountForBid) {
    const order = {
      instId: symbol,
      tdMode: 'cash',
      side: tradeSide,
      ordType: 'market',
      tgtCcy: 'quote_ccy',
      sz: amountForBid
    };
    return await this.okxWs.sendOrder(order);
  }

  // MEXC
  async executeMEXCMarketOrder(symbol, tradeSide, amountForBid) {
    const order = {
      symbol: symbol,
      side: tradeSide,
      type: 'MARKET',
      quoteOrderQty: amountForBid
    };
    return await this.mexcWs.sendOrder(order);
  }

  calculateLimitOrderClosePositionPrice(symbol, positionSide, avgPrice) {
    console.log('calculateLimitOrderClosePositionPrice');
    console.log(`avgPrice ${avgPrice}`);
    const limitPrice = positionSide === 'LONG'
      ? avgPrice * (1 + config.current.profitPercentage / 100)
      : avgPrice * (1 - config.current.profitPercentage / 100);
    console.log(`limitPrice ${limitPrice}`);
    const tickSize = this.getTokenPrecisions(symbol, 'tickSize');
    console.log(`tickSize ${tickSize}`);
    let preFormattedLimitPrice = Math.ceil(limitPrice / tickSize) * tickSize;
    console.log(`CEIL: ${preFormattedLimitPrice}`);
  
    if (String(preFormattedLimitPrice).length >= 12 && !['NEIROETHUSDT', 'CKBUSDT'].includes(symbol)) {
      preFormattedLimitPrice = Math.floor(limitPrice / tickSize) * tickSize;
      console.log(`FLOOR: ${preFormattedLimitPrice}`);
    }

    const formattedLimitPrice = this.formatSpecificFloatsForToken(symbol, preFormattedLimitPrice, 'pricePrecision');
    console.log(`With pricePrecision CUT: ${formattedLimitPrice}`);
    return formattedLimitPrice;
  }
  
  formatSpecificFloatsForToken(symbol, number, tokenPrecisionSetting) {
    console.log('formatSpecificFloatsForToken');
    console.log(`Numer ${number}`);
    const numberString = number.toString();
    console.log(`numberString ${numberString}`);
    const decimalIndex = numberString.indexOf('.');
  
    if (decimalIndex === -1) {
      return number;
    }
  
    const precision = this.getTokenPrecisions(symbol, tokenPrecisionSetting);
    console.log(`precision ${precision}`);
  
    if (precision === 0) {
      return Math.ceil(number);
    }
  
    const truncated = numberString.slice(0, decimalIndex + 1 + precision);
    console.log(`truncated ${truncated}`);
    console.log(`parseFloat(truncated) ${parseFloat(truncated)}`);
    return parseFloat(truncated);
  }

  getTokenPrecisions(symbol, tokenPrecisionSetting) {
    // See tokenPrecisionSetting options in ./binance-exchange-info.json
    const tokenInfo = this.binanceExchangeInfo[symbol]
  
    if (!tokenInfo) {
      throw new Error(`Token ${symbol} not found in exchangeInfo`);
    }
  
    return tokenInfo[tokenPrecisionSetting];
  }

  async sendLimitOrderToClosePosition(exchange, symbol, orderSide, positionSide, quantity, price) {
    let accumulatedQuantity = null;
    let closingBreakevenPrice = null;
    
    if (exchange.positionsInfo[symbol] && exchange.positionsInfo[symbol][positionSide]) {
      accumulatedQuantity = exchange.positionsInfo[symbol][positionSide].positionAmount;
      const breakevenPrice = exchange.positionsInfo[symbol][positionSide].breakevenPrice;

      if (breakevenPrice) {
        closingBreakevenPrice = this.calculateLimitOrderClosePositionPrice(symbol, positionSide, breakevenPrice)
      }
    }  

    console.log('sendLimitOrderToClosePosition');
    console.log('Quantities');
    console.log(`quantity ${quantity}`);
    console.log(`accumulatedQuantity ${accumulatedQuantity}`);
    console.log(`Math.max(Math.abs(accumulatedQuantity), quantity) ${Math.max(Math.abs(accumulatedQuantity), quantity)}`);
    console.log('Prices');
    console.log(`price ${price}`);
    console.log(`increasedAndFormattedBreakevenPrice ${closingBreakevenPrice}`);

    const limitOrder = {
      symbol: symbol,
      side: orderSide,
      positionSide: positionSide,
      type: 'LIMIT',
      quantity: Math.max(Math.abs(accumulatedQuantity), quantity),
      price: closingBreakevenPrice || price,
      timeInForce: 'GTC',
      newOrderRespType: 'RESULT'
    };

    logger.info('Sending limit order to close the position:\n%j', limitOrder);
    const limitOrderResult = await exchange.sendOrder(limitOrder);
    logger.info('Limit order result:\n%j', limitOrderResult);

    return limitOrderResult;
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

    const tradeSide = getBotTradeSide(liquidationSide);

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
    }, TIMEOUT_TO_SIGNAL_TO_TG * 60 * 1000);

    const exchangeName = exchange.name;
    this.openOrders.set(orderId, { exchangeName, symbol, timer });
  }

  async alertHangingLimitOrder(exchange, symbol, orderId) {
    try {
      const order = await exchange.getOrder(orderId, symbol);
      if (STUCK_ORDER_STATUSES_TO_ALERT.includes(order.status)) {
        // Notify via Telegram
        this.telegramBot.sendMsgToTgChat(`Limit order for <strong><a href="https://www.binance.com/en/futures/${symbol}">${symbol} on ${exchange.name}</a></strong> have some issues after ${TIMEOUT_TO_SIGNAL_TO_TG} minutes. Order status: ${order.status}`);
      }
    } catch (error) {
      logger.error(`Error checking limit order status: ${error}`);
    } finally {
      // clearInterval(openOrders.orderId.timer);
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
        return config.current.top20Liquidation;
      case 'top50':
        return config.current.top50Liquidation;
      default:
        return config.current.smallLiquidation;
    }
  }

  // Configurations routine

  handleStatusChange(status) {
    logger.info('Applying new status...');
    status === 'paused' ? this.pause() : this.resume();
  }

  updateMarketCapTokenData(tokenData) {
    this.marketCapTokenData = tokenData;
  }

  updateBinanceExchangeInfo(binanceExchangeInfo) {
    this.binanceExchangeInfo = binanceExchangeInfo;
  }

  async updateDepositSizeConfig() {
    logger.info('Updating Deposit Size config...');
    const walletBalance = this.binanceWs.accountInfo.walletBalance;
    config.setConfig({ "depositSize": walletBalance });

    // TODO: Add for other exchanges too
  }

  pause() {
    this.isPaused = true;
    logger.warn('Trading logic paused!');
  }

  resume() {
    this.isPaused = false;
    logger.info('Trading logic resumed!');
  }
}

export default TradingLogic;