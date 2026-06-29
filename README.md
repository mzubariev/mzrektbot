**Experimental Automated Trading Platform (Personal Sandbox / Learning Project)**

This is a personal experimental MVP created for deep hands-on learning of real-time trading systems.

The main goal was to gain practical experience with:
- Exchange API integrations
- WebSocket market data feeds
- Event-driven architectures and asynchronous workflows
- Order execution pipelines and state synchronization
- Automation of manual trading strategies

**Note:** This is not production-grade code. It was built as a sandbox for personal experimentation and skill development rather than a clean, maintainable production system.

---

# Installation and run
(worked stably with Node.js v20.10.0)
* update config.json and env variables
* npm install
* npm start

---

## URLs
* Binance
    * Streams:
        * Testnet: 'wss://stream.binancefuture.com/ws' OR 'wss://stream.binancefuture.com/stream?streams=!forceOrder@arr/!ticker@arr'
        * Main: 'wss://fstream.binance.com/ws'
    * API:
        * Testnet 'wss://testnet.binancefuture.com/ws-fapi/v1'
        * Main: 'wss://ws-fapi.binance.com/ws-fapi/v1'

## HEDGE MODE
* Open position:
    * Long : positionSide=LONG, side=BUY
    * Short: positionSide=SHORT, side=SELL
* Close position:
    * Close long position: positionSide=LONG, side=SELL
    * Close short position: positionSide=SHORT, side=BUY

## Testing
* To analyze test results:
    * node testing/analyze-results.js
