const fs = require('fs');

class Configuration {
  constructor(filePath) {
    this.filePath = filePath;
    this.config = {};
    this.loadConfig();
  }

  loadConfig() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      this.config = JSON.parse(data);
    } catch (error) {
      console.error('Error loading configuration:', error);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Error saving configuration:', error);
    }
  }

  getConfig() {
    return this.config;
  }

  setConfig(config) {
    this.config = config;
    this.saveConfig();
  }
}

module.exports = Configuration;
