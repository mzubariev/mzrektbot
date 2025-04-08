// binance-websocket.js
import EventEmitter from 'events';
import WebSocket from 'ws';
import logger from '../utils/logger.js';
import nacl from 'tweetnacl';
import base64 from 'base64-js';
import axios from 'axios';
import config from '../utils/configuration.js';
import { roundDownToTwoDecimals, getCurrentTimestamp } from '../utils/helpers.js';

EventEmitter.defaultMaxListeners = 30;
//process.setMaxListeners(100);

const REST_API_URL = 'https://fapi.binance.com/fapi/v1';
const WSS_URL_API = 'wss://ws-fapi.binance.com/ws-fapi/v1';
const WSS_URL_STREAMS = 'wss://fstream.binance.com/ws';

class BinanceWssRestApi extends EventEmitter {
  constructor(apiKey, secretKeyRaw) {
    super();
    this.name = 'Binance';
    this.apiKey = apiKey;
    this.secretKeyRaw = secretKeyRaw;
    this.wsMarketStreams = null;
    this.wsApi = null;
    this.wsUserDataStreams = null;

    this.reconnectTimerStreamsWs = null;
    this.reconnectTimerApiWs = null;
    this.isForceDisconnectStreamsWs = false;
    this.isForceDisconnectApiWs = false;
    this.isForceDisconnectUserDataStreamsWs = false;
    this.reconnectInterval = 5000;
    
    this.allTokensList = [];
    this.priceVolumeCache = {};
    this.cvdMinuteDelta = {};
    this.latestFundingRates = {};
    this.latestOpenInterest = {};
    this.accountInfo = {
      walletBalance: config.current.depositSize,
      availableBalance: config.current.depositSize
    };
    this.positionsInfo = {};

    this.events = new EventEmitter();
  }

  // Authentication and ListenKey

  authenticate() {
    const timestamp = this.getTimestamp();
    const signature = this.generateSignature(timestamp);

    const authMessage = {
        id: 1,
        method: 'session.logon',
        params: {
            apiKey: this.apiKey,
            timestamp: timestamp,
            signature: signature
        }
    };

    try {
      this.wsApi.send(JSON.stringify(authMessage));
      logger.info(`Authenticated to WSS API!`);
    } catch (error) {
      logger.error(`Error on WSS API authentication!`);
      console.error(error);
      throw error;
    }
  }

  generateSignature(timestamp) {
    const secretKeyBytesArray = base64.toByteArray(this.secretKeyRaw).slice(-32);
    const keyPair = nacl.sign.keyPair.fromSeed(secretKeyBytesArray);
    const payload = `apiKey=${this.apiKey}&timestamp=${timestamp}`;
    const payloadUint8 = new TextEncoder().encode(payload);
    const signature = nacl.sign.detached(payloadUint8, keyPair.secretKey);
    return base64.fromByteArray(signature);
  }

  // REST API calls

