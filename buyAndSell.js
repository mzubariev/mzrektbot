import WebSocket from 'ws';
import https from 'https';
import crypto from 'crypto';

const apiKey = '';
const apiSecret = '';
const baseUrl = 'https://api.binance.com';

let symbolInfo = null;
let tradeComplete = false;
let startTime, buyTime, sellTime;
let buyQuantity, buyPrice, sellQuantity, sellPrice;

// Функция для получения информации о символе
function getSymbolInfo(symbol) {
    return new Promise((resolve, reject) => {
        https.get(`${baseUrl}/api/v3/exchangeInfo?symbol=${symbol}`, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.symbols && response.symbols[0]) {
                        resolve(response.symbols[0]);
                    } else {
                        reject(new Error('Symbol info not found'));
                    }
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        }).on('error', (error) => {
            console.error('Error in getSymbolInfo:', error);
            reject(error);
        });
    });
}

function adjustQuantity(quantity, stepSize) {
    const precision = stepSize.toString().split('.')[1]?.length || 0;
    return Math.floor(quantity / stepSize) * stepSize;
}

function adjustPrice(price, tickSize) {
    const precision = tickSize.toString().split('.')[1]?.length || 0;
    return parseFloat(price.toFixed(precision));
}

const ws = new WebSocket('wss://stream.binance.com:9443/ws/ordiusdt@bookTicker');

ws.on('message', async (data) => {
    if (tradeComplete) return;

    const ticker = JSON.parse(data);
    console.log(`Текущая цена ORDI/USDT: ${ticker.b}`);

    if (!symbolInfo) {
        try {
            symbolInfo = await getSymbolInfo('ORDIUSDT');
            const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
            const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
            const notionalFilter = symbolInfo.filters.find(f => f.filterType === 'NOTIONAL');
            if (!lotSizeFilter || !notionalFilter || !priceFilter) throw new Error('Необходимые фильтры не найдены');
            symbolInfo.stepSize = parseFloat(lotSizeFilter.stepSize);
            symbolInfo.tickSize = parseFloat(priceFilter.tickSize);
            symbolInfo.minNotional = parseFloat(notionalFilter.minNotional);
        } catch (error) {
            console.error('Ошибка при получении информации о символе:', error);
            closeConnection();
            return;
        }

        startTime = Date.now();
        console.log(`Процесс начат в: ${new Date(startTime).toISOString()}`);

        // Вычисляем количество ORDI, которое можно купить на 5$
        let calculatedBuyQuantity = 5 / parseFloat(ticker.b);
        calculatedBuyQuantity = adjustQuantity(calculatedBuyQuantity, symbolInfo.stepSize);

        // Проверяем, соответствует ли ордер минимальной нотациональной стоимости
        let orderValue = calculatedBuyQuantity * parseFloat(ticker.b);
        if (orderValue < symbolInfo.minNotional) {
            console.log(`Стоимость ордера (${orderValue}) меньше минимальной нотациональной (${symbolInfo.minNotional}). Корректируем количество.`);
            calculatedBuyQuantity = adjustQuantity(symbolInfo.minNotional / parseFloat(ticker.b), symbolInfo.stepSize);
            orderValue = calculatedBuyQuantity * parseFloat(ticker.b);

            if (orderValue < symbolInfo.minNotional) {
                calculatedBuyQuantity = parseFloat(calculatedBuyQuantity) + symbolInfo.stepSize;
                orderValue = calculatedBuyQuantity * parseFloat(ticker.b);
            }
        }

        console.log(`Скорректированное количество для покупки: ${calculatedBuyQuantity}`);
        console.log(`Стоимость ордера: ${orderValue.toFixed(8)} USDT`);
        buyQuantity = calculatedBuyQuantity;

        placeOrder('ORDIUSDT', 'BUY', 'MARKET', buyQuantity.toFixed(8));

        // Отключаем прослушивание новых сообщений
        ws.removeAllListeners('message');
    }
});

function placeOrder(symbol, side, type, quantity, price = null) {
    const endpoint = '/api/v3/order';
    const timestamp = Date.now();

    let params = `symbol=${symbol}&side=${side}&type=${type}&quantity=${quantity}&timestamp=${timestamp}`;

    if (type === 'LIMIT' && price) {
        params += `&price=${price}&timeInForce=GTC`;
    }

    const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(params)
        .digest('hex');

    params += `&signature=${signature}`;

    const options = {
        hostname: 'api.binance.com',
        port: 443,
        path: `${endpoint}?${params}`,
        method: 'POST',
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    };

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => {
            const response = JSON.parse(data);
            console.log(`Ордер размещен: ${side}`, response);

            if (response.code) {
                console.error('Ошибка при размещении ордера:', response.msg);
                closeConnection();
                return;
            }

            if (side === 'BUY') {
                buyTime = Date.now();
                buyPrice = parseFloat(response.fills[0].price);
                console.log(`Ордер на покупку выполнен в: ${new Date(buyTime).toISOString()}`);
                console.log(`Время выполнения покупки: ${buyTime - startTime} мс`);

                // После покупки выставляем ордер на продажу с наценкой 0.1%
                sellPrice = adjustPrice(buyPrice * 1.001, symbolInfo.tickSize);
                sellQuantity = adjustQuantity(parseFloat(response.executedQty), symbolInfo.stepSize);
                placeOrder(symbol, 'SELL', 'LIMIT', sellQuantity.toFixed(8), sellPrice.toFixed(8));
            } else if (side === 'SELL') {
                sellTime = Date.now();
                console.log(`Ордер на продажу размещен в: ${new Date(sellTime).toISOString()}`);
                console.log(`Общее время выполнения процесса: ${sellTime - startTime} мс`);

                // Вычисляем и выводим информацию о сделке
                const buyValue = buyQuantity * buyPrice;
                const sellValue = sellQuantity * parseFloat(sellPrice);
                const commission = (buyValue * 0.001) + (sellValue * 0.001); // Предполагаем комиссию 0.1% на каждую операцию

                console.log(`\nИтоговая информация:`);
                console.log(`Куплено: ${buyQuantity} ORDI за ${buyValue.toFixed(8)} USDT`);
                console.log(`Продано: ${sellQuantity} ORDI за ${sellValue.toFixed(8)} USDT`);
                console.log(`Комиссия: ${commission.toFixed(8)} USDT`);
                console.log(`Прибыль/убыток: ${(sellValue - buyValue - commission).toFixed(8)} USDT`);

                closeConnection();
            }
        });
    });

    req.on('error', (error) => {
        console.error('Ошибка:', error);
        closeConnection();
    });

    req.end();
}

function closeConnection() {
    tradeComplete = true;
    console.log('Процесс торговли завершен. Закрываем соединение...');
    ws.close();
    process.exit();
}

ws.on('open', () => {
    console.log('WebSocket подключен');
});

ws.on('error', (error) => {
    console.error('Ошибка WebSocket:', error);
    closeConnection();
});

process.on('SIGINT', () => {
    console.log('Закрываем WebSocket соединение...');
    ws.close();
    process.exit();
});