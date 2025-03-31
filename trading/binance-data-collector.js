// Phase 1 – Updated Data Collector with 30m Sliding Window, Liquidation Triggers, and Trading Strategy

import WebSocket from 'ws';
import axios from 'axios';
import fs from 'fs';

const SYMBOLS = ['btcusdt', 'ethusdt'];
const WINDOW_SIZE = 30; // 30 minutes (1-minute intervals)
const buffers = {};
const cvdTrackers = {};
const signalLog = [];
const pendingTrades = [];
const tradeResults = [];

SYMBOLS.forEach(symbol => {
  buffers[symbol] = {
    index: 0,
    data: new Array(WINDOW_SIZE).fill(null)
  };
  cvdTrackers[symbol] = 0;
});

const liquidationTimers = {};

function getCurrentTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function updateBuffer(symbol, newData) {
  const buffer = buffers[symbol];
  buffer.data[buffer.index] = newData;
  buffer.index = (buffer.index + 1) % WINDOW_SIZE;
}

function getDataWindow(symbol, minutes) {
  const buffer = buffers[symbol];
  const result = [];
  for (let i = 0; i < minutes; i++) {
    const index = (buffer.index - 1 - i + WINDOW_SIZE) % WINDOW_SIZE;
    const data = buffer.data[index];
    if (data) result.unshift(data);
  }
  return result;
}

function getPercentChange(start, end) {
  if (!start || !end || start === 0) return 0;
  return ((end - start) / start) * 100;
}

function calculateRSI(symbol, period = 14) {
  const data = getDataWindow(symbol, period + 1);
  if (data.length <= period) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i < data.length; i++) {
    const diff = data[i].price - data[i - 1].price;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (gains + losses === 0) return 50;
  const rs = gains / (losses || 1e-9);
  return 100 - (100 / (1 + rs));
}

function passesMomentumFilter(symbol, direction, options = {}) {
  const rsi = calculateRSI(symbol);
  if (rsi === null) return true;

  const rsiThresholds = {
    LONG: options.rsiHigh ?? 75,
    SHORT: options.rsiLow ?? 25
  };

  if (direction === 'LONG' && rsi > rsiThresholds.LONG) return false;
  if (direction === 'SHORT' && rsi < rsiThresholds.SHORT) return false;
  return true;
}

function getTPMultiplier(reason) {
  if (reason.includes('Liquidation')) return 0.0015;
  if (reason.includes('Volume spike')) return 0.003;
  return 0.002;
}

function getTickSize(symbol, price) {
  // Approximate tickSize for major pairs. You can enhance this later.
  const tickSizePercent = symbol.includes('btc') ? 0.01 : 0.05; // Example fallback
  return price * (tickSizePercent / 100);
}

function logSignal(symbol, direction, reason) {
  const url = `https://www.coinglass.com/tv/Binance_${symbol.toUpperCase()}`;
  const timestamp = getCurrentTimestamp();
  const latest = getDataWindow(symbol, 1)[0];
  const entryPrice = latest?.price;

  const rawTP = direction === 'LONG'
    ? entryPrice * (1 + getTPMultiplier(reason))
    : entryPrice * (1 - getTPMultiplier(reason));

  const tickSize = getTickSize(symbol, entryPrice);
  const minTP = direction === 'LONG'
    ? entryPrice + tickSize
    : entryPrice - tickSize;

  const takeProfit = direction === 'LONG'
    ? Math.max(rawTP, minTP)
    : Math.min(rawTP, minTP);

  const trade = {
    timestamp,
    symbol,
    direction,
    reason,
    entryPrice,
    takeProfit,
    history: [],
    closed: false
  };

  signalLog.push({ ...trade, coinglass: url });
  pendingTrades.push(trade);

  console.log(`[${symbol}] ${direction} – ${reason}`);
  console.log(`🔗 ${url}
`);
}

