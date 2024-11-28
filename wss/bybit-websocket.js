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
    super.connect();

    this.ws.on('open', () => {
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.topic === 'liquidation') {
          const { symbol, side, price, qty } = message.data;
          this.events.emit('message', { s: symbol, S: side, q: qty, ap: price });
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message: %j', error);
      }
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

  async getOrder(orderId) {
    const message = {
      op: 'order',
      args: { orderId },
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.request && response.request.op === 'order' && response.request.args.orderId === orderId) {
            this.ws.removeListener('message', handleResponse);
            resolve(response.result); // Ensure result contains fields like 'status'
          }
        } catch (error) {
          logger.error('Error parsing Bybit getOrder response: %j', error);
          reject(error);
        }
      };
  
      this.ws.on('message', handleResponse);
      this.ws.send(JSON.stringify(message));
    });
  }  

  async sendOrder(order) {
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