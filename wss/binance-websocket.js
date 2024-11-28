// binance-websocket.js
import WebSocketWrapper from './websocket-wrapper.js';
import logger from '../utils/logger.js';
import nacl from 'tweetnacl';
import base64 from 'base64-js';

class BinanceWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKeyRaw) {
    super({ 
      urlStreams: 'wss://fstream.binance.com/ws',
      urlApi: 'wss://ws-fapi.binance.com/ws-fapi/v1'
     });
    this.apiKey = apiKey;
    this.secretKeyRaw = secretKeyRaw;
    this.name = 'Binance';
    this.tickerPrices = {};
  }

  // Authentication

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

  // Listeners and subscriptions to WSS Streams

  connect() {
    super.connect();

    this.wsStreams.on('open', () => {
      this.subscribeToAllTickers();
      this.subscribeToLiquidations();
    });

    this.wsStreams.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        if (Array.isArray(message) && message[0].e === '24hrTicker' && !message[0].s.includes('USDC')) {
          this.handleAllTickerUpdates(message);
        } else if (message.e === 'forceOrder' && !message.o.s.includes('USDC')) {
          // { s: symbol, S: orderSide, q: quantity, ap: price } = message.o;
          this.events.emit('message', message.o);
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message: %j', error);
      }
    });
  }

  subscribeToLiquidations() {
    this.wsStreams.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: ['!forceOrder@arr'],
        id: this.generateRequestId(),
      })
    );
  }

  subscribeToAllTickers() {
    this.wsStreams.send(
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
      const lastPrice = parseFloat(ticker.c);
      this.tickerPrices[symbol] = lastPrice;
    });
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

  // Helper methods

  generateRequestId() {
    return `binance-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  getTimestamp() {
    return Date.now();
  }
}

export default BinanceWebSocket;