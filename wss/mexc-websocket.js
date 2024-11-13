// mexc-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import logger from '../utils/logger.js';

class MEXCWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey) {
    super('wss://contract.mexc.com/ws');
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      logger.info('Connected to MEXC WebSocket');
      this.authenticate();
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.channel === 'push.liquidation') {
          const { symbol, side, price, vol } = message.data;
          this.events.emit('message', { s: symbol, o: side, q: vol, p: price }); // Forward the message
        }
      } catch (error) {
        logger.error('Error parsing Binance WebSocket message:', error);
      }
    });

    this.ws.on('close', () => {
      logger.warn('Disconnected from MEXC WebSocket');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      logger.error('MEXC WebSocket error:', error);
      this.reconnect();
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

  async send(order) {
    return new Promise((resolve, reject) => {
      const orderMessage = {
        method: 'ORDER',
        params: order
      };
      
      this.ws.send(JSON.stringify(orderMessage), (error) => {
        if (error) {
          logger.error('Error sending order to MEXC:', error);
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
            logger.error('MEXC order error:', data);
            reject(new Error(`MEXC order error: ${data.message}`));
          }
        } catch (error) {
          logger.error('Error processing MEXC order response:', error);
        }
      };

      this.ws.on('message', orderHandler);
    });
  }
}

export default MEXCWebSocket;