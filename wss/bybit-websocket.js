// bybit-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';

class BybitWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey) {
    const url = 'wss://stream.bybit.com/realtime';
    const testnetUrl = 'wss://stream-testnet.bybit.com/realtime';
    super(url);
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('Connected to Bybit WebSocket');
      this.authenticate();
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.topic === 'liquidation') {
        const { symbol, side, price, qty } = message.data;
        console.log(`Liquidation: ${symbol}, ${side}, ${price}, ${qty}`);
        // Pass the liquidation data to the Trading Logic Module
      }
    });

    this.ws.on('close', () => {
      console.log('Disconnected from Bybit WebSocket');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      console.error('Bybit WebSocket error:', error);
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

  // Is NOT used right now since we send market order with orderQty and don't need to know a current price
  async fetchTicker(symbol) {
    return new Promise((resolve, reject) => {
      const tickerTopic = `tickers.${symbol}`;
      const tickerHandler = (message) => {
        if (message.topic === tickerTopic) {
          this.ws.removeListener('message', tickerHandler);
          resolve({ last: parseFloat(message.data.last_price) });
        }
      };

      this.ws.on('message', tickerHandler);
      this.ws.send(JSON.stringify({
        op: 'subscribe',
        args: [tickerTopic],
      }));
    });
  }
}

export default BybitWebSocket;