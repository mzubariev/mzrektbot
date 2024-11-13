// bybit-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';

class BybitWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey) {
    super('wss://stream.bybit.com/realtime');
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      logger.info('Connected to Bybit WebSocket');
      this.authenticate();
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.topic === 'liquidation') {
          const { symbol, side, price, qty } = message.data;
          this.events.emit('message', { s: symbol, o: side, q: qty, p: price }); // Forward the message
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message:', error);
      }
    });

    this.ws.on('close', () => {
      logger.info('Disconnected from Bybit WebSocket');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      logger.error('Bybit WebSocket error:', error);
      this.reconnect();
    });
  }

  authenticate() {
    const expires = Date.now() + 5000;
    const signature = crypto.createHmac('sha256', this.secretKey).update(`GET/realtime${expires}`).digest('hex');
    const authMessage = {
      op: 'auth',
      args: [this.apiKey, expires.toString(), signature],
    };
    this.ws.send(JSON.stringify(authMessage));
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      op: 'subscribe',
      args: ['liquidation'],
    };
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  generateRequestId() {
    return `bybit-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  async send(order) {
    const requestId = this.generateRequestId();
    return new Promise((resolve, reject) => {
      const orderHandler = (message) => {
        if (message.request && message.request.op === 'order' && message.request.args.order_link_id === requestId) {
          this.ws.removeListener('message', orderHandler);
          resolve({
            orderId: message.result.order_id,
            status: message.result.order_status,
            avgPrice: message.result.last_exec_price,
            executedQty: message.result.executedQty
          });
        }
      };

      this.ws.on('message', orderHandler);
      this.ws.send(JSON.stringify({
        op: 'order',
        args: {
          ...order,
          order_link_id: requestId,
        },
      }));
    });
  }
}

export default BybitWebSocket;