function buildVolumeProfile(symbol) {
  const m15 = getDataWindow(symbol, 15);
  const volumeBins = {};
  const current = m15[m15.length - 1];
  if (!current) return [];

  m15.forEach(({ price, volume }) => {
    if (!price || !volume) return;
    const step = price * 0.001; // 0.1% range
    const bucket = Math.round(price / step) * step;
    volumeBins[bucket] = (volumeBins[bucket] || 0) + volume;
  });

  return Object.entries(volumeBins)
    .map(([level, vol]) => ({ level: parseFloat(level), volume: vol }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 6);
}

function filterTrade(symbol, direction) {
  const profile = buildVolumeProfile(symbol);
  const latest = getDataWindow(symbol, 1)[0];
  if (!latest) return true;
  const { price } = latest;

  for (const { level } of profile) {
    const distance = Math.abs((level - price) / price) * 100;
    if (direction === 'LONG' && level > price && distance <= 0.2) return false;
    if (direction === 'SHORT' && level < price && distance <= 0.2) return false;
  }

  return true;
}

function strategyEngine(symbol) {
  const m1 = getDataWindow(symbol, 1);
  const m12 = getDataWindow(symbol, 12);
  const m15 = getDataWindow(symbol, 15);
  const m30 = getDataWindow(symbol, 30);

  const current = m1[m1.length - 1];
  if (!current) return; 

  const priceChange1m = getPercentChange(m1[0]?.price, current.price);
  const cvdChange1m = getPercentChange(m1[0]?.cvd, current.cvd);
  const oiChange1m = getPercentChange(m1[0]?.openInterest, current.openInterest);

  const priceChange12m = getPercentChange(m12[0]?.price, m12[m12.length - 1]?.price);
  const oiChange12m = getPercentChange(m12[0]?.openInterest, m12[m12.length - 1]?.openInterest);
  const volume12m = m12.reduce((acc, d) => acc + (d.volume || 0), 0);

  const priceChange15m = getPercentChange(m15[0]?.price, m15[m15.length - 1]?.price);
  const priceChange30m = getPercentChange(m30[0]?.price, m30[m30.length - 1]?.price);
  const oiChange30m = getPercentChange(m30[0]?.openInterest, m30[m30.length - 1]?.openInterest);

  const funding = current.funding;

  // Open Interest Triggers
  if (oiChange1m <= -1 && priceChange1m < 0 && cvdChange1m < 0) {
    if (filterTrade(symbol, 'SHORT') && passesMomentumFilter(symbol, 'SHORT', { rsiLow: 30 })) logSignal(symbol, 'SHORT', 'OI -1%+ down + Price down + CVD down (1m)');
  }

  if (oiChange12m >= 2 && priceChange1m > 0 && cvdChange1m > 0 && volume12m > 2 * (m12[0]?.volume || 1)) {
    if (filterTrade(symbol, 'LONG') && passesMomentumFilter(symbol, 'LONG', { rsiHigh: 70 })) logSignal(symbol, 'LONG', 'OI +2% (12m) + Price/CVD up + Volume spike');
  }

  if (oiChange30m >= 15 && priceChange1m < 0 && cvdChange1m < 0) {
    if (filterTrade(symbol, 'SHORT') && passesMomentumFilter(symbol, 'SHORT')) logSignal(symbol, 'SHORT', 'OI +15% (30m) + Price/CVD down (1m)');
  }

  // Price Triggers
  if (priceChange12m >= 3 && oiChange1m > 0 && cvdChange1m > 0) {
    if (filterTrade(symbol, 'LONG') && passesMomentumFilter(symbol, 'LONG')) logSignal(symbol, 'LONG', 'Price +3% (5m) + OI/CVD up (1m)');
  }

  if (priceChange15m <= -10 && oiChange1m > 0 && cvdChange1m > 0) {
    if (filterTrade(symbol, 'LONG') && passesMomentumFilter(symbol, 'LONG')) logSignal(symbol, 'LONG', 'Price -10% (15m) + OI/CVD up (1m)');
  }

  if (priceChange30m >= 10 && oiChange1m < 0 && cvdChange1m < 0) {
    if (filterTrade(symbol, 'SHORT') && passesMomentumFilter(symbol, 'SHORT')) logSignal(symbol, 'SHORT', 'Price +10% (20m) + OI/CVD down (1m)');
  }

  // Funding Trigger
  if (funding <= -0.001 && priceChange1m > 0 && oiChange1m > 0) {
    if (filterTrade(symbol, 'LONG') && passesMomentumFilter(symbol, 'LONG')) logSignal(symbol, 'LONG', 'Funding -0.1% or less + OI/Price up');
  }
}

function handleLiquidation(symbol, side) {
  if (!liquidationTimers[symbol]) liquidationTimers[symbol] = [];

  const timer = setTimeout(() => {
    const m1 = getDataWindow(symbol, 1);
    const latest = m1[m1.length - 1];
    if (!latest) return;

    const priceChange = getPercentChange(m1[0]?.price, latest.price);
    const oiChange = getPercentChange(m1[0]?.openInterest, latest.openInterest);

    const direction = side === 'LONG' ? 'LONG' : 'SHORT';
    const valid = side === 'LONG'
      ? priceChange > 0 && oiChange > 0
      : priceChange < 0 && oiChange < 0;

    if (valid && filterLiquidationTrade(symbol, direction) && passesMomentumFilter(symbol, direction)) {
    logSignal(symbol, direction, `Liquidation of ${side}s + Price/OI ${side === 'LONG' ? 'rebound' : 'drop'} (post-30s)`);
    }
  }, 30000);

  liquidationTimers[symbol].push(timer);
}

function filterLiquidationTrade(symbol, direction) {
  const profile = buildVolumeProfile(symbol);
  const latest = getDataWindow(symbol, 1)[0];
  if (!latest) return false;
  const { price } = latest;

  for (const { level } of profile) {
    const distance = Math.abs((level - price) / price) * 100;
    if (direction === 'LONG' && level < price && distance <= 0.2) return true;
    if (direction === 'SHORT' && level > price && distance <= 0.2) return true;
  }

  return false;
}

// WebSocket for Price, Volume & Buffer Updates
const priceWS = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${SYMBOLS.map(s => `${s}@ticker`).join('/')}`);
priceWS.on('message', msg => {
  const parsed = JSON.parse(msg);
  const symbol = parsed.data.s.toLowerCase();
  const price = parseFloat(parsed.data.c);
  const volume = parseFloat(parsed.data.v);

  const timestamp = getCurrentTimestamp();
  const data = {
    timestamp,
    price,
    volume,
    cvd: cvdTrackers[symbol] || 0,
    openInterest: null,
    funding: null
  };

  updateBuffer(symbol, data);
});

// WebSocket for Spot CVD via AggTrades
const cvdWS = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${SYMBOLS.map(s => `${s}@aggTrade`).join('/')}`);
cvdWS.on('message', msg => {
  const parsed = JSON.parse(msg);
  const symbol = parsed.data.s.toLowerCase();
  const volume = parseFloat(parsed.data.q);
  const maker = parsed.data.m;

  const delta = maker ? -volume : volume;
  cvdTrackers[symbol] += delta;
});

