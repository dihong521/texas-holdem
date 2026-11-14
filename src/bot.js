'use strict';

const { makeDeck, evaluate } = require('./cards');
const PREFLOP = require('./preflop-table');

const RANKS = '23456789TJQKA';

/**
 * 蒙特卡洛胜率估算（翻牌后使用）。
 * 已知自己的底牌和公共牌，随机补全对手底牌和剩余公共牌，跑 N 次统计胜率。
 */
function equity(hole, community, opponentCount, iters = 300) {
  if (opponentCount <= 0) return 1;

  const known = new Set([...hole, ...community]);
  const pool = makeDeck().filter(c => !known.has(c));

  const needBoard = 5 - community.length;
  const need = needBoard + opponentCount * 2;

  const mine7 = new Array(7);
  const opp7 = new Array(7);

  // 已经发出来的公共牌在整轮模拟里不变，先填好
  for (let k = 0; k < community.length; k++) {
    mine7[k] = community[k];
    opp7[k] = community[k];
  }
  mine7[5] = hole[0];
  mine7[6] = hole[1];

  let score = 0;

  for (let it = 0; it < iters; it++) {
    // 部分洗牌：只需要前 need 张
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }

    // 把公共牌补到 5 张
    for (let k = community.length; k < 5; k++) {
      const c = pool[k - community.length];
      mine7[k] = c;
      opp7[k] = c;
    }

    const mine = evaluate(mine7);

    let best = mine;
    let ties = 0;
    let lost = false;

    for (let o = 0; o < opponentCount; o++) {
      opp7[5] = pool[needBoard + o * 2];
      opp7[6] = pool[needBoard + o * 2 + 1];
      const s = evaluate(opp7);
      if (s > best) { lost = true; break; }
      if (s === best) ties++;
    }

    if (lost) continue;
    score += ties === 0 ? 1 : 1 / (ties + 1);
  }

  return score / iters;
}

// ---------- 翻牌前查表 ----------

function tableKey(hole) {
  const a = hole[0];
  const b = hole[1];
  const ra = RANKS.indexOf(a[0]);
  const rb = RANKS.indexOf(b[0]);

  const hi = ra >= rb ? a : b;
  const lo = ra >= rb ? b : a;

  if (hi[0] === lo[0]) return hi[0] + lo[0];
  return hi[0] + lo[0] + (hi[1] === lo[1] ? 's' : 'o');
}

// 翻牌前直接从预生成的表里查，避免在热路径上跑蒙特卡洛
function preflopEquity(hole, opponents) {
  const row = PREFLOP[tableKey(hole)];
  if (!row) return 1 / (opponents + 1);
  const n = Math.max(1, Math.min(row.length, opponents));
  return row[n - 1];
}

// ---------- 对手建模 ----------

const NEUTRAL = { vpip: 0.36, raiseRate: 0.14, conf: 0 };

/**
 * 从对手的历史统计里推断打法风格。
 * 样本太少时向中性值收缩，避免几手牌就下结论。
 */
function profileOf(stats) {
  if (!stats || !stats.hands) return NEUTRAL;

  const n = stats.hands;
  const conf = Math.min(1, n / 20);          // 20 手才完全相信
  const vpip = stats.vpip / n;
  const raiseRate = stats.betsRaises / n;

  return {
    vpip: NEUTRAL.vpip + (vpip - NEUTRAL.vpip) * conf,
    raiseRate: NEUTRAL.raiseRate + (raiseRate - NEUTRAL.raiseRate) * conf,
    conf,
    hands: n,
  };
}

/**
 * 面对下注时，把「对手随机手牌」的假设修正掉。
 *
 * 核心思路：对手主动加注说明他的牌比随机手牌强得多。
 * 越是紧的玩家加注，越应该压低自己的胜率。
 *
 * 返回 1.0 表示不调整，越大表示越应该调低胜率。
 */
function pressureFactor({ street, raiser, raisesThisStreet, allIn }) {
  const STREET_W = { preflop: 0.20, flop: 0.28, turn: 0.34, river: 0.40 };
  const base = STREET_W[street] ?? 0.4;

  const prof = profileOf(raiser && raiser.stats);

  // vpip 0.20（紧）→ 1.35 倍可信；vpip 0.60（松）→ 0.7 倍可信
  const tighten = Math.max(0.55, Math.min(1.6, 0.32 / Math.max(0.12, prof.vpip)) * 0.5 + 0.5);

  // 样本少的时候别过度相信
  const trust = 0.6 + 0.4 * prof.conf;

  const perRaise = base * tighten * trust;

  // 多次加注叠加，但每多一次权重递减：1 + 0.55 + 0.3 + ...
  let extra = 0;
  let weight = 1;
  for (let i = 0; i < raisesThisStreet; i++) {
    extra += perRaise * weight;
    weight *= 0.55;
  }

  let f = 1 + extra;

  if (allIn) f += base * 0.6;

  return Math.max(1, f);
}

// 把胜率按压力系数压低：1 - (1-eq)*f
function adjustEquity(eq, factor) {
  const v = 1 - (1 - eq) * factor;
  return Math.max(0, Math.min(1, v));
}

// ---------- 决策 ----------

/**
 * AI 决策。
 * view: {
 *   player, toCall, pot, opponentCount, currentBet, minRaiseTo, maxRaiseTo,
 *   street, community, raiser, raisesThisStreet
 * }
 * 返回 { action: 'fold'|'check'|'call'|'raise', amount?(raise 到多少) }
 */
