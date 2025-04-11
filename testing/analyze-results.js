// analyze-results.js

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
  const reasons = {}; // reason + direction
  const directionStats = { LONG: [], SHORT: [] };

  results.forEach(r => {
    const key = `${r.reason} (${r.direction})`;

    if (!reasons[key]) {
      reasons[key] = { count: 0, wins: 0, onePercent: 0 };
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
    }

    directionStats[r.direction]?.push(r);
  });

  const winRate = (wins / results.length * 100).toFixed(2);
  const avgHitTime = hitTimes.length
    ? (hitTimes.reduce((a, b) => a + b) / hitTimes.length).toFixed(1)
    : 'N/A';

  const onePercentHits = results.filter(r => r.couldHit1pct).length;
  const onePercentRate = ((onePercentHits / results.length) * 100).toFixed(2);

  console.log('📊 Trade Result Summary');
  console.log('------------------------');
  console.log(`Total Trades       : ${results.length}`);
  console.log(`✅ Wins            : ${wins}`);
  console.log(`❌ Stuck           : ${losses}`);
  console.log(`🎯 Win Rate        : ${winRate}%`);
  console.log(`⏱️ Avg TP Time     : ${avgHitTime} min`);
  console.log(`🚀 1% TP Potential : ${onePercentHits} trades (${onePercentRate}%)`);

  // Directional summary
  console.log('\n📈 Directional Breakdown:');
  ['LONG', 'SHORT'].forEach(dir => {
    const list = directionStats[dir];
    if (!list?.length) return;
    const wins = list.filter(r => r.TP_hit).length;
    const onePct = list.filter(r => r.couldHit1pct).length;
    const avgTime = list
      .filter(r => r.hitAtMinute !== undefined)
      .map(r => r.hitAtMinute)
      .reduce((a, b) => a + b, 0) / list.length;

    const winRate = (wins / list.length * 100).toFixed(2);
    const onePctRate = (onePct / list.length * 100).toFixed(2);
    const avgHit = isNaN(avgTime) ? 'N/A' : avgTime.toFixed(1);

    console.log(`• ${dir} | ${list.length} trades | ${winRate}% win rate | ${onePctRate}% hit 1% | Avg TP: ${avgHit} min`);
  });

  // Strategy-level detail
  console.log('\nTop Strategies (by direction):');
  Object.entries(reasons)
    .sort(([, a], [, b]) => b.count - a.count)
    .forEach(([reason, data]) => {
      const { count, wins, onePercent } = data;
      const rate = ((wins / count) * 100).toFixed(1);
      const onePct = ((onePercent / count) * 100).toFixed(1);
      const highlight = onePct >= 50 ? '\x1b[32m' : ''; // green if 50% or more
      const reset = highlight ? '\x1b[0m' : '';
      console.log(`${highlight}• ${reason} | ${count} signals | ${rate}% win rate | ${onePct}% hit 1% TP${reset}`);
    });
}

const results = loadResults();
summarizeResults(results);
