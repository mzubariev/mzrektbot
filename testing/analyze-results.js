import fs from 'fs';

function loadResults() {
  try {
    const raw = fs.readFileSync('./testing/trade-results.json');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load trade results:', err.message);
    return [];
  }
}

function summarizeResults(results) {
  if (!results.length) return console.log('No results found.');

  let wins = 0;
  let losses = 0;
  const hitTimes = [];
  const reasons = {};
  const directionStats = { LONG: [], SHORT: [] };

  let onePctTotal = 0;
  let oneFivePctTotal = 0;

  results.forEach(r => {
    const key = `${r.reason} (${r.direction})`;

    if (!reasons[key]) {
      reasons[key] = { count: 0, wins: 0, onePercent: 0, onePointFive: 0 };
    }

    reasons[key].count++;
    if (r.TP_hit) {
      wins++;
      hitTimes.push(r.hitAtMinute);
      reasons[key].wins++;
    } else {
      losses++;
    }

    if (r.couldHit1pct) {
      reasons[key].onePercent++;
      onePctTotal++;
    }

    if (r.maxGainPct && Math.abs(parseFloat(r.maxGainPct)) >= 1.5) {
      reasons[key].onePointFive++;
      oneFivePctTotal++;
    }

    directionStats[r.direction]?.push(r);
  });

  const winRate = (wins / results.length * 100).toFixed(2);
  const avgHitTime = hitTimes.length
    ? (hitTimes.reduce((a, b) => a + b) / hitTimes.length).toFixed(1)
    : 'N/A';

  const onePercentRate = ((onePctTotal / results.length) * 100).toFixed(2);
  const oneFivePercentRate = ((oneFivePctTotal / results.length) * 100).toFixed(2);

  console.log('📊 Trade Result Summary');
  console.log('------------------------');
  console.log(`Total Trades         : ${results.length}`);
  console.log(`✅ Wins              : ${wins}`);
  console.log(`❌ Stuck             : ${losses}`);
  console.log(`🎯 Win Rate          : ${winRate}%`);
  console.log(`⏱️ Avg TP Time       : ${avgHitTime} min`);
  console.log(`🚀 1% TP Potential   : ${onePctTotal} trades (${onePercentRate}%)`);
  console.log(`🚀 1.5% TP Potential : ${oneFivePctTotal} trades (${oneFivePercentRate}%)`);

  console.log('\n📈 Directional Breakdown:');
  ['LONG', 'SHORT'].forEach(dir => {
    const list = directionStats[dir];
    if (!list?.length) return;
    const wins = list.filter(r => r.TP_hit).length;
    const onePct = list.filter(r => r.couldHit1pct).length;
    const oneFive = list.filter(r => parseFloat(r.maxGainPct) >= 1.5).length;
    const avgTime = list
      .filter(r => r.hitAtMinute !== undefined)
      .map(r => r.hitAtMinute)
      .reduce((a, b) => a + b, 0) / list.length;

    const winRate = (wins / list.length * 100).toFixed(2);
    const onePctRate = (onePct / list.length * 100).toFixed(2);
    const oneFiveRate = (oneFive / list.length * 100).toFixed(2);
    const avgHit = isNaN(avgTime) ? 'N/A' : avgTime.toFixed(1);

    console.log(`• ${dir} | ${list.length} trades | ${winRate}% win | ${onePctRate}% ≥1% | ${oneFiveRate}% ≥1.5% | Avg TP: ${avgHit} min`);
  });

  console.log('\nTop Strategies (by direction):');
  Object.entries(reasons)
    .sort(([, a], [, b]) => b.count - a.count)
    .forEach(([reason, data]) => {
      const { count, wins, onePercent, onePointFive } = data;
      const winRate = ((wins / count) * 100).toFixed(1);
      const onePct = ((onePercent / count) * 100).toFixed(1);
      const oneFive = ((onePointFive / count) * 100).toFixed(1);
      const highlight = onePct >= 50 ? '\x1b[32m' : '';
      const reset = highlight ? '\x1b[0m' : '';
      console.log(`${highlight}• ${reason} | ${count} trades | ${winRate}% win | ${onePct}% ≥1% | ${oneFive}% ≥1.5%${reset}`);
    });
}

const results = loadResults();
summarizeResults(results);
