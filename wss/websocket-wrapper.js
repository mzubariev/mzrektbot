// websocket-wrapper.js
import WebSocket from 'ws';

class WebSocketWrapper {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.reconnectInterval = 5000; // Reconnect interval in milliseconds
    this.reconnectTimer = null;
    this.isConnected = false;
    this.isForceDisconnect = false;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log(`Connected to ${this.url}`);
      this.isConnected = true;
      clearTimeout(this.reconnectTimer);
    });

    this.ws.on('close', () => {
      console.log(`Disconnected from ${this.url}`);
      this.isConnected = false;
      if (!this.isForceDisconnect) {
        this.reconnect();
      }
      this.isForceDisconnect = false;
    });

    this.ws.on('error', (error) => {
      console.error(`WebSocket error for ${this.url}:`, error);
      this.isConnected = false;
      this.reconnect();
    });
  }

  reconnect() {
    console.log(`Attempting to reconnect to ${this.url} in ${this.reconnectInterval}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectInterval);
  }

  disconnect() {
    if (this.ws && this.isConnected) {
      this.isForceDisconnect = true;
      this.ws.close();
    }
  }

  send(message) {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

export default WebSocketWrapper;