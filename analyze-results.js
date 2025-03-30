// analyze-results.js

import fs from 'fs';

function loadResults() {
  try {
    const raw = fs.readFileSync('trade-results.json');
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

  results.forEach(r => {
    if (r.TP_hit) {
      wins++;
      hitTimes.push(r.hitAtMinute);
    } else {
      losses++;
    }

    if (!reasons[r.reason]) {
      reasons[r.reason] = { count: 0, wins: 0 };
    }
    reasons[r.reason].count++;
    if (r.TP_hit) reasons[r.reason].wins++;
  });

  const winRate = (wins / results.length * 100).toFixed(2);
  const avgHitTime = hitTimes.length
    ? (hitTimes.reduce((a, b) => a + b) / hitTimes.length).toFixed(1)
    : 'N/A';

  console.log('📊 Trade Result Summary');
  console.log('------------------------');
  console.log(`Total Trades     : ${results.length}`);
  console.log(`✅ Wins           : ${wins}`);
  console.log(`❌ Losses        : ${losses}`);
  console.log(`🎯 Win Rate      : ${winRate}%`);
  console.log(`⏱️ Avg TP Time    : ${avgHitTime} min`);
  console.log('\nTop Strategies:');

  Object.entries(reasons)
    .sort(([, a], [, b]) => b.count - a.count)
    .forEach(([reason, { count, wins }]) => {
      const rate = ((wins / count) * 100).toFixed(1);
      console.log(`• ${reason} – ${count} signals – ${rate}% win rate`);
    });
}

const results = loadResults();
summarizeResults(results);
