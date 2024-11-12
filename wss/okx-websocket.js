// okx-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';

class OKXWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey, passphrase) {
    const url = 'wss://ws.okx.com:8443/ws/v5/business';
    super(url);
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('Connected to OKX WebSocket');
      this.authenticate();
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.event === 'liquidation') {
        const { instrument_id, side, price, size } = message.data[0];
        // Pass the liquidation data to the Trading Logic Module
      }
    });

    this.ws.on('close', () => {
      console.log('Disconnected from OKX WebSocket');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      console.error('OKX WebSocket error:', error);
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

  async send(order) {
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

  // Is NOT used right now since we send market order with sz and don't need to know a current price
  async fetchTicker(symbol) {
    return new Promise((resolve, reject) => {
      const tickerChannel = `tickers.${symbol}`;
      const tickerHandler = (message) => {
        if (message.channel === tickerChannel) {
          this.ws.removeListener('message', tickerHandler);
          resolve({
            last: parseFloat(message.data[0].last),
          });
        }
      };

      this.ws.on('message', tickerHandler);
      this.ws.send(JSON.stringify({
        op: 'subscribe',
        args: [tickerChannel],
      }));
    });
  }
}

export default OKXWebSocket;