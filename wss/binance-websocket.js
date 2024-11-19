// binance-websocket.js
import WebSocketWrapper from './websocket-wrapper.js';
import logger from '../utils/logger.js';
import nacl from 'tweetnacl';
import base64 from 'base64-js';

class BinanceWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKeyRaw) {
    super('wss://fstream.binance.com/ws', 'wss://ws-fapi.binance.com/ws-fapi/v1');
    this.apiKey = apiKey;
    // Extract the raw private key (32 bytes for Ed25519 seed)
    this.secretKeyRaw = base64.toByteArray(secretKeyRaw).slice(-32);
  }

  // Listeners and subscriptions to WSS Streams

  connect() {
    super.connect();

    this.wsStreams.on('open', () => {
      this.subscribeToLiquidations();
    });

    this.wsStreams.on('message', (data) => {      
      try {
        const message = JSON.parse(data);
        if (message.e === 'forceOrder') {
          // { s: symbol, S: orderSide, q: quantity, ap: price } = message.o;
          this.events.emit('message', message.o); // Forward the message
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message:', error);
      }
    });
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: ['!forceOrder@arr'],
      id: 1,
    };
    this.wsStreams.send(JSON.stringify(subscribeMessage));
  }

  // Main methods to communicate via WSS API

  async sendOrder(order) {
    const timestamp = this.getTimestamp();
    const requestId = this.generateRequestId();

    const message = {
      id: requestId,
      method: 'order.place',
      params: { ...order, timestamp: timestamp }
    };

    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        logger.info('RESPONSE:');
        try {
          const response = JSON.parse(data);
          logger.info(data);
          if (response.id === requestId && response.result) {
            this.wsApi.removeListener('message', orderHandler);
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

  async getOrder(orderId) {
    const message = {
      method: 'GET_ORDER',
      params: { orderId: orderId },
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.id === orderId) {
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

  authenticate() {
    const timestamp = this.getTimestamp();
    const signature = this.generateSignature(timestamp);

    const authMessage = {
        id: 1, // Unique identifier for the request
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
    const keyPair = nacl.sign.keyPair.fromSeed(this.secretKeyRaw);
    const payload = `apiKey=${this.apiKey}&timestamp=${timestamp}`;
    const payloadUint8 = new TextEncoder().encode(payload);
    const signature = nacl.sign.detached(payloadUint8, keyPair.secretKey);
    return base64.fromByteArray(signature); // Encode signature in Base64
  }

  generateRequestId() {
    return `binance-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  getTimestamp() {
    return Date.now();
  }
}

export default BinanceWebSocket;