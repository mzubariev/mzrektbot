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
      this.subscribeToLiquidations();
      logger.info('WARNING 2: Re-connect from inside of BINANCE WS wrapper!!!!');
    });

    this.ws.on('message', (data) => {      
      try {
        const message = JSON.parse(data);
        if (message.e === 'forceOrder') {
          // { s: symbol, o: orderType, q: quantity, p: price } = message.o;
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

  async send(order) {
    const requestId = this.generateRequestId();
    return new Promise((resolve, reject) => {
      const orderHandler = (message) => {
        if (message.id === requestId && message.result) {
          this.ws.removeListener('message', orderHandler);
          resolve({
            orderId: message.result.orderId,
            status: message.result.status,
            avgPrice: message.result.avgPrice,
            executedQty: message.result.executedQty
          });
        }
      };

      this.ws.on('message', orderHandler);
      this.ws.send(JSON.stringify({
        method: 'ORDER',
        params: order,
        id: requestId,
      }));
    });
  }
}

export default BinanceWebSocket;