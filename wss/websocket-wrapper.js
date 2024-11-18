// websocket-wrapper.js
import EventEmitter from 'events';
import WebSocket from 'ws';
import logger from '../utils/logger.js';

class WebSocketWrapper extends EventEmitter {
  constructor(urlStreams, urlApi) {
    super();
    this.urlStreams = urlStreams;
    this.urlApi = urlApi;
    this.wsStreams = null;
    this.wsApi = null;
    this.reconnectTimerStreamsWs = null;
    this.reconnectTimerApiWs = null;
    this.isForceDisconnectStreamsWs = false;
    this.isForceDisconnectApiWs = false;
    this.reconnectInterval = 5000; // Reconnect interval in milliseconds
    this.events = new EventEmitter(); // EventEmitter for external message handling
  }

  connect(url = null) {
    // TODO: refactor to not reconnect to both at the same time if only one connection failed,
    // and to not repeat methods

    this.wsStreams = new WebSocket(this.urlStreams);

    this.wsStreams.on('open', () => {
      logger.info(`Connected to ${this.urlStreams}!`);
      clearTimeout(this.reconnectTimer);
    });
    this.wsStreams.on('close', () => {
      logger.info(`Disconnected from ${this.urlStreams}!`);
      if (!this.isForceDisconnectStreamsWs) {
        this.reconnect(this.urlStreams);
      }
      this.isForceDisconnectStreamsWs = false;
    });
    this.wsStreams.on('error', (error) => {
      logger.error(`WebSocket error for ${this.urlStreams}: %j`, error);
      this.reconnect(this.urlStreams);
    });

    // TODO: add pong() method on ping event and send back the same payload we got from ping

    this.wsApi = new WebSocket(this.urlApi);

    this.wsApi.on('open', () => {
      logger.info(`Connected to ${this.urlApi}!`);
      clearTimeout(this.reconnectTimer);
      this.authenticate();
    });
    this.wsApi.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.id === 1 && response.status === 200) {
          console.log('Authentication successful');
          // Proceed with other API calls
      } else {
          console.log('Received message: %j', response);
      }
    });
    this.wsApi.on('close', () => {
      logger.info(`Disconnected from ${this.urlApi}!`);
      if (!this.isForceDisconnectApiWs) {
        this.reconnect(this.urlApi);
      }
      this.isForceDisconnectApiWs = false;
    });
    this.wsApi.on('error', (error) => {
      logger.error(`WebSocket error for ${this.urlApi}: %j`, error);
      this.reconnect(this.urlApi);
    });
  }

  reconnect(url) {
    logger.info(`Attempting to reconnect to ${url} in ${this.reconnectInterval}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect(url);
    }, this.reconnectInterval);
  }

  disconnect() {
    logger.info(`Disconnecting WebSocket for ${this.urlStreams}:`);
    if (this.wsStreams) {
      this.isForceDisconnectStreamsWs = true;
      this.wsStreams.close();
    }
    logger.info(`Disconnecting WebSocket for ${this.urlApi}:`);
    if (this.wsApi) {
      this.isForceDisconnectApiWs = true;
      this.wsApi.close();
    }
  }

  authenticate() {};
  send() {};
}

export default WebSocketWrapper;