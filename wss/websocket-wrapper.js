// websocket-wrapper.js
import EventEmitter from 'events';
import WebSocket from 'ws';
import logger from '../utils/logger.js';

class WebSocketWrapper extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.reconnectInterval = 5000; // Reconnect interval in milliseconds
    this.reconnectTimer = null;
    this.isConnected = false;
    this.isForceDisconnect = false;
    this.events = new EventEmitter(); // EventEmitter for external message handling
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      logger.info(`Connected to ${this.url}`);
      this.isConnected = true;
      clearTimeout(this.reconnectTimer);
    });

    this.ws.on('close', () => {
      logger.info(`Disconnected from ${this.url}`);
      this.isConnected = false;
      if (!this.isForceDisconnect) {
        this.reconnect();
      }
      this.isForceDisconnect = false;
    });

    this.ws.on('error', (error) => {
      logger.error(`WebSocket error for ${this.url}:`, error);
      this.isConnected = false;
      this.reconnect();
    });
  }

  reconnect() {
    logger.info(`Attempting to reconnect to ${this.url} in ${this.reconnectInterval}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectInterval);
  }

  disconnect() {
    logger.info(`Disconnecting WebSocket for ${this.url}:`);
    if (this.ws && this.isConnected) {
      this.isForceDisconnect = true;
      this.ws.close();
    }
  }

  async send(message) {
    logger.info(`Posting a message via WebSocket to ${this.url}!`);
    try {
      if (this.ws && this.isConnected) {
        this.ws.send(JSON.stringify(message));
      }
    } catch (error) {
      logger.error('Error sending a message via wss: %j', error);
    }
  }
}

export default WebSocketWrapper;