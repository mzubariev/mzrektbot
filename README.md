# Установка и запуск
(у меня Node.js v20.10.0)
* npm install
* npm start

# URLs
* Binance
    * Streams:
        * Testnet: 'wss://stream.binancefuture.com/ws' OR 'wss://stream.binancefuture.com/stream?streams=!forceOrder@arr/!ticker@arr'
        * Main: 'wss://fstream.binance.com/ws'
    * API:
        * Testnet 'wss://testnet.binancefuture.com/ws-fapi/v1'
        * Main: 'wss://ws-fapi.binance.com/ws-fapi/v1'

# How it works
Going by a market trend means the opposite direction from a liquidations.
Example: when the market goes UP then SELL (SHORT) liquidations get trigerred and we need to BUY.
По тренду (trend) ИЛИ в отскок (rebound).

# HEDGE MODE
* Open position:
    * Long : positionSide=LONG, side=BUY
    * Short: positionSide=SHORT, side=SELL
* Close position:
    * Close long position: positionSide=LONG, side=SELL
    * Close short position: positionSide=SHORT, side=BUY

# Testing
* To analyze test results:
    * node analyze-results.js
