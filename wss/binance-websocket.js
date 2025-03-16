// binance-websocket.js
import WebSocketWrapper from './websocket-wrapper.js';
import logger from '../utils/logger.js';
import nacl from 'tweetnacl';
import base64 from 'base64-js';
import axios from 'axios';
import config from '../utils/configuration.js';
import { roundDownToTwoDecimals } from '../utils/helpers.js';

const REST_API_URL = 'https://fapi.binance.com/fapi/v1';

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

  // Listeners and subscriptions to WSS Streams

  async connect() {
    this.listenKey = await this.getListenKey();
    super.connect();
    this.keepListenKeyAlive();
    
    this.wsApi.on('open', () => {
      this.authenticate();
      this.getHangingPositionsOnBotStart();
    });

    this.wsMarketStreams.on('open', () => {
      this.subscribeToLiquidations();
    });

    this.wsMarketStreams.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        if (message.e === 'forceOrder' && !message.o.s.includes('USDC')) {
          // { s: symbol, S: orderSide, q: quantity, ap: price } = message.o;
          this.events.emit('message', message.o);
        } else if (message.error) {
          throw new Error(`ERROR: ${message.error}`);
        }
      } catch (error) {
        logger.error(`Error parsing Binance WebSocket message:`);
        console.error(error);
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
                ordersAmount: 1
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
                ordersAmount: 0, // allow to get more separate trades for this token and don't touch the old stuck ones
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
}

export default BinanceWebSocket;