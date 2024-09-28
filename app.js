import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();
const key = process.env.API_KEY;
const secret = process.env.API_SECRET;

const binanceFuturesWsEndpoint = "wss://fstream.binance.com/ws/!forceOrder@arr";
console.log('Attempting to connect to Binance Futures WebSocket with liquidations for all USDT pairs %j', binanceFuturesWsEndpoint);
var binanceWsClient = new WebSocket(binanceFuturesWsEndpoint);
// Или такие варианты подписаться на несколько топиков одновременно:
// const binanceFuturesWsEndpoint = "wss://fstream.binance.com/ws/!forceOrder@arr/btcusdt@aggTrade";
// binanceWsClient.send(JSON.stringify({"method": "SUBSCRIBE", "params": ["!forceOrder@arr", "btcusdt@aggTrade"], "id": 1}));

binanceWsClient.on('open', function () {
	console.log('"open" event!');
	console.log('WebSocket Client Connected');
	setInterval(()=>{binanceWsClient.ping()}, 30000);
	binanceWsClient.ping();
});
binanceWsClient.on('ping', function () {
	console.log("ping received");
	binanceWsClient.pong();
	console.log("pong sent");
});
binanceWsClient.on('pong', function () {
	console.log("pong received");
});
//TODO: add reconnect on disconnect event, etc

// The main events receiver
binanceWsClient.on('message', function (data) {
	let raw_data = JSON.parse(Buffer.from(data).toString());
	if (raw_data.o.q * raw_data.o.ap >= 50) {
		console.log(raw_data.o.s + ": " + raw_data.o.o + ", " + raw_data.o.S + ", volume: " + raw_data.o.q * raw_data.o.ap);
	};
});