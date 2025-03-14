// configuration.js
import fs from 'fs';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

EventEmitter.defaultMaxListeners = 100;
//process.setMaxListeners(100);

class Configuration extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.current = {};
    this.loadConfig();
  }

  loadConfig() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      this.current = JSON.parse(data);
    } catch (error) {
      logger.error(`Error loading configuration:`);
      console.error(error);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.current, null, 2));
    } catch (error) {
      logger.error(`Error saving configuration:`);
      console.error(error);
    }
  }

  getConfig() {
    return this.current;
  }

  setConfig(newConfig) {
    this.current = { ...this.current, ...newConfig };
    this.saveConfig();
    logger.info('Config updated! Current settings: %j', this.current);
  }
}

const config = new Configuration('./config.json');

export default config;
