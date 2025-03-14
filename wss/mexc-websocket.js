// mexc-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';

class MEXCWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey) {
    super('wss://contract.mexc.com/ws');
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
        if (message.channel === 'push.liquidation') {
          const { symbol, side, price, vol } = message.data;
          this.events.emit('message', { s: symbol, S: side, q: vol, ap: price });
        }
      } catch (error) {
        logger.error(`Error parsing Binance WebSocket message: ${JSON.stringify(error, null, 2)}`);
      }
    });
  }

  authenticate() {
    const timestamp = Date.now();
    const signature = crypto.createHmac('sha256', this.secretKey)
      .update(`${timestamp}GET/users/self/verify`)
      .digest('hex');
    const authMessage = {
      method: 'LOGIN',
      param: {
        apiKey: this.apiKey,
        reqTime: timestamp,
        signature: signature
      }
    };
    this.ws.send(JSON.stringify(authMessage));
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      method: 'SUBSCRIPTION',
      params: ['liquidation']
    };
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  async getOrder(orderId) {
    const message = {
      method: 'GET_ORDER',
      params: { orderId },
    };
  
    return new Promise((resolve, reject) => {
      const handleResponse = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.method === 'GET_ORDER' && response.params.orderId === orderId) {
            this.ws.removeListener('message', handleResponse);
            resolve(response.data); // Ensure data contains fields like 'status'
          }
        } catch (error) {
          logger.error(`Error parsing MEXC getOrder response: ${JSON.stringify(error, null, 2)}`);
          reject(error);
        }
      };
  
      this.ws.on('message', handleResponse);
      this.ws.send(JSON.stringify(message));
    });
  }
  
  async sendOrder(order) {
    return new Promise((resolve, reject) => {
      const orderMessage = {
        method: 'ORDER',
        params: order
      };
      
      this.ws.send(JSON.stringify(orderMessage), (error) => {
        if (error) {
          logger.error(`Error sending order to MEXC: ${JSON.stringify(error, null, 2)}`);
          reject(error);
        }
      });

      const orderHandler = (message) => {
        try {
          const data = JSON.parse(message);
          if (data.method === 'ORDER' && data.code === 0) {
            this.ws.removeListener('message', orderHandler);
            resolve({
              orderId: data.data.orderId,
              status: data.data.status,
              avgPrice: data.data.avgPrice,
              executedQty: data.data.executedQty
            });
          } else if (data.method === 'ORDER' && data.code !== 0) {
            logger.error(`MEXC order error: ${JSON.stringify(data, null, 2)}`);
            reject(new Error(`MEXC order error: ${JSON.stringify(data.message, null, 2)}`));
          }
        } catch (error) {
          logger.error(`Error processing MEXC order response: ${JSON.stringify(error, null, 2)}`);
        }
      };

      this.ws.on('message', orderHandler);
    });
  }
}

export default MEXCWebSocket;