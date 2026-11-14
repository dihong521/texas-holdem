'use strict';

// 牌用两个字符表示：点数 + 花色，例如 "As"、"Th"、"2c"
// 点数：2 3 4 5 6 7 8 9 T J Q K A
// 花色：s 黑桃 h 红心 d 方块 c 梅花
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) deck.push(r + s);
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rankVal(card) {
  return RANKS.indexOf(card[0]) + 2;
}

function suitOf(card) {
  return card[1];
}

// 预生成 7 选 5 的 21 种组合索引
const C7 = (() => {
  const out = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

// 评估 5 张牌，返回可比较的整数（越大越强）
function evaluate5(cards) {
  const ranks = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniq = [...counts.keys()].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // A2345
  }

  let cat, tie;
  if (isFlush && straightHigh) {
    cat = 8; tie = [straightHigh];
  } else if (groups[0][1] === 4) {
    cat = 7; tie = [groups[0][0], groups[1][0]];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    cat = 6; tie = [groups[0][0], groups[1][0]];
  } else if (isFlush) {
    cat = 5; tie = ranks;
  } else if (straightHigh) {
    cat = 4; tie = [straightHigh];
  } else if (groups[0][1] === 3) {
    cat = 3; tie = [groups[0][0], ...groups.slice(1).map(g => g[0])];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    cat = 2; tie = [groups[0][0], groups[1][0], groups[2][0]];
  } else if (groups[0][1] === 2) {
    cat = 1; tie = [groups[0][0], ...groups.slice(1).map(g => g[0])];
  } else {
    cat = 0; tie = ranks;
  }

  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (tie[i] || 0);
  return v;
}

// 评估 5~7 张牌，取最优 5 张
function evaluate(cards) {
  if (cards.length === 5) return evaluate5(cards);
  let best = -1;
  for (const idx of C7) {
    const v = evaluate5([cards[idx[0]], cards[idx[1]], cards[idx[2]], cards[idx[3]], cards[idx[4]]]);
    if (v > best) best = v;
  }
  return best;
}

// 从 5~7 张牌里挑出最强的 5 张，返回具体的牌，用于展示"成牌"
function bestFive(cards) {
  if (cards.length <= 5) return cards.slice();

  const n = cards.length;
  let best = -1;
  let bestCards = null;

  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const set = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const v = evaluate5(set);
            if (v > best) { best = v; bestCards = set; }
          }

  return bestCards;
}

const CAT_NAMES = [
  '高牌', '一对', '两对', '三条', '顺子',
  '同花', '葫芦', '四条', '同花顺'
];

// 把评估值翻译成人话，用于摊牌显示
function describe(value) {
  const cat = Math.floor(value / 15 ** 5);
  return CAT_NAMES[cat] || '未知';
}

// 花色中文名
const SUIT_CN = { s: '♠', h: '♥', d: '♦', c: '♣' };

module.exports = {
  RANKS, SUITS, makeDeck, shuffle, rankVal, suitOf,
  evaluate, evaluate5, bestFive, describe, SUIT_CN
};
