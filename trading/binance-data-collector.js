
// BINANCE WSS!!

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