// WebSocket for Liquidations
const liquidWS = new WebSocket(`wss://fstream.binance.com/ws/!forceOrder@arr`);
liquidWS.on('message', msg => {
  const data = JSON.parse(msg);
  if (!data.o) return;
  const { s, S } = data.o;
  const symbol = s.toLowerCase();
  const side = S === 'SELL' ? 'LONG' : 'SHORT';
  handleLiquidation(symbol, side);
});

async function fetchFundingRates() {
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/fundingRate');
    res.data.forEach(item => {
      const symbol = item.symbol.toLowerCase();
      const entry = buffers[symbol];
      if (!entry) return;

      const current = entry.data[(entry.index - 1 + WINDOW_SIZE) % WINDOW_SIZE];
      if (current) current.funding = parseFloat(item.fundingRate);
    });
  } catch (err) {
    console.error('Funding fetch error:', err.message);
  }
}

async function fetchOpenInterest() {
  const now = getCurrentTimestamp();
  await Promise.all(SYMBOLS.map(async symbol => {
    try {
      const res = await axios.get('https://fapi.binance.com/futures/data/openInterestHist', {
        params: {
          symbol: symbol.toUpperCase(),
          period: '1m',
          limit: 1
        }
      });
      const oiCoins = parseFloat(res.data[0].sumOpenInterest);
      const current = buffers[symbol].data[(buffers[symbol].index - 1 + WINDOW_SIZE) % WINDOW_SIZE];
      if (current) current.openInterest = oiCoins;
    } catch (err) {
      console.error(`OI fetch error for ${symbol}:`, err.message);
    }
  }));
}

setInterval(() => {
  SYMBOLS.forEach(strategyEngine);

  const now = getCurrentTimestamp();
  pendingTrades.forEach(trade => {
    if (trade.closed) return;

    const current = getDataWindow(trade.symbol, 1)[0];
    if (!current) return;

    trade.history.push(current.price);

    const hit = trade.direction === 'LONG'
      ? current.price >= trade.takeProfit
      : current.price <= trade.takeProfit;

    if (hit || trade.history.length >= 30) {
      trade.closed = true;
      const maxGain = trade.direction === 'LONG'
				? Math.max(...trade.history)
				: Math.min(...trade.history);

			const maxGainPct = getPercentChange(trade.entryPrice, maxGain);
			const couldHit1pct = trade.direction === 'LONG'
				? maxGainPct >= 1
				: maxGainPct <= -1;

			tradeResults.push({
				...trade,
				TP_hit: hit,
				hitAtMinute: hit ? trade.history.length : null,
				finalPrice: current.price,
				percentChange: getPercentChange(trade.entryPrice, current.price).toFixed(2) + '%',
				maxGain: maxGain.toFixed(2),
				maxGainPct: maxGainPct.toFixed(2),
				couldHit1pct
      });
    }
  });
}, 60000);

setInterval(fetchFundingRates, 3 * 60 * 1000);
setInterval(fetchOpenInterest, 60 * 1000);

console.log('📊 Bot running with updated Phase 1 logic...');

// Export trade results and signal log every 5 minutes
setInterval(() => {
  try {
    fs.writeFileSync('signal-log.json', JSON.stringify(signalLog, null, 2));
    fs.writeFileSync('trade-results.json', JSON.stringify(tradeResults, null, 2));
    console.log('💾 Exported signal log and trade results');
  } catch (err) {
    console.error('Error exporting data:', err.message);
  }
}, 5 * 60 * 1000);
