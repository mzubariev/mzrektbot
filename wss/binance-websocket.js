// binance-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';

class BinanceWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey) {
    super('wss://fstream.binance.com/ws');
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  connect() {
    const timestamp = Date.now();
    const signature = this.generateSignature(timestamp);
    const url = `${this.url}/${this.apiKey}/${timestamp}/${signature}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('Connected to Binance WebSocket');
      this.isConnected = true;
      clearTimeout(this.reconnectTimer);
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {      
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

    this.ws.on('close', () => {
      logger.info('Disconnected from Binance WebSocket');
      this.reconnect();
    });
      
    this.ws.on('error', (error) => {
      logger.error('Binance WebSocket error:', error);
      this.reconnect();
    });
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: ['!forceOrder@arr'],
      id: 1,
    };
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  generateSignature(timestamp) {
    const message = `timestamp=${timestamp}`;
    return crypto.createHmac('sha256', this.secretKey).update(message).digest('hex');
  }

  generateRequestId() {
    return `binance-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
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
            this.ws.removeListener('message', handleResponse);
            resolve(response.result);
          }
        } catch (error) {
          logger.error('Error parsing Binance getOrder response: %j', error);
          reject(error);
        }
      };
  
      this.ws.on('message', handleResponse);
      this.ws.send(JSON.stringify(message));
    });
  }  

  async send(order) {
    const requestId = this.generateRequestId();
    const message = {
      method: 'ORDER',
      params: { order },
      id: requestId
    };

    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        logger.info('RESPONSE');
        logger.info(data);
        try {
          const response = JSON.parse(data);
          logger.info(data);
          if (response.id === requestId && response.result) {
            this.ws.removeListener('message', orderHandler);
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

      this.ws.on('message', handleResponse);
      this.ws.send(JSON.stringify(message));
    });
  }
}

export default BinanceWebSocket;