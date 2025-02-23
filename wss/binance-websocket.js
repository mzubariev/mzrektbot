// binance-websocket.js
import WebSocketWrapper from './websocket-wrapper.js';
import logger from '../utils/logger.js';
import nacl from 'tweetnacl';
import base64 from 'base64-js';
import axios from 'axios';
import config from '../utils/configuration.js';
import { roundDownToTwoDecimals } from '../utils/helpers.js';

const REST_API_URL = 'https://fapi.binance.com/fapi/v1';
const KLINE_INTERVAL = '4h';
const ORDERBOOK_DEPTH = 100;
const MULTIPLIER_TO_DETECT_HUGE_ORDERS_VOLUME_FROM_AVG = 3;

class BinanceWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKeyRaw) {
    super({ 
      urlStreams: 'wss://fstream.binance.com/ws',
      urlApi: 'wss://ws-fapi.binance.com/ws-fapi/v1'
     });
    this.name = 'Binance';
    this.apiKey = apiKey;
    this.secretKeyRaw = secretKeyRaw;
    this.accountInfo = {
      walletBalance: config.current.depositSize,
      availableBalance: config.current.depositSize
    };
    this.positionsInfo = {};
    this.tickerPrices = {};
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

    this.wsApi.send(JSON.stringify(authMessage));
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
      logger.error('Error fetching listenKey: %j', error.message);
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
        logger.error('Error keeping listenKey alive: %j', error.message);
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }

  async getTokenCandleTrend(symbol) {
    logger.info(`Checking the current ${KLINE_INTERVAL} candle trend for ${symbol}...`);
    try {
      const response = await axios.get(`${REST_API_URL}/klines`, {
        params: {
          symbol: symbol.toUpperCase(),
          interval: KLINE_INTERVAL,
          limit: 1, // Fetch only the latest interval candle
        },
      });
  
      if (response.data.length === 0) {
        logger.error(`No data available for ${symbol}`);
        return;
      }
  
      const [candleOpenTime, open, high, low, close, volume, candleCloseTime] = response.data[0]; // Extract OHLC values
  
      const candleTrend = parseFloat(close) > parseFloat(open) ? 'BUY' : 'SELL';
      logger.info(`${symbol} | ${KLINE_INTERVAL} Candle Trend: ${candleTrend} | Open: ${open}, Close: ${close} | Volume: ${volume}`);

      return { candleTrend, candleOpenTime, candleCloseTime, volume };
    } catch (error) {
      logger.error(`Error fetching ${KLINE_INTERVAL} Kline for ${symbol}: %j`, error.response?.data || error.message);
    }
  }

  // Listeners and subscriptions to WSS Streams

  async connect() {
    this.listenKey = await this.getListenKey();
    super.connect();
    this.keepListenKeyAlive();

    this.wsMarketStreams.on('open', () => {
      this.subscribeToAllTickers();
      this.subscribeToLiquidations();
    });

    this.wsMarketStreams.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        if (Array.isArray(message) && message[0].e === '24hrTicker') {
          this.handleAllTickerUpdates(message);
        } else if (message.e === 'forceOrder' && !message.o.s.includes('USDC')) {
          // { s: symbol, S: orderSide, q: quantity, ap: price } = message.o;
          this.events.emit('message', message.o);
        } else if (message.error) {
          throw new Error(`ERROR: %j`, message.error);
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message: %j', error);
      }
    });

    this.wsUserDataStreams.on('message', (data) => {
      this.handleUserDataMessages(data);
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

  // Or maybe per ticker(s) from MarketData request -> ticker.price ?
  subscribeToAllTickers() {
    this.wsMarketStreams.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: ['!ticker@arr'],
        id: this.generateRequestId(),
      })
    );
  }

  handleAllTickerUpdates(tickerArray) {
    tickerArray.forEach((ticker) => {
      const symbol = ticker.s;
      if (!symbol.includes('USDC')) {
        const lastPrice = parseFloat(ticker.c);
        this.tickerPrices[symbol] = lastPrice;
      }
    });
  }

  async handleUserDataMessages(message) {    
    try {
      const data = JSON.parse(message);

      if (data.e === 'ACCOUNT_UPDATE') {
        const positions = data.a.P; // Positions array from the event

        positions.forEach((position) => {
          const { s: symbol, ps: positionSide, pa: positionAmt, ep: entryPrice, bep: breakevenPrice } = position;

          if (!this.positionsInfo[symbol]) {
            this.positionsInfo[symbol] = {};
          }

          if (parseFloat(positionAmt) !== 0) {
            this.positionsInfo[symbol][positionSide] = {
              positionAmount: parseFloat(positionAmt),
              entryPrice: parseFloat(entryPrice),
              breakevenPrice: parseFloat(breakevenPrice),
              lastUpdated: Date.now(),
              ordersAmount: this.positionsInfo[symbol][positionSide] ? this.positionsInfo[symbol][positionSide].ordersAmount + 1 : 1
            };
          } else {
            delete this.positionsInfo[symbol][positionSide];
          }
        });

        logger.info('Updated positions: %j', this.positionsInfo);

        await this.updateBalances();
      }
    } catch (error) {
      logger.error('Error parsing User Data Stream message: %j', error);
    }
  }

  async updateBalances() {
    logger.warn('Updating Wallet Balance and Available Balance...');
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
          logger.error('Error parsing Binance getOrder response: %j', error);
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
          logger.error('Error parsing Binance getOrder response: %j', error);
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
          logger.error('Error parsing Binance getOrder response: %j', error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }

  async getOrderBookSupportResistance(symbol) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();
    const message = {
      id: requestId,
      method: 'depth',
      params: { symbol, limit: ORDERBOOK_DEPTH, timestamp }
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', handleResponse);

            const { b, a } = response.result; // Bids & Asks
  
            const bidOrders = b.map(([price, volume]) => ({
              price: parseFloat(price),
              volume: parseFloat(volume),
            }));
  
            const askOrders = a.map(([price, volume]) => ({
              price: parseFloat(price),
              volume: parseFloat(volume),
            }));
  
            const supportResistanceLevels = this.calculateSupportResistance(bidOrders, askOrders);
            resolve(supportResistanceLevels);
          }
        } catch (error) {
          logger.error('Error parsing Binance order book response: %j', error);
          reject(error);
        }
      };
  
      this.wsApi.on('message', handleResponse);
      this.wsApi.send(JSON.stringify(message));
    });
  }  

  // Helper methods

  calculateSupportResistance(bidOrders, askOrders) {
    if (!bidOrders.length || !askOrders.length) return { supportLvl: null, resistanceLvl: null };
  
    const averageBidSize = bidOrders.reduce((sum, order) => sum + order.volume, 0) / bidOrders.length;
    const averageAskSize = askOrders.reduce((sum, order) => sum + order.volume, 0) / askOrders.length;
  
    const largeBidOrders = bidOrders.filter(order => order.volume >= averageBidSize * MULTIPLIER_TO_DETECT_HUGE_ORDERS_VOLUME_FROM_AVG);
    const largeAskOrders = askOrders.filter(order => order.volume >= averageAskSize * MULTIPLIER_TO_DETECT_HUGE_ORDERS_VOLUME_FROM_AVG);
  
    return {
      supportLvl: largeBidOrders.length ? largeBidOrders[0].price : null,
      resistanceLvl: largeAskOrders.length ? largeAskOrders[0].price : null,
    };
  }  

  generateRequestId() {
    return `binance-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  getTimestamp() {
    return Date.now();
  }
}

export default BinanceWebSocket;