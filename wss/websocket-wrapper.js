// websocket-wrapper.js
import EventEmitter from 'events';
import WebSocket from 'ws';
import logger from '../utils/logger.js';

EventEmitter.defaultMaxListeners = 30;

class WebSocketWrapper extends EventEmitter {
  constructor({ urlStreams, urlApi }) {
    super();
    this.name = '';
    this.urlStreams = urlStreams;
    this.urlApi = urlApi;
    this.wsMarketStreams = null;
    this.wsApi = null;
    this.wsUserDataStreams = null;
    this.listenKey = null;
    this.reconnectTimerStreamsWs = null;
    this.reconnectTimerApiWs = null;
    this.isForceDisconnectStreamsWs = false;
    this.isForceDisconnectApiWs = false;
    this.reconnectInterval = 5000;
    this.events = new EventEmitter();
  }

  connect(url = null) {
    // TODO: refactor to not reconnect to both at the same time if only one connection failed,
    // and to not repeat methods

    // User Data Stream

    this.wsUserDataStreams = new WebSocket(`${this.urlStreams}/${this.listenKey}`);

    this.wsUserDataStreams.on('open', () => {
      logger.info(`Connected to ${this.urlStreams} User Data Stream!`);
    });
    this.wsUserDataStreams.on('close', () => {
      logger.error('WebSocket connection closed. Reconnecting...');
      this.reconnect();
    });
    this.wsUserDataStreams.on('error', (error) => {
      logger.error(`WebSocket error: ${JSON.stringify(error, null, 2)}`);
      console.log(error);
      this.reconnect();
    });

    // Market Streams

    this.wsMarketStreams = new WebSocket(this.urlStreams);

    this.wsMarketStreams.on('open', () => {
      logger.info(`Connected to ${this.urlStreams} Market Streams!`);
      clearTimeout(this.reconnectTimer);
    });
    this.wsMarketStreams.on('close', () => {
      logger.info(`Disconnected from ${this.urlStreams}!`);
      if (!this.isForceDisconnectStreamsWs) {
        this.reconnect(this.urlStreams);
      }
      this.isForceDisconnectStreamsWs = false;
    });
    this.wsMarketStreams.on('error', (error) => {
      logger.error(`WebSocket error for ${this.urlStreams}: ${JSON.stringify(error, null, 2)}`);
      console.log(error);
      this.reconnect(this.urlStreams);
    });

    // TODO: add pong() method on ping event and send back the same payload we got from ping

    // WSS API

    this.wsApi = new WebSocket(this.urlApi);

    this.wsApi.on('open', () => {
      logger.info(`Connected to ${this.urlApi} WSS API!`);
      clearTimeout(this.reconnectTimer);
      this.authenticate();
    });
    this.wsApi.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.id === 1 && response.status === 200) {
        logger.info(`${this.name} wss API Authentication successful!`);
      } else if (response.error) {
        if (response.error.msg === 'Order does not exist.') {
          return;
        } else if (response.error.msg === 'Margin is insufficient.') {
          return;
        } else if (response.error.msg === "Order's notional must be no smaller than 5 (unless you choose reduce only).") {
          return;
        }
        logger.error(`Received an error message from ${this.name} wss API: ${JSON.stringify(response, null, 2)}`);
        console.log(response);
      } else if (!response.result.bids) { // don't show long orderBook requests with bids/asks
        logger.info('Received message from %s wss API: %j', this.name, response);
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
      logger.error(`WebSocket error for ${this.urlApi}: ${JSON.stringify(error, null, 2)}`);
      console.log(error);
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
    if (this.wsMarketStreams) {
      this.isForceDisconnectStreamsWs = true;
      this.wsMarketStreams.close();
    }
    logger.info(`Disconnecting WebSocket for ${this.urlApi}:`);
    if (this.wsApi) {
      this.isForceDisconnectApiWs = true;
      this.wsApi.close();
    }
  }

  authenticate() {}
  send() {}
}

export default WebSocketWrapper;