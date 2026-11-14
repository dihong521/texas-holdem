'use strict';

/**
 * 生成翻牌前起手牌胜率表。
 *
 * 对 169 种起手牌（13 对子 + 78 同花 + 78 非同花），
 * 分别计算对抗 1~5 个「随机手牌」对手时的胜率。
 *
 * 用法：node tools/gen-preflop.js
 * 输出：src/preflop-table.js
 */

const fs = require('fs');
const path = require('path');
const { makeDeck, evaluate } = require('../src/cards');

const RANKS = '23456789TJQKA';
const MAX_OPPONENTS = 5;
const ITERS = 3000;

// 169 种起手牌的代表牌面
function allHands() {
  const list = [];

  // 对子：AA、KK ...
  for (const r of RANKS) {
    list.push({ key: r + r, cards: [r + 's', r + 'd'] });
  }

  // 非同花 / 同花：A K -> AKs / AKo
  for (let i = RANKS.length - 1; i >= 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const hi = RANKS[i];
      const lo = RANKS[j];
      list.push({ key: hi + lo + 's', cards: [hi + 's', lo + 's'] });
      list.push({ key: hi + lo + 'o', cards: [hi + 's', lo + 'd'] });
    }
  }

  return list;
}

// 一次迭代同时算对抗 1~5 个对手的胜率：
// 用同一批随机牌，避免每种对手数量各跑一遍带来的额外噪声和开销。
function simulateAll(hole, iters, pool) {
  const need = MAX_OPPONENTS * 2 + 5;
  const wins = new Array(MAX_OPPONENTS).fill(0);

  const my7 = new Array(7);
  const opp7 = new Array(7);

  for (let it = 0; it < iters; it++) {
    // 只随机化需要用到的前 need 张
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }

    for (let k = 0; k < 5; k++) {
      my7[2 + k] = pool[k];
      opp7[2 + k] = pool[k];
    }
    my7[0] = hole[0];
    my7[1] = hole[1];

    const mine = evaluate(my7);

    // 先算出 5 个对手各自的大小
    const oppScores = new Array(MAX_OPPONENTS);
    for (let o = 0; o < MAX_OPPONENTS; o++) {
      opp7[0] = pool[5 + o * 2];
      opp7[1] = pool[6 + o * 2];
      oppScores[o] = evaluate(opp7);
    }

    // 对抗 n 个对手就是跟其中 n 个比
    for (let n = 1; n <= MAX_OPPONENTS; n++) {
      let lost = false;
      let ties = 0;
      for (let o = 0; o < n; o++) {
        if (oppScores[o] > mine) { lost = true; break; }
        if (oppScores[o] === mine) ties++;
      }
      if (!lost) wins[n - 1] += ties === 0 ? 1 : 1 / (ties + 1);
    }
  }

  return wins.map((w) => w / iters);
}

function main() {
  const hands = allHands();
  console.log(`共 ${hands.length} 种起手牌，每种对抗 1~${MAX_OPPONENTS} 个对手，每组 ${ITERS} 次模拟`);
  console.log('开始计算，大概需要 1~3 分钟…\n');

  const out = {};
  const t0 = Date.now();
  let done = 0;

  for (const h of hands) {
    const pool = makeDeck().filter((c) => c !== h.cards[0] && c !== h.cards[1]);
    const row = simulateAll(h.cards, ITERS, pool);
    out[h.key] = row.map((v) => Math.round(v * 1000) / 1000);

    done++;
    if (done % 30 === 0) {
      const pct = ((done / hands.length) * 100).toFixed(0);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${done}/${hands.length} (${pct}%) 已用 ${secs}s`);
    }
  }

  // 按强度排序输出，方便肉眼检查
  const sorted = Object.entries(out).sort((a, b) => b[1][0] - a[1][0]);

  const lines = [];
  lines.push("'use strict';");
  lines.push('');
  lines.push('// 自动生成，请勿手改。');
  lines.push('// 重新生成的命令：node tools/gen-preflop.js');
  lines.push('//');
  lines.push('// 格式：起手牌 -> [vs1人, vs2人, vs3人, vs4人, vs5人] 的胜率');
  lines.push('// 数值是「对随机手牌」的胜率，用来给 AI 做翻牌前决策。');
  lines.push('');
  lines.push('module.exports = {');
  for (const [key, row] of sorted) {
    // 键要加引号，否则 97s / 54o 这类以数字开头的键是非法标识符
    lines.push(`  '${key}': [${row.map((v) => v.toFixed(3)).join(', ')}],`);
  }
  lines.push('};');
  lines.push('');

  const target = path.join(__dirname, '..', 'src', 'preflop-table.js');
  fs.writeFileSync(target, lines.join('\n'), 'utf8');

  console.log(`\n已写入 ${target}`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  console.log(`\n最强的 5 手：${sorted.slice(0, 5).map(([k, v]) => `${k}(${v[0]})`).join('  ')}`);
  console.log(`最弱的 3 手：${sorted.slice(-3).map(([k, v]) => `${k}(${v[0]})`).join('  ')}`);
}

main();