function decide(view) {
  const {
    player, toCall, pot, opponentCount, currentBet,
    minRaiseTo, maxRaiseTo, street, raisesThisStreet = 0,
  } = view;

  const live = Math.max(1, opponentCount);

  // ---- 基准胜率 ----
  const rawEquity = street === 'preflop'
    ? preflopEquity(player.hole, live)
    : equity(player.hole, view.community, live, street === 'flop' ? 350 : 450);

  // ---- 对手加注带来的压力修正 ----
  const allIn = toCall >= player.chips;
  const pressure = toCall > 0
    ? pressureFactor({ street, raiser: view.raiser, raisesThisStreet, allIn })
    : 1;

  const eq = toCall > 0 ? adjustEquity(rawEquity, pressure) : rawEquity;

  const r = Math.random();
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  // ---- 翻牌前用查表的硬指标，动作更干脆 ----
  if (street === 'preflop') {
    return decidePreflop({
      player, toCall, pot, rawEquity, eq, r, potOdds,
      minRaiseTo, maxRaiseTo, currentBet, raisesThisStreet,
    });
  }

  return decidePostflop({
    player, toCall, pot, eq, r, potOdds,
    minRaiseTo, maxRaiseTo, currentBet, raisesThisStreet,
  });
}

function makeRaise(player, currentBet, pot, fraction, minRaiseTo, maxRaiseTo) {
  const target = currentBet + Math.round(Math.max(pot * fraction, minRaiseTo - currentBet));
  return Math.min(Math.max(target, minRaiseTo), maxRaiseTo);
}

function decidePreflop({ player, toCall, pot, rawEquity, eq, r, potOdds,
                        minRaiseTo, maxRaiseTo, currentBet, raisesThisStreet }) {
  const canRaise = maxRaiseTo > currentBet;

  // 一路弃牌到我，按手牌绝对值开牌；越后面位置越松一点
  if (currentBet <= 0 || toCall === 0) {
    if (rawEquity > 0.72 && canRaise && r < 0.85) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.8, minRaiseTo, maxRaiseTo) };
    }
    if (rawEquity > 0.58 && canRaise && r < 0.55) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.55, minRaiseTo, maxRaiseTo) };
    }
    return { action: 'check' };
  }

  // 面对加注：只用能扛住加注的牌继续
  const bigBlindCall = Math.max(1, toCall);

  if (raisesThisStreet >= 2) {
    // 已经 3-bet 了，只有很强的牌才接，否则弃
    if (eq > 0.62 && canRaise && r < 0.35) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.9, minRaiseTo, maxRaiseTo) };
    }
    if (eq > potOdds + 0.05) return { action: 'call' };
    return { action: 'fold' };
  }

  if (eq > 0.68 && canRaise && r < 0.6) {
    return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.95, minRaiseTo, maxRaiseTo) };
  }

  // 跟注门槛用「赔率的 95%」而不是「赔率 + 固定值」：
  // 隐含赔率（后面还能赢更多）大致能补上这点差距
  if (eq > potOdds * 0.95) {
    if (eq > 0.58 && canRaise && r < 0.45) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.7, minRaiseTo, maxRaiseTo) };
    }
    return { action: 'call' };
  }

  // 便宜的跟注（比如只补盲注）再宽一点
  if (toCall <= bigBlindCall * 0.7 && eq > 0.30 && r < 0.6) {
    return { action: 'call' };
  }

  return { action: 'fold' };
}

function decidePostflop({ player, toCall, pot, eq, r, potOdds,
                         minRaiseTo, maxRaiseTo, currentBet, raisesThisStreet }) {
  const canRaise = maxRaiseTo > currentBet;

  if (toCall <= 0) {
    // 没人下注：可以过牌或主动下注
    if (eq > 0.78 && canRaise && r < 0.88) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.75, minRaiseTo, maxRaiseTo) };
    }
    if (eq > 0.62 && canRaise && r < 0.62) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.55, minRaiseTo, maxRaiseTo) };
    }
    if (r < 0.13 && canRaise) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.45, minRaiseTo, maxRaiseTo) };
    }
    return { action: 'check' };
  }

  // 需要跟注
  if (eq > 0.78 && canRaise && r < 0.55) {
    return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.85, minRaiseTo, maxRaiseTo) };
  }
  if (eq > potOdds + 0.02) {
    if (eq > 0.66 && canRaise && r < 0.25) {
      return { action: 'raise', amount: makeRaise(player, currentBet, pot, 0.65, minRaiseTo, maxRaiseTo) };
    }
    return { action: 'call' };
  }
  // 赔率差一点，偶尔用听牌跟一下
  if (eq > potOdds * 0.76 && r < 0.11) return { action: 'call' };

  return { action: 'fold' };
}

// 给前端的简短风格标签
function styleLabel(stats) {
  if (!stats || stats.hands < 6) return null;

  const vpip = stats.vpip / stats.hands;
  const raise = stats.betsRaises / stats.hands;

  if (vpip < 0.22) return '紧';
  if (vpip > 0.55) return raise > 0.2 ? '凶' : '松';
  if (raise > 0.25) return '凶';
  return null;
}

module.exports = {
  decide, equity, preflopEquity, tableKey,
  profileOf, pressureFactor, adjustEquity, styleLabel,
};
