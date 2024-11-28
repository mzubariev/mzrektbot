// configuration.js
import fs from 'fs';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

class Configuration extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.config = {};
    this.loadConfig();
  }

  loadConfig() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      this.config = JSON.parse(data);
    } catch (error) {
      logger.error('Error loading configuration: %j', error);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2));
      this.emit('configUpdated', this.config); // Emit event when config is updated
    } catch (error) {
      logger.error('Error saving configuration: %j', error);
    }
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.saveConfig();
  }
}

const config = new Configuration('./config.json');

export default config;
