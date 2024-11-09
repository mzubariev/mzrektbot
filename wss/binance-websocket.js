// binance-websocket.js
import WebSocket from 'ws';
import WebSocketWrapper from './websocket-wrapper.js';
import crypto from 'crypto';

class BinanceWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey, isTestnet) {
    const url = isTestnet ? 
    'wss://testnet.binance.vision/ws' : 
    'wss://fstream.binance.com/ws';
    super(url);
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  connect() {
    const timestamp = Date.now();
    const signature = this.generateSignature(timestamp);
    const url = `${this.url}/${this.apiKey}/${timestamp}/${signature}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('Connected to Binance WebSocket');
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.e === 'forceOrder') {
        const { s: symbol, o: orderType, q: quantity, p: price } = message;
        console.log(`Liquidation: ${symbol}, ${orderType}, ${quantity}, ${price}`);
        // Pass the liquidation data to the Trading Logic Module
      }
    });

    this.ws.on('close', () => {
      console.log('Disconnected from Binance WebSocket');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      console.error('Binance WebSocket error:', error);
      this.reconnect();
    });
  }

  generateSignature(timestamp) {
    const message = `timestamp=${timestamp}`;
    return crypto.createHmac('sha256', this.secretKey).update(message).digest('hex');
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: ['!forceOrder@arr'],
      id: 1,
    };
    this.ws.send(JSON.stringify(subscribeMessage));
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

  async fetchTicker(symbol) {
    return new Promise((resolve, reject) => {
      const tickerChannel = `${symbol.toLowerCase()}@ticker`;
      const tickerHandler = (ticker) => {
        this.ws.removeListener('message', tickerHandler);
        resolve({ last: parseFloat(ticker.c) });
      };

      this.ws.on('message', tickerHandler);
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: [tickerChannel],
        id: this.generateRequestId(),
      }));
    });
  }
}

export default BinanceWebSocket;