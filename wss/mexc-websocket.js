const WebSocketWrapper = require('./websocket-wrapper');
const crypto = require('crypto');

class MEXCWebSocket extends WebSocketWrapper {
  constructor(apiKey, secretKey) {
    const url = 'wss://contract.mexc.com/ws';
    super(url);
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('Connected to MEXC WebSocket');
      this.authenticate();
      this.subscribeToLiquidations();
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.channel === 'push.liquidation') {
        const { symbol, side, price, quantity } = message.data;
        console.log(`Liquidation: ${symbol}, ${side}, ${price}, ${quantity}`);
        // Pass the liquidation data to the Trading Logic Module
      }
    });

    this.ws.on('close', () => {
      console.log('Disconnected from MEXC WebSocket');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      console.error('MEXC WebSocket error:', error);
      this.reconnect();
    });
  }

  authenticate() {
    const timestamp = Date.now();
    const signature = crypto.createHmac('sha256', this.secretKey)
      .update(`api_key=${this.apiKey}&timestamp=${timestamp}`)
      .digest('hex');
    const authMessage = {
      method: 'login',
      params: [this.apiKey, timestamp.toString(), signature],
      id: 1,
    };
    this.ws.send(JSON.stringify(authMessage));
  }

  subscribeToLiquidations() {
    const subscribeMessage = {
      method: 'SUBSCRIPTION',
      params: ['liquidation'],
      id: 2,
    };
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  generateRequestId() {
    return `mexc-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  async send(order) {
    const requestId = this.generateRequestId();
    return new Promise((resolve, reject) => {
      const orderHandler = (message) => {
        if (message.id === requestId && message.code === 0) {
          this.ws.removeListener('message', orderHandler);
          resolve({
            orderId: message.data.order_id,
            status: message.data.state,
            avgPrice: message.data.price,
            executedQty: message.result.executedQty
          });
        }
      };

      this.ws.on('message', orderHandler);
      this.ws.send(JSON.stringify({
        method: 'ORDER',
        params: [
          {
            ...order,
            client_order_id: requestId,
          },
        ],
        id: requestId,
      }));
    });
  }

  async fetchTicker(symbol) {
    return new Promise((resolve, reject) => {
      const tickerChannel = `spot@public.ticker.${symbol}`;
      const tickerHandler = (message) => {
        if (message.channel === tickerChannel) {
          this.ws.removeListener('message', tickerHandler);
          resolve({
            last: parseFloat(message.data.last),
          });
        }
      };

      this.ws.on('message', tickerHandler);
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: [tickerChannel],
        id: this.generateRequestId(),
      }));
    });
  }
}

module.exports = MEXCWebSocket;