  async getListenKey() {
    try {
      const response = await axios.post(`${REST_API_URL}/listenKey`, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return response.data.listenKey;
    } catch (error) {
      logger.error(`Error fetching listenKey:`);
      console.error(error);
      throw error;
    }
  }

  keepListenKeyAlive() {
    setInterval(async () => {
      try {
        await axios.put(`${REST_API_URL}/listenKey`, null, {
          headers: { 'X-MBX-APIKEY': this.apiKey },
        });
        logger.info('ListenKey kept alive.');
      } catch (error) {
        logger.error(`Error keeping listenKey alive:`);
        console.error(error);
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }

  async getTokenCandleTrend(symbol, klineInterval) {
    try {
      const response = await axios.get(`${REST_API_URL}/klines`, {
        params: {
          symbol: symbol.toUpperCase(),
          interval: klineInterval,
          limit: 1, // Fetch only the latest interval candle
        },
      });
  
      if (response.data.length === 0) {
        logger.error(`No data available for ${symbol}`);
        return;
      }
  
      const [openTime, open, high, low, close, volume, closeTime] = response.data[0];
  
      const trend = parseFloat(close) > parseFloat(open) ? 'BUY' : 'SELL';
      const candleCurrentLifeTime = this.getCandleDuration(openTime);

      logger.info(`${symbol} | ${klineInterval} Candle Trend: ${trend} | Candle current Lifetime: ${candleCurrentLifeTime} | Volume: ${volume}`);

      return { trend, openTime, closeTime, volume };
    } catch (error) {
      logger.error(`Error fetching ${klineInterval} Kline for ${symbol}: %j`, error.response?.data || error.message);
    }
  }

  async startIntervalsToCollectBinanceData() {
    await this.fetchInitialFuturesPriceVolume();
    await this.fetchOpenInterestLive();
    await this.fetchFundingRates();
  
    const timestamp = getCurrentTimestamp();
  
    for (const symbol of this.allTokensList) {
      const { price = null, volume = null } = this.priceVolumeCache[symbol] || {};
      const cvd = this.cvdMinuteDelta[symbol] || 0;
      const funding = this.latestFundingRates[symbol] ?? null;
      const openInterest = this.latestOpenInterest[symbol] ?? null;
  
      this.events.emit('message:minuteTick', {
        symbol,
        timestamp,
        price,
        volume,
        cvd,
        funding,
        openInterest,
      });
  
      this.cvdMinuteDelta[symbol] = 0;
    }
  
    // Align to next full minute
    const now = Date.now();
    const msToNextMinute = 60000 - (now % 60000);
  
    setTimeout(() => {
      // === Every 1 minute ===
      setInterval(() => {
        const timestamp = getCurrentTimestamp();
  
        for (const symbol of this.allTokensList) {
          const { price = null, volume = null } = this.priceVolumeCache[symbol] || {};
          const cvd = this.cvdMinuteDelta[symbol] || 0;
          const funding = this.latestFundingRates[symbol] ?? null;
          const openInterest = this.latestOpenInterest[symbol] ?? null;
  
          this.events.emit('message:minuteTick', {
            symbol,
            timestamp,
            price,
            volume,
            cvd,
            funding,
            openInterest,
          });
  
          this.cvdMinuteDelta[symbol] = 0;
        }
      }, 60000);
  
      // Every 1m and 3m polling
      setInterval(() => this.fetchOpenInterestLive(), 60000);
      setInterval(() => this.fetchFundingRates(), 180000);
    }, msToNextMinute);
  }

  async fetchInitialFuturesPriceVolume() {
    try {
      const response = await axios.get(`${REST_API_URL}/ticker/24hr`);
      response.data.forEach(ticker => {
        const symbol = ticker.symbol.toUpperCase();
        if (!symbol.includes('USDC') && !symbol.includes('_') && !symbol.includes('ETHBTC')) {
          const price = parseFloat(ticker.lastPrice);
          const volume = parseFloat(ticker.volume);
          this.priceVolumeCache[symbol] = { price, volume };
        }
      });
      logger.info('[Startup] Loaded price/volume snapshot for all futures tokens');
    } catch (err) {
      logger.error('Error fetching futures ticker snapshot:', err.message);
    }
  }

  async fetchFundingRates() {
    try {
      const response = await axios.get(`${REST_API_URL}/fundingRate`, { 
        params: { 
          limit: this.allTokensList.length + 10 
        }
      });

      response.data.forEach((item) => {
        const symbol = item.symbol.toUpperCase();
        this.latestFundingRates[symbol] = parseFloat(item.fundingRate) * 100;
      });

    } catch (err) {
      logger.error(`Funding fetch error: %j`, err.response?.data || err.message);
    }
  }

  async fetchOpenInterestLive() {
    for (const symbol of this.allTokensList) {
      const oi = await this.fetchOpenInterestSingle(symbol);
      if (oi !== null) {
        this.latestOpenInterest[symbol] = oi;
      }
  
      // Delay between requests to avoid burst
      await new Promise(res => setTimeout(res, 100)); // 10 requests/sec
    }
  }

  async fetchOpenInterestSingle(symbol) {
    try {
      const res = await axios.get(`${REST_API_URL}/openInterest`, {
        params: { symbol }
      });
      return parseFloat(res.data.openInterest);
    } catch (err) {
      logger.error(`[OI] Error for ${symbol}: ${err.message}`);
      return null;
    }
  }

  // Listeners and subscriptions to WSS Streams

  async connect(url = null) {
    // 1) TODO: refactor to not reconnect to ALL at the same time if only one connection failed,
    // and to not repeat methods
    // 2) TODO: add pong() method on ping event and send back the same payload we got from ping
    
    // WSS API

    this.wsApi = new WebSocket(WSS_URL_API);

    this.wsApi.on('open', () => {
      logger.info(`Connected to ${WSS_URL_API} WSS API!`);
      this.authenticate();
      clearTimeout(this.reconnectTimer);
      this.getHangingPositionsOnBotStart();
      this.startIntervalsToCollectBinanceData();
    });
    this.wsApi.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.id === 1 && response.status === 200) {
        logger.info(`${this.name} wss API Authentication successful!`);
      } else if (response.error) {
        if (response.error.msg === 'Order does not exist.') {
          return;
        } else if (response.error.msg === 'Margin is insufficient.') {
          return;
        } else if (response.error.msg === "Order's notional must be no smaller than 5 (unless you choose reduce only).") {
          return;
        }
        logger.error(`Received an error message from ${this.name} wss API:`);
        console.log(response);
      } else if (!response.result.bids) { // don't show long orderBook requests with bids/asks
        logger.info('Received message from %s wss API: %j', this.name, response);
      }
    });
    this.wsApi.on('close', () => {
      logger.info(`Disconnected from ${WSS_URL_API}!`);
      if (!this.isForceDisconnectApiWs) {
        this.reconnect(WSS_URL_API);
      }
      this.isForceDisconnectApiWs = false;
    });
    this.wsApi.on('error', (error) => {
      logger.error(`WebSocket error for ${WSS_URL_API}:`);
      console.error(error);
      this.reconnect(WSS_URL_API);
    });

    // WSS User Data Stream

    let listenKey = await this.getListenKey();
    this.wsUserDataStreams = new WebSocket(`${WSS_URL_STREAMS}/${listenKey}`);
    this.keepListenKeyAlive();

    this.wsUserDataStreams.on('open', () => {
      logger.info(`Connected to ${WSS_URL_STREAMS}/listenKey User Data Stream!`);
    });
    this.wsUserDataStreams.on('message', (data) => {
      this.handleUserDataMessages(data);
    }); 
    this.wsUserDataStreams.on('close', () => {
      logger.error('WebSocket connection closed. Reconnecting...');
      if (!this.isForceDisconnectUserDataStreamsWs) {
        this.reconnect(`${WSS_URL_STREAMS}/${listenKey}`);
      }
      this.isForceDisconnectUserDataStreamsWs = false;
    });
    this.wsUserDataStreams.on('error', (error) => {
      logger.error(`WebSocket error:`);
      console.error(error);
      this.reconnect(`${WSS_URL_STREAMS}/${listenKey}`);
    });  
    
    // WSS Market Streams

    this.wsMarketStreams = new WebSocket(WSS_URL_STREAMS);

    this.wsMarketStreams.on('open', () => {
      logger.info(`Connected to ${WSS_URL_STREAMS} Market Streams!`);
      clearTimeout(this.reconnectTimer);
      this.subscribeToFuturesPriceVolume();
      this.subscribeToLiquidations();
    });
    this.wsMarketStreams.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        // === Liquidations ===
        if (message.e === 'forceOrder' && !message.o.s.includes('USDC')) {
          this.events.emit('message:liquidation', message.o);
        }

        else if (message.e === 'aggTrade') {
          const symbol = message.s.toUpperCase();
          const volume = parseFloat(message.q);
          const maker = message.m;

          const delta = maker ? -volume : volume;
          if (!this.cvdMinuteDelta[symbol]) this.cvdMinuteDelta[symbol] = 0;
          this.cvdMinuteDelta[symbol] += delta;
        }

        // === Futures Ticker Updates ===
        else if (Array.isArray(message)) {
          message.forEach((ticker) => {
            if (ticker.e === '24hrTicker' && !ticker.s.includes('_') && !ticker.s.includes('USDC') && !ticker.s.includes('ETHBTC')) {
              const symbol = ticker.s.toUpperCase();
              const price = parseFloat(ticker.c);
              const volume = parseFloat(ticker.v);
              this.priceVolumeCache[symbol] = { price, volume };
            }
          });
        }
        // === Error Handler ===
        else if (message.error) {
          throw new Error(`ERROR: ${message.error}`);
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message:');
        console.error(error);
      }
    });
    this.wsMarketStreams.on('close', () => {
      logger.info(`Disconnected from ${WSS_URL_STREAMS}!`);
      if (!this.isForceDisconnectStreamsWs) {
        this.reconnect(WSS_URL_STREAMS);
      }
      this.isForceDisconnectStreamsWs = false;
    });
    this.wsMarketStreams.on('error', (error) => {
      logger.error(`WebSocket error for ${WSS_URL_STREAMS}:`);
      console.error(error);
      this.reconnect(WSS_URL_STREAMS);
    });
  }

  subscribeToLiquidations() {
    this.wsMarketStreams.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: ['!forceOrder@arr'],
        id: this.generateRequestId(),
      })
    );
  }

  subscribeToFuturesPriceVolume() {
    this.wsMarketStreams.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: ['!ticker@arr'],
        id: this.generateRequestId(),
      })
    );
  }
  
  subscribeToCVD() {
    const streams = this.allTokensList.map(symbol => `${symbol.toLowerCase()}@aggTrade`);
  
    this.wsMarketStreams.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: streams,
        id: this.generateRequestId(),
      })
    );
  }

  async handleUserDataMessages(message) {    
    try {
      const data = JSON.parse(message);

      if (data.e === 'ACCOUNT_UPDATE') {
        const positions = data.a.P; // Positions array from the event

        positions.forEach((position) => {
          const { s: symbol, ps: positionSide, pa: positionAmt, ep: entryPrice, bep: breakevenPrice } = position;
          const amount = parseFloat(positionAmt);

          if (!this.positionsInfo[symbol]) {
            this.positionsInfo[symbol] = {};
          }

          if (amount !== 0) {
            if (!this.positionsInfo[symbol][positionSide]) {
              this.positionsInfo[symbol][positionSide] = {
                positionAmount: 0,
                entryPrice: 0,
                breakevenPrice: 0,
                lastUpdated: Date.now(),
                ordersAmount: 1,
                lastClosingLimitOrderId: null
              };
            } else {
              if (Math.abs(amount) > Math.abs(this.positionsInfo[symbol][positionSide].positionAmount)) {
                this.positionsInfo[symbol][positionSide].ordersAmount += 1;
              } else if (Math.abs(amount) < Math.abs(this.positionsInfo[symbol][positionSide].positionAmount)) {
                this.positionsInfo[symbol][positionSide].ordersAmount = Math.max(
                  1, 
                  this.positionsInfo[symbol][positionSide].ordersAmount - 1 // Decrease, but ensure minimum 1
                );
              }
            }

            this.positionsInfo[symbol][positionSide].positionAmount = amount;
            this.positionsInfo[symbol][positionSide].entryPrice = parseFloat(entryPrice);
            this.positionsInfo[symbol][positionSide].breakevenPrice = parseFloat(breakevenPrice);
            this.positionsInfo[symbol][positionSide].lastUpdated = Date.now();

          } else {
            delete this.positionsInfo[symbol][positionSide];
          }

          if (
            (!this.positionsInfo[symbol]["LONG"] || Object.keys(this.positionsInfo[symbol]["LONG"]).length === 0) &&
            (!this.positionsInfo[symbol]["SHORT"] || Object.keys(this.positionsInfo[symbol]["SHORT"]).length === 0)
          ) {
            delete this.positionsInfo[symbol];
          }
        });

        logger.info('Updated positions: %j', this.positionsInfo);

        await this.updateBalances();
      }
    } catch (error) {
      logger.error(`Error parsing User Data Stream message:`);
      console.error(error);
    }
  }

  async updateBalances() {
    logger.info('Updating Wallet Balance and Available Balance...');
    const { walletBalance, availableBalance } = await this.getAccountBalance();
    this.accountInfo.walletBalance = roundDownToTwoDecimals(walletBalance);
    this.accountInfo.availableBalance = roundDownToTwoDecimals(availableBalance);
  }

  // Communication via WSS API

  async sendOrder(order) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();

    const message = {
      id: requestId,
      method: 'order.place',
      params: { ...order, timestamp }
    };

    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', handleResponse);
            resolve({
              orderId: response.result.orderId,
              status: response.result.status,
              avgPrice: response.result.avgPrice,
              executedQty: response.result.executedQty
            });
          }
        } catch (error) {
          logger.error(`Error parsing Binance getOrder response:`);
          console.error(error);
          reject(error);
        }
      };

      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async getOrder(orderId, symbol) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();

    const message = {
      id: requestId,
      method: 'order.status',
      params: { orderId, symbol, timestamp }
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', handleResponse);
            resolve(response.result);
          }
        } catch (error) {
          logger.error(`Error parsing Binance getOrder response:`);
          console.error(error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async cancelOrder(orderId, symbol) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();

    const message = {
      id: requestId,
      method: 'order.cancel',
      params: { orderId, symbol, timestamp }
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', handleResponse);
            resolve(response.result);
          }
        } catch (error) {
          logger.error(`Error parsing Binance getOrder response:`);
          console.error(error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async getAccountBalance() {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();

    const message = {
      id: requestId,
      method: 'v2/account.balance',
      params: { timestamp }
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', handleResponse);
            const usdtAccount = response.result.find(item => item.asset === 'USDT');
            resolve({
              walletBalance: usdtAccount.balance,
              availableBalance: usdtAccount.availableBalance
            });
          }
        } catch (error) {
          logger.error(`Error parsing Binance getOrder response:`);
          console.error(error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async getHangingPositionsOnBotStart() {    
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();

    const message = {
      id: requestId,
      method: 'v2/account.position',
      params: { timestamp }
    };

    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', handleResponse);

            response.result.forEach(position => {
              const { symbol, positionSide, positionAmt, entryPrice, breakEvenPrice } = position;

              this.positionsInfo[symbol] = {};

              this.positionsInfo[symbol][positionSide] = {
                positionAmount: parseFloat(positionAmt),
                entryPrice: parseFloat(entryPrice),
                breakevenPrice: parseFloat(breakEvenPrice),
                lastUpdated: Date.now(),
                ordersAmount: config.current.sameSymbolOrdersLimit, // do not allow new trades for the token while we have stuck old position here
                stuckOldPosition: true
              };
            });

            logger.info('Updated positions: %j', this.positionsInfo);
            resolve();
          }
        } catch (error) {
          logger.error(`Error parsing Binance getHangingPositionsOnBotStart response:`);
          console.error(error);
          reject(error);
        }
      };

      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async getSymbolLastPrice(symbol) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();
    const message = {
      id: requestId,
      method: 'ticker.price',
      params: {
        symbol: symbol.toUpperCase(),
        timestamp
      }
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
  
          if (response.id === requestId && response.result) {
            const lastPrice = parseFloat(response.result.price);

            this.wsApi.removeListener('message', handleResponse);
            resolve(lastPrice);
          }
        } catch (error) {
          logger.error(`Error parsing Binance ticker price response:`);
          console.error(error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async getOrderBookSupportResistance(symbol, orderBookMinimalDepth, currentPrice) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();
    const message = {
      id: requestId,
      method: 'depth',
      params: {
        symbol: symbol.toUpperCase(),
        limit: orderBookMinimalDepth,
        timestamp
      }
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
  
          if (response.id === requestId && response.result) {
            const { bids, asks } = response.result;
  
            const bidOrders = bids.map(([price, volume]) => ({
              price: parseFloat(price),
              volume: parseFloat(volume)
            }));
  
            const askOrders = asks.map(([price, volume]) => ({
              price: parseFloat(price),
              volume: parseFloat(volume)
            }));
  
            const supportResistanceLevels = this.calculateSupportResistance(bidOrders, askOrders, currentPrice);
  
            this.wsApi.removeListener('message', handleResponse);
            resolve(supportResistanceLevels);
          }
        } catch (error) {
          logger.error(`Error parsing Binance order book response:`);
          console.error(error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }    

  // Helper methods

  calculateSupportResistance(bidOrders, askOrders, currentPrice) {
    if (!bidOrders.length || !askOrders.length) return { supportLvl: null, resistanceLvl: null };
  
    const averageAskSize = askOrders.reduce((sum, order) => sum + order.volume, 0) / askOrders.length;
    const averageBidSize = bidOrders.reduce((sum, order) => sum + order.volume, 0) / bidOrders.length;
  
    const largeAskOrders = askOrders.filter(order => order.volume >= averageAskSize * config.current.multiplierToDetectHugeOrdersVolumeFromAvg);
    const largeBidOrders = bidOrders.filter(order => order.volume >= averageBidSize * config.current.multiplierToDetectHugeOrdersVolumeFromAvg);

    const resistanceLvl = largeAskOrders.length ? largeAskOrders[0].price : null;
    const supportLvl = largeBidOrders.length ? largeBidOrders[0].price : null;

    const distanceToResistance = (Math.abs(resistanceLvl - currentPrice)/currentPrice) * 100;
    const distanceToSupport = (Math.abs(supportLvl - currentPrice)/currentPrice) * 100;
  
    return { distanceToResistance, distanceToSupport };
  }

  getCandleDuration(openTime) {
    const currentTime = this.getTimestamp();
    const durationMs = currentTime - openTime;

    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    // Format output as 'H:MM:SS' (avoiding leading zero in hours)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  generateRequestId() {
    return `binance-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  getTimestamp() {
    return Date.now();
  }

  reconnect(url) {
    logger.info(`Attempting to reconnect to ${url} in ${this.reconnectInterval}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect(url);
    }, this.reconnectInterval);
  }

  disconnect() {
    logger.info(`Disconnecting WebSocket for ${WSS_URL_STREAMS}:`);
    if (this.wsMarketStreams) {
      this.isForceDisconnectStreamsWs = true;
      this.wsMarketStreams.close();
    }
    logger.info(`Disconnecting WebSocket for ${WSS_URL_API}:`);
    if (this.wsApi) {
      this.isForceDisconnectApiWs = true;
      this.wsApi.close();
    }
    logger.info(`Disconnecting WebSocket for User Data Streams ${WSS_URL_STREAMS}/listenKey:`);
    if (this.wsUserDataStreams) {
      this.this.isForceDisconnectUserDataStreamsWs = true;
      this.wsUserDataStreams.close();
    }
  }

  updateAllTokensList(allTokensList) {
    this.allTokensList = allTokensList;
  }
}

export default BinanceWssRestApi;