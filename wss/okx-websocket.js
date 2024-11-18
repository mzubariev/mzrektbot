// okx-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';

class OKXWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey, passphrase) {
    super('wss://ws.okx.com:8443/ws/v5/business');
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      logger.info('Connected to OKX WebSocket');
      this.isConnected = true;
      this.authenticate();
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.event === 'liquidation') {
          const { instrument_id, side, price, size } = message.data[0];
          this.events.emit('message', { s: instrument_id, S: side, q: size, ap: price }); // Forward the message
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message:', error);
      }
    });

    this.ws.on('close', () => {
      logger.info('Disconnected from OKX WebSocket');
      this.reconnect();
    });
      
    this.ws.on('error', (error) => {
      logger.error('OKX WebSocket error:', error);
      this.reconnect();
    });
  }

  authenticate() {
    const timestamp = Date.now() / 1000;
    const signature = crypto.createHmac('sha256', this.secretKey)
      .update(`${timestamp}GET/users/self/verify`)
      .digest('base64');
    const authMessage = {
      op: 'login',
      args: [
        {
          apiKey: this.apiKey,
          passphrase: this.passphrase,
          timestamp: timestamp.toString(),
          sign: signature,
        },
      ],
    };
    this.ws.send(JSON.stringify(authMessage));
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      op: 'subscribe',
      args: [
        {
          channel: 'liquidation-warning',
          instType: 'SWAP',
        },
      ],
    };
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  generateRequestId() {
    return `okx-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  async getOrder(orderId) {
    const message = {
      op: 'orderDetails',
      args: [{ orderId }],
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.op === 'orderDetails' && response.args[0].orderId === orderId) {
            this.ws.removeListener('message', handleResponse);
            resolve(response.data[0]); // Ensure data contains fields like `status`
          }
        } catch (error) {
          logger.error('Error parsing OKX getOrder response:', error);
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
        if (message.id === requestId && message.data) {
          this.ws.removeListener('message', orderHandler);
          resolve({
            orderId: message.data[0].ordId,
            status: message.data[0].state,
            avgPrice: message.data[0].avgPx,
            executedQty: message.result.executedQty
          });
        }
      };

      this.ws.on('message', orderHandler);
      this.ws.send(JSON.stringify({
        op: 'order',
        args: [
          {
            ...order,
            clOrdId: requestId,
          },
        ],
        id: requestId,
      }));
    });
  }
}

export default OKXWebSocket;