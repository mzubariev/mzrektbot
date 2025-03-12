// trading-logic.js
import BinanceWebSocket from '../wss/binance-websocket.js';
import BybitWebSocket from '../wss/bybit-websocket.js';
import OKXWebSocket from '../wss/okx-websocket.js';
import MEXCWebSocket from '../wss/mexc-websocket.js';
import logger from '../utils/logger.js';
import getBinanceExchangeInfo from '../utils/binance-exchange-info.js';
import config from '../utils/configuration.js';
import { calculateBidAmount, getOppositeTradeSide, translatePositionSide, getTokenTrend, getBotTradeSide } from '../utils/helpers.js';

const STUCK_ORDER_STATUSES_TO_ALERT = ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'];

class TradingLogic {
  constructor({ binanceApiKey, binanceSecretKey, bybitApiKey, bybitSecretKey, okxApiKey, okxSecretKey, okxPassphrase, mexcApiKey, mexcSecretKey }) {
    this.telegramBot = null;
    this.binanceWs = new BinanceWebSocket(binanceApiKey, binanceSecretKey);
    // this.bybitWs = new BybitWebSocket(bybitApiKey, bybitSecretKey);
    // this.okxWs = new OKXWebSocket(okxApiKey, okxSecretKey, okxPassphrase);
    // this.mexcWs = new MEXCWebSocket(mexcApiKey, mexcSecretKey);
    this.binanceExchangeInfo = null;
    this.liquidationAccumulation = {};
    this.openOrders = new Map();
    this.isPaused = false;

    this.statisticsData = {
      allREKTS: 0,
      skipBTC_ETH: 0,
      skipPausedNotEnoughForBid: 0,
      allRektsInThreshold: 0,
      skipAlready4orders: 0,
      skipExcludedHardcoded: 0,
      skipRektAnd4hFalse: 0,
      yes4hAnd15mTrue: 0,
      idealYesRektAnd4hAnd15mTrue: 0,
      yesRektAnd15mTrue: 0,
      skipBeginningOfCandle: 0,
      skipEndOfCandle: 0,
      skipLongResistanceLvlMakeShort: 0,
      skipLongResistanceLvl: 0,
      skipShortSupportLvlMakeLong: 0,
      skipShortSupportLvl: 0,
      skipTradeSmallBid: 0,
      errOnMarketExecution: 0,
      errOnLimitExecution: 0,
      errGeneralOnTrade: 0,
      executeYes4hAnd15mTrue: 0,
      executeRektAnd15mTrue: 0,
      executedOpeningMarketOrders: 0,
      executedClosingLimitOrders: 0,
      accumulatedRektExecution: 0,
      preFormatCeil: 0,
      preFormatFloor: 0,
      preFormatTrunc: 0
    }

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
      this.statisticsData.skipPausedNotEnoughForBid += 1;
    } else if (availableBalance >= amountForBid && this.isPaused) {
      this.resume();
    }
  }

  async processLiquidation(liquidation, exchange) {
    const { s: symbol, S: liquidationSide, q: quantity, ap: price } = liquidation;
    const tokenInfo = this.binanceExchangeInfo[symbol];
    const liquidationAmount = parseFloat(quantity) * parseFloat(price);
    const whichPositionsLiquidated = translatePositionSide(getOppositeTradeSide(liquidationSide)); // liquidationSide: BUY - go up, liquidates SHORTs; SELL - go down, liquidates LONGs

    this.statisticsData.allREKTS += 1;

    if (symbol.includes('BTCUSDT') || symbol.includes('ETHUSDT')) {
      logger.warn(`Skipping BTCUSDT and ETHUSDT for now...`);
      this.statisticsData.skipBTC_ETH += 1;
      return;
    }

    logger.info('\n---Processing liquidation---');
    logger.info(`${exchange.name}, ${symbol}, ${whichPositionsLiquidated} -${liquidationAmount}$ -> ${getTokenTrend(liquidationSide)} <- Price: ${price}$, Quantity: ${quantity} | Average Ask Volume: ${tokenInfo.avgAskVolume}, Average Bid Volume: ${tokenInfo.avgBidVolume}`);

    // if BUY/SHORT rekts - it is buys so the trend goes up and we check Asks above; if SELL/LONG rekts - it is sells and the trend goes down and we check Bids below
    if ((liquidationSide === 'BUY' && quantity >= tokenInfo.avgAskVolume) || (liquidationSide === 'SELL' && quantity >= tokenInfo.avgBidVolume)) {
      try {
        this.statisticsData.allRektsInThreshold += 1;

        const tradeSide = getBotTradeSide(liquidationSide);
        const positionSide = translatePositionSide(tradeSide);

        if (config.current.longsOrShortsOrBoth.toUpperCase() !== 'BOTH' && (config.current.longsOrShortsOrBoth.toUpperCase() !== positionSide.toUpperCase())) {
          logger.warn(`Skipping the trade since it is ${positionSide} while the setting is only for ${config.current.longsOrShortsOrBoth}s!`);
          return;
        }

        if (exchange.positionsInfo[symbol] && exchange.positionsInfo[symbol][positionSide] && exchange.positionsInfo[symbol][positionSide].ordersAmount >= config.current.sameSymbolOrdersLimit) {
          logger.warn(`Skipping the trade since there are already ${exchange.positionsInfo[symbol][positionSide].ordersAmount} orders opened for this token! Wait till they are closed...`);
          this.statisticsData.skipAlready4orders += 1;
          return;
        }

        // The MAIN logic to determine if we are OK to start a deal, and to choose a direction

        const candle4h = await exchange.getTokenCandleTrend(symbol, '4h');
        const candle15m = await exchange.getTokenCandleTrend(symbol, '15m');
        const lastPrice = await exchange.getSymbolLastPrice(symbol);
        const { distanceToResistance, distanceToSupport } = await exchange.getOrderBookSupportResistance(symbol, tokenInfo.orderBookMinimalDepth, lastPrice);

        // ✅ Main Decision Logic
        const currentTimestamp = Date.now();

        // ✅ Skip if the trade is too close to the start or end of the candle
        if ((currentTimestamp - candle4h.openTime) <= config.current.timeToCheckForCandleEdges / 60000) {
          logger.warn('Skipping the trade since it is in the very beginning of a candle...');
          this.statisticsData.skipBeginningOfCandle += 1;
          return;
        }

        if ((candle4h.closeTime - currentTimestamp) <= config.current.timeToCheckForCandleEdges / 60000) {
          logger.warn('Skipping the trade since it is in the very end of a candle...');
          this.statisticsData.skipEndOfCandle += 1;
          return;
        }

        // ✅ Case 1: When 15m trend matches 4h trend
        if (candle15m.trend === candle4h.trend) {
          this.statisticsData.yes4hAnd15mTrue += 1;

          if (candle4h.trend === tradeSide) {
              this.statisticsData.idealYesRektAnd4hAnd15mTrue += 1;
          }

          await processTrade(exchange, symbol, candle15m.trend, distanceToResistance, distanceToSupport, "executeYes4hAnd15mTrue");
        } 
        // ✅ Case 2: When liquidation (tradeSide) matches 15m trend
        else if (tradeSide === candle15m.trend) {
          this.statisticsData.yesRektAnd15mTrue += 1;
          await processTrade(exchange, symbol, candle15m.trend, distanceToResistance, distanceToSupport, "executeRektAnd15mTrue");
        } 
        // ✅ Case 3: Trends do not align → Skip the trade
        else {
          this.statisticsData.skipRektAnd4hFalse += 1;
          logger.warn('The REKT and 4hCandle directions are different! Skipping the deal...');
        }
      } catch (error) {
        this.statisticsData.errGeneralOnTrade += 1;
        logger.error(`Skipping trade execution for ${symbol} on ${exchange.name} due to an error: %j`, error);
        console.log(error);
      }
    }
  }

  async processTradeDecideSellOrBuy(exchange, symbol, trend, distanceToResistance, distanceToSupport, tradeType) {
    return;
    // const isBuy = trend === 'BUY';
    // const isFarFromResistance = distanceToResistance > config.current.percentageHowCloseToLevels;
    // const isFarFromSupport = distanceToSupport > config.current.percentageHowCloseToLevels;

    // if (isBuy) {
    //   if (isFarFromResistance) {
    //     this.statisticsData[tradeType] += 1;
    //     await this.executeTrade(exchange, symbol, 'BUY');
    //   } else if (isFarFromSupport) {
    //     logger.warn('Too close to the resistance level! Try the SHORT deal...');
    //     this.statisticsData.skipLongResistanceLvlMakeShort += 1;
    //     await this.executeTrade(exchange, symbol, 'SELL');
    //   } else {
    //     logger.warn('Too close to the resistance level! Skipping the LONG deal...');
    //     this.statisticsData.skipLongResistanceLvl += 1;
    //   }
    // } else { // SELL case
    //   if (isFarFromSupport) {
    //     this.statisticsData[tradeType] += 1;
    //     await this.executeTrade(exchange, symbol, 'SELL');
    //   } else if (isFarFromResistance) {
    //     logger.warn('Too close to the support level! Try the LONG deal...');
    //     this.statisticsData.skipShortSupportLvlMakeLong += 1;
    //     await this.executeTrade(exchange, symbol, 'BUY');
    //   } else {
    //     logger.warn('Too close to the support level! Skipping the SHORT deal...');
    //     this.statisticsData.skipShortSupportLvl += 1;
    //   }
    // }
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
      this.statisticsData.executedOpeningMarketOrders += 1;

      // Send Limit order to close the Position with 0,2% of 
      const avgPrice = parseFloat(marketOrderResult.avgPrice);
      const executedQuantity = parseFloat(marketOrderResult.executedQty);
      const formattedLimitPrice = this.calculateLimitOrderClosePositionPrice(symbol, positionSide, avgPrice);
      const limitOrderSide = getOppositeTradeSide(tradeSide); 
      const limitOrderResult = await this.sendLimitOrderToClosePosition(exchange, symbol, limitOrderSide, positionSide, executedQuantity, formattedLimitPrice);

      if (limitOrderResult) {
        this.statisticsData.executedClosingLimitOrders += 1;
      }

      // Set a 20-minute timer for the limit order to report in Telegram if the order is still Opened
      // this.setLimitOrderTimer(exchange, symbol, limitOrderResult.orderId);
    } catch (error) {
      throw new Error(`Trade execution failed for ${symbol} on ${exchange.name}: ${error.message}`);
    }
  }

  async executeMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid) {
    logger.info(`Executing trade - Exchange: ${exchange.name}, Token: ${symbol}, TradeSide: ${tradeSide} to ${positionSide}, Amount: ${amountForBid}`);
    
    try {
      let result;
      switch (exchange.name) {
        case 'Binance':
          result = await this.executeBinanceMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid);
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
  async executeBinanceMarketOrder(exchange, symbol, tradeSide, positionSide, amountForBid) {
    try {      
      const lastPrice = await exchange.getSymbolLastPrice(symbol);
    
      if (!lastPrice) {
        throw new Error(`Price for ${symbol} is not available. Ensure the ticker subscription is active.`);
      }
  
      logger.info(`Current price for ${symbol}: ${lastPrice}`);

      const quantity = (amountForBid / lastPrice);
      const formatted_quantity = this.formatSpecificFloatsForToken(symbol, quantity, 'quantityPrecision');

      if (formatted_quantity <= 0) {
        logger.warn(`Skipping the trade - too small Bid for this token...`);
        this.statisticsData.skipTradeSmallBid += 1;
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
      logger.error('Error executing MARKET ORDER:\n%j', error);
      this.statisticsData.errOnMarketExecution += 1;

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
    const limitPrice = positionSide === 'LONG'
      ? avgPrice * (1 + config.current.profitPercentage / 100)
      : avgPrice * (1 - config.current.profitPercentage / 100);

    const tickSize = this.getTokenPrecisions(symbol, 'tickSize');

    console.log(`preFormattedLimitPrice avgPrice: ${avgPrice} / limitPrice: ${limitPrice}`);
    console.log(`preFormattedLimitPrice tickSize: ${tickSize}`);

    let preFormattedLimitPrice = 0;
    if (positionSide === 'LONG') {
      preFormattedLimitPrice = Math.ceil(limitPrice / tickSize) * tickSize;
      console.log(`preFormattedLimitPrice CEIL: ${preFormattedLimitPrice}`);
      this.statisticsData.preFormatCeil += 1;
    } else {
      preFormattedLimitPrice = Math.floor(limitPrice / tickSize) * tickSize;
      console.log(`preFormattedLimitPrice FLOOR: ${preFormattedLimitPrice}`);
      this.statisticsData.preFormatFloor += 1;

      if ((preFormattedLimitPrice / tickSize) % 1 !== 0) {
        const tempPrice = Math.trunc(preFormattedLimitPrice / tickSize);
        preFormattedLimitPrice = tempPrice * tickSize;
        console.log(`preFormattedLimitPrice TRUNC: ${preFormattedLimitPrice}`);

        this.statisticsData.preFormatTrunc += 1;
      }
    }

    const formattedLimitPrice = this.formatSpecificFloatsForToken(symbol, preFormattedLimitPrice, 'pricePrecision');
    return formattedLimitPrice;
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
  
    const truncated = numberString.slice(0, decimalIndex + 1 + precision);
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
    try {
      let accumulatedQuantity = null;
      let closingBreakevenPrice = null;
      
      if (exchange.positionsInfo[symbol] && exchange.positionsInfo[symbol][positionSide]) {
        accumulatedQuantity = exchange.positionsInfo[symbol][positionSide].positionAmount;
        const breakevenPrice = exchange.positionsInfo[symbol][positionSide].breakevenPrice;
  
        if (breakevenPrice) {
          closingBreakevenPrice = this.calculateLimitOrderClosePositionPrice(symbol, positionSide, breakevenPrice)
        }
      }
  
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
  
      logger.info('Sending LIMIT ORDER to close the position:\n%j', limitOrder);
      const limitOrderResult = await exchange.sendOrder(limitOrder);
      logger.info('Limit order result:\n%j', limitOrderResult);
  
      return limitOrderResult;
    } catch (error) {
      logger.error('Error executing LIMIT ORDER:\n%j', error);
      this.statisticsData.errOnLimitExecution += 1;

      throw error;
    }
  }

  setLimitOrderTimer(exchange, symbol, orderId) {
    const timer = setTimeout(() => {
      this.alertHangingLimitOrder(exchange, symbol, orderId);
    }, config.current.timeoutToSignalToTG * 60 * 1000);

    const exchangeName = exchange.name;
    this.openOrders.set(orderId, { exchangeName, symbol, timer });
  }

  async alertHangingLimitOrder(exchange, symbol, orderId) {
    try {
      const order = await exchange.getOrder(orderId, symbol);
      if (STUCK_ORDER_STATUSES_TO_ALERT.includes(order.status)) {
        // Notify via Telegram
        this.telegramBot.sendMsgToTgChat(`Limit order for <strong><a href="https://www.binance.com/en/futures/${symbol}">${symbol} on ${exchange.name}</a></strong> have some issues after ${config.current.timeoutToSignalToTG} minutes. Order status: ${order.status}`);
      }
    } catch (error) {
      logger.error(`Error checking limit order status: ${error}`);
    } finally {
      // clearInterval(openOrders.orderId.timer);
      this.openOrders.delete(orderId);
    }
  }

  // Configurations routine

  handleStatusChange(status) {
    logger.info('Applying new status...');
    status === 'paused' ? this.pause() : this.resume();
  }

  handleGetStatisticsInfo() {
    logger.info('=== INTERMEDIATE STATISTICS ===');
    console.log(this.statisticsData);
    this.telegramBot.sendMsgToTgChat(JSON.stringify(this.statisticsData, null, 2));
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