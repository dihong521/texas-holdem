'use strict';

const { evaluate, describe, makeDeck } = require('../src/cards');
const { Room } = require('../src/room');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    console.log('  \x1b[31m✗\x1b[0m ' + name + '  →  ' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function cards(s) {
  return s.split(' ');
}

console.log('\n【1】牌型判断');

check('皇家同花顺 > 四条', () => {
  const royal = evaluate(cards('As Ks Qs Js Ts'));
  const quads = evaluate(cards('Ah Ad Ac As Kh'));
  assert(royal > quads, '同花顺应大于四条');
  assert(describe(royal) === '同花顺', '皇家同花顺应识别为同花顺');
});

check('葫芦 > 同花 > 顺子', () => {
  const fh = evaluate(cards('Kh Kd Kc 2s 2d'));
  const fl = evaluate(cards('Ah Jh 8h 5h 2h'));
  const st = evaluate(cards('9c 8d 7h 6s 5c'));
  assert(fh > fl && fl > st, '葫芦>同花>顺子');
});

check('A2345 是顺子（轮子）', () => {
  const wheel = evaluate(cards('Ac 2d 3h 4s 5c'));
  const six = evaluate(cards('2c 3d 4h 5s 6c'));
  assert(describe(wheel) === '顺子', 'A2345 应识别为顺子');
  assert(six > wheel, '23456 应大于 A2345（5 高顺 vs 6 高顺）');
});

check('两对 > 一对 > 高牌', () => {
  const twoPair = evaluate(cards('Jh Jd 4c 4s Ac'));
  const onePair = evaluate(cards('Th Td As 7c 3h'));
  const high = evaluate(cards('Ah Kd 9c 6s 3d'));
  assert(twoPair > onePair && onePair > high, '两对>一对>高牌');
});

check('踢脚牌比较', () => {
  const a = evaluate(cards('Ah Ad Ks 7c 3h'));
  const b = evaluate(cards('As Ac Qs 7c 3h'));
  assert(a > b, 'AA+K 应大于 AA+Q');
});

check('7 选 5 取最优', () => {
  // 有同花顺的组合在 7 张里
  const v = evaluate(cards('As Ks Qs Js Ts 2d 3c'));
  assert(describe(v) === '同花顺', '应能跳出 7 张中的同花顺');
});

check('一副牌 52 张不重复', () => {
  const d = makeDeck();
  assert(d.length === 52, '牌数应为 52');
  assert(new Set(d).size === 52, '不应有重复牌');
});

console.log('\n【2】边池分配');

function makePlayer(seat, name, totalBet, hole, folded) {
  return {
    id: name, name, seat, chips: 0, hole, folded: !!folded,
    allIn: true, bet: 0, totalBet, hasActed: true, connected: true, isAI: true,
  };
}

check('主池 + 边池：AA 全下最多，应拿走全部', () => {
  const room = new Room('t');
  room.dealerSeat = 0;
  room.community = cards('2s 5h 9c Js 3d');
  const a = makePlayer(0, 'A', 100, cards('As Ad'));
  const b = makePlayer(1, 'B', 100, cards('Ks Kd'));
  const c = makePlayer(2, 'C', 50, cards('7s 2d'));
  room.seats = [a, b, c, null, null, null];
  room.pot = 250;

  a.chips = 0; b.chips = 0; c.chips = 0;
  const evals = new Map();
  for (const p of [a, b, c]) evals.set(p.id, evaluate([...p.hole, ...room.community]));
  const winners = room.distribute(evals);

  const total = a.chips + b.chips + c.chips;
  assert(total === 250, `筹码总数应为 250，实际 ${total}`);
  assert(a.chips === 250, `AA 应赢 250，实际 ${a.chips}`);
  assert(winners.length === 1 && winners[0].name === 'A', '赢家应为 A');
});

check('边池：短筹码只能赢主池', () => {
  const room = new Room('t');
  room.dealerSeat = 0;
  room.community = cards('2s 5h 9c Js 3d');
  // C 只有 50，牌却最强；只能拿主池
  const a = makePlayer(0, 'A', 100, cards('As Ad'));
  const b = makePlayer(1, 'B', 100, cards('Ks Kd'));
  const c = makePlayer(2, 'C', 50, cards('3c 3d'));
  room.seats = [a, b, c, null, null, null];
  room.pot = 250;
  a.chips = 0; b.chips = 0; c.chips = 0;

  const evals = new Map();
  for (const p of [a, b, c]) evals.set(p.id, evaluate([...p.hole, ...room.community]));
  room.distribute(evals);

  assert(a.chips + b.chips + c.chips === 250, '筹码总数应为 250');
  assert(c.chips === 150, `C 应赢主池 150，实际 ${c.chips}`);
  assert(a.chips === 100, `A 应赢边池 100，实际 ${a.chips}`);
});

check('平局均分，总数不变', () => {
  const room = new Room('t');
  room.dealerSeat = 0;
  room.community = cards('Ah Kh Qh Jh Th');
  const a = makePlayer(0, 'A', 100, cards('2s 3d'));
  const b = makePlayer(1, 'B', 100, cards('2c 4d'));
  room.seats = [a, b, null, null, null, null];
  room.pot = 200;
  a.chips = 0; b.chips = 0;

  const evals = new Map();
  for (const p of [a, b]) evals.set(p.id, evaluate([...p.hole, ...room.community]));
  room.distribute(evals);

  assert(a.chips + b.chips === 200, '平局后总数应为 200');
  assert(a.chips === 100 && b.chips === 100, '应各得 100');
});

check('未被跟注的下注应退回', () => {
  const room = new Room('t');
  const a = makePlayer(0, 'A', 300, cards('As Ad'));
  const b = makePlayer(1, 'B', 200, cards('Ks Kd'));
  room.seats = [a, b, null, null, null, null];
  room.pot = 500;
  a.chips = 0; b.chips = 0;

  room.refundUncalled();
  assert(a.chips === 100, `A 应退回 100，实际 ${a.chips}`);
  assert(a.totalBet === 200, 'A 的投入应调整为 200');
  assert(room.pot === 400, `底池应为 400，实际 ${room.pot}`);
});

console.log('\n【3】完整牌局模拟（真实 AI）');

function makeRoom(n) {
  const room = new Room('test');
  room.scheduleActor = () => {};
  room.scheduleNextHand = () => {};
  room.broadcast = () => {};
  // 至少留一个真人，否则「没有真人就解散」会直接清空房间
  for (let i = 0; i < n; i++) room.addPlayer('P' + i, i !== 0);
  return room;
}

function playHand(room) {
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && room.phase !== 'waiting') {
    if (++guard > 4000) throw new Error('牌局没有结束，疑似死循环');
    if (room.actorSeat < 0) { room.advanceStreet(); continue; }
    room.botAct(room.actorSeat);
  }
  return guard;
}

check('6 人连打 10 手：不卡死、不出现负筹码、筹码守恒', () => {
  const room = makeRoom(6);
  const hands = 10;
  for (let h = 0; h < hands; h++) {
    for (const p of room.seats) if (p) p.chips = 1000; // 固定初始筹码，方便核对守恒
    playHand(room);

    let total = 0;
    for (const p of room.seats) {
      if (!p) continue;
      assert(p.chips >= 0, `${p.name} 出现负筹码 ${p.chips}`);
      total += p.chips;
    }
    assert(total === 6000, `第 ${h + 1} 手结束后筹码总额 ${total} ≠ 6000`);
    assert(room.pot === 0, `第 ${h + 1} 手结束后底池应为 0，实际 ${room.pot}`);
  }
});

check('2 人单挑 10 手', () => {
  const room = makeRoom(2);
  for (let h = 0; h < 10; h++) {
    for (const p of room.seats) if (p) p.chips = 1000;
    playHand(room);
    const total = room.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0);
    assert(total === 2000, `单挑筹码总额应为 2000，实际 ${total}`);
  }
});

check('底牌只对本人可见，别人是背面', () => {
  const room = makeRoom(3);
  room.startHand();
  const meId = room.seats[0].id;

  const mine = room.snapshot(meId);
  const s0 = mine.seats[0];
  assert(s0.hole.length === 2 && s0.hole[0] !== '??', '自己应看到真实底牌');

  const s1 = mine.seats[1];
  assert(s1.hole[0] === '??', '别人的底牌必须是背面');

  const other = room.snapshot(room.seats[1].id);
  assert(other.seats[1].hole[0] !== '??', '另一个玩家自己也应看到自己的牌');
  assert(other.seats[0].hole[0] === '??', '从别人视角看我的牌也是背面');
});

check('庄家轮流', () => {
  const room = makeRoom(3);
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    for (const p of room.seats) if (p) p.chips = 1000;
    room.startHand();
    seen.add(room.dealerSeat);
    let guard = 0;
    while (room.phase !== 'showdown' && guard++ < 4000) {
      if (room.actorSeat < 0) room.advanceStreet();
      else room.botAct(room.actorSeat);
    }
  }
  assert(seen.size === 3, `6 手内庄家应轮流坐 3 个座位，实际 ${seen.size}`);
});

check('非法动作不打断回合：计时器仍然有效，超时能托管', () => {
  // 这个测试要验证真实的 scheduleActor，所以不能用 makeRoom 把计时器屏蔽掉
  const room = new Room('t');
  room.broadcast = () => {};
  room.scheduleNextHand = () => {};
  room.addPlayer('P0', false);   // 留一个真人，避免触发解散
  room.addPlayer('P1', true);
  room.startHand();

  const seat = room.actorSeat;
  assert(seat >= 0, '应有玩家需要行动');
  assert(room.turnTimer !== null, '开局后应有回合计时器');

  let threw = false;
  try { room.act(seat, 'raise', 1); } catch (e) { threw = true; }
  assert(threw, '非法加注应被拒绝');
  assert(room.actorSeat === seat, '被拒绝后仍应是同一个玩家行动');
  assert(room.turnTimer !== null, '被拒绝后计时器不能丢，否则会卡死');

  room.clearTimers();
});

check('对手全部全下后不允许再加注', () => {
  const room = new Room('t');
  room.phase = 'river';
  const a = makePlayer(0, 'A', 100, cards('As Ad'), false);
  const b = makePlayer(1, 'B', 100, cards('Ks Kd'), false);
  a.allIn = false; a.chips = 500; a.bet = 0;
  b.allIn = true; b.chips = 0; b.bet = 0;
  room.seats = [a, b, null, null, null, null];
  room.currentBet = 100;
  room.actorSeat = 0;

  let threw = false;
  try { room.act(0, 'raise', 300); } catch (e) { threw = true; }
  assert(threw, '对手全下时不应允许加注');
});

console.log('\n【4】操作记录与摊牌结果');

check('每次操作都记录到 lastAction', () => {
  const room = makeRoom(2);
  room.startHand();
  const seat = room.actorSeat;
  const p = room.seats[seat];
  const toCall = room.currentBet - p.bet;
  room.act(seat, toCall > 0 ? 'call' : 'check');

  assert(room.lastAction, '应有 lastAction');
  assert(room.lastAction.seat === seat, '应记录操作者座位');
  assert(room.lastAction.name === p.name, '应记录名字');
  assert(room.lastAction.seq > 0, '应有序号，方便前端判断是不是新动作');
  assert(room.lastAction.text.length > 0, '应有操作描述');
});

check('lastAction 序号递增', () => {
  const room = makeRoom(3);
  room.startHand();
  let guard = 0;
  const seqs = [];
  while (room.phase !== 'showdown' && guard++ < 500) {
    const before = room.actionSeq;
    if (room.actorSeat < 0) { room.advanceStreet(); continue; }
    room.botAct(room.actorSeat);
    if (room.actionSeq !== before) seqs.push(room.actionSeq);
  }
  assert(seqs.length > 0, '应有操作记录');
  for (let i = 1; i < seqs.length; i++) {
    assert(seqs[i] > seqs[i - 1], '序号必须单调递增');
  }
});

check('摊牌结果按牌力排序，赢家在最上面', () => {
  const room = makeRoom(4);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 2000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }

  if (room.result) {
    const rows = room.result.rows;
    const shown = rows.filter((r) => !r.folded);
    const folded = rows.filter((r) => r.folded);

    // 亮牌的全部排在弃牌前面
    if (shown.length && folded.length) {
      const lastShownIdx = rows.findIndex((r) => r.folded) - 1;
      assert(lastShownIdx >= shown.length - 1, '亮牌的应排在弃牌之前');
    }
    // 亮牌的按牌力从高到低
    for (let i = 1; i < shown.length; i++) {
      assert(shown[i - 1].score >= shown[i].score, '亮牌的必须按牌力降序');
    }
    // 赢家金额为正，其余为 0 或正（分边池时可能多人赢）
    const totalWon = rows.reduce((s, r) => s + r.won, 0);
    assert(totalWon === room.result.pot, `赢家金额合计 ${totalWon} 应等于底池 ${room.result.pot}`);
    assert(rows[0].won > 0, '第一名必须是赢家');
  }
});

check('摊牌后不自动开下一手，等房主点', () => {
  const room = makeRoom(3);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 2000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }
  assert(room.awaitingNext === true, '摊牌后应等着开始下一手');
  assert(room.nextHandTimer === null, '不应再有自动开局计时器');
});

check('只有房主能开始下一手', () => {
  const room = makeRoom(3);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 2000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }

  const nonHost = room.seats.find((p) => p && p.id !== room.hostId).id;
  let threw = false;
  try { room.startNextHand(nonHost); } catch (e) { threw = true; }
  assert(threw, '非房主不应能开始下一手');

  const handBefore = room.handNo;
  room.startNextHand(room.hostId);
  assert(room.handNo === handBefore + 1, '房主点击后应开始新的手');
  room.clearTimers();
});

console.log('\n【5】筹码不足出局');

check('筹码低于一个大盲会被踢出', () => {
  const room = makeRoom(3);
  room.seats[1].chips = 15; // 低于大盲 20
  room.startHand();

  const busted = room.seats[1];
  assert(busted === null, '筹码不足的玩家应已离座');
  assert(room.eliminated.size === 0, 'AI 出局不记入真人淘汰名单');
});

check('真人被淘汰后重新入座恢复 1 万筹码', () => {
  const room = new Room('t');
  room.broadcast = () => {};
  room.scheduleActor = () => {};
  room.scheduleNextHand = () => {};
  const p1 = room.addPlayer('真人甲', false, 'human-1');
  const p2 = room.addPlayer('真人乙', false, 'human-2');

  room.seats[0].chips = 5;
  room.startHand();

  assert(!room.seats.some((p) => p && p.id === 'human-1'), '筹码不足应被移出座位');
  assert(room.eliminated.has('human-1'), '应记入淘汰名单');

  const back = room.addPlayer('真人甲', false, 'human-1');
  assert(back, '应能重新入座');
  assert(back.chips === room.buyIn, `重新入座筹码应为 ${room.buyIn}`);
  assert(room.buyIn === 10000, '初始筹码应为 1 万');
  assert(!room.eliminated.has('human-1'), '重新入座后应清除淘汰标记');
});

check('房主离开后交接给下一个真人', () => {
  const room = new Room('t');
  room.broadcast = () => {};
  room.scheduleActor = () => {};
  const a = room.addPlayer('甲', false, 'h1');
  const b = room.addPlayer('乙', false, 'h2');
  const c = room.addPlayer('丙', false, 'h3');

  assert(room.hostId === a.id, '第一个进来的是房主');
  room.removePlayer(a.id);
  assert(room.hostId === b.id, `房主应交给乙，实际 ${room.hostId}`);

  room.removePlayer(b.id);
  assert(room.hostId === c.id, '房主应交给丙');
});

check('没有真人后房间解散', () => {
  const room = new Room('t');
  room.broadcast = () => {};
  room.scheduleActor = () => {};
  const a = room.addPlayer('甲', false, 'h1');
  room.addPlayer('乙', false, 'h2');
  room.addAI();

  room.removePlayer('h1');
  assert(!room.dissolved, '还有真人时不应解散');

  room.removePlayer('h2');
  assert(room.dissolved, '真人走光后应解散');
  assert(room.phase === 'closed', '解散后阶段应为 closed');
  assert(room.seats.every((p) => p === null), '解散后座位应清空');
});

check('房间解散后不能再加入', () => {
  const room = new Room('t');
  room.broadcast = () => {};
  const a = room.addPlayer('甲', false, 'h1');
  room.removePlayer('h1');
  assert(room.dissolved, '应已解散');
  assert(room.addPlayer('乙', false, 'h2') === null, '解散后不应再接受加入');
});

console.log('\n【6】结算面板：底牌与成牌');

check('bestFive 从 7 张里挑出正确的 5 张', () => {
  const { bestFive } = require('../src/cards');
  const made = bestFive(cards('As Ks Qs Js Ts 2d 3c'));
  assert(describe(evaluate(made)) === '同花顺', `应挑出同花顺，实际 ${describe(evaluate(made))}`);
  assert(made.length === 5, '应返回 5 张');
  assert(made.includes('As') && made.includes('Ts'), '应包含 As 和 Ts');
});

check('结算面板里别人弃牌的底牌仍然是背面', () => {
  const room = makeRoom(4);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 3000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }

  const someone = room.seats.find((p) => p);
  const view = room.snapshot(someone.id);
  const others = view.result.rows.filter((r) => !r.isMine && r.folded);

  for (const r of others) {
    if (r.hole.length) {
      assert(r.hole[0] === '??', `弃牌玩家 ${r.name} 的底牌不应被别人看到`);
    }
  }
});

check('结算面板里自己能看到自己的底牌和成牌', () => {
  const room = makeRoom(4);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 3000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }

  for (const p of room.seats.filter(Boolean)) {
    const view = room.snapshot(p.id);
    const mine = view.result.rows.find((r) => r.isMine);
    assert(mine, `${p.name} 应该能在结果里找到自己`);
    assert(mine.hole[0] !== '??', '自己的底牌必须可见');
    if (room.community.length >= 3) {
      assert(mine.madeHand.length === 5, `成牌应有 5 张，实际 ${mine.madeHand.length}`);
    }
  }
});

check('亮牌玩家的成牌对所有人生效', () => {
  const room = makeRoom(3);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 3000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }

  const viewer = room.seats.find((p) => p);
  const view = room.snapshot(viewer.id);
  // 只有真正摊牌的玩家才亮牌；其他人全部弃牌时不亮
  const shown = view.result.rows.filter((r) => !r.folded && r.handName && !r.isMine);

  for (const r of shown) {
    assert(r.hole[0] !== '??', `${r.name} 已亮牌，底牌应可见`);
    assert(r.madeHand.length === 5, `${r.name} 的成牌应有 5 张`);
  }
});

console.log('\n【7】翻牌前查表与对手建模');

check('查表覆盖全部 169 种起手牌', () => {
  const table = require('../src/preflop-table');
  const keys = Object.keys(table);
  assert(keys.length === 169, `应有 169 种，实际 ${keys.length}`);

  // 对子 13 种
  const pairs = keys.filter((k) => k.length === 2);
  assert(pairs.length === 13, `对子应有 13 种，实际 ${pairs.length}`);

  // 同花 78 + 非同花 78
  const suited = keys.filter((k) => k.endsWith('s'));
  const offsuit = keys.filter((k) => k.endsWith('o'));
  assert(suited.length === 78 && offsuit.length === 78, `同花/非同花应各 78，实际 ${suited.length}/${offsuit.length}`);
});

check('查表数值单调合理：AA > KK > QQ > 72o', () => {
  const t = require('../src/preflop-table');
  assert(t['AA'][0] > t['KK'][0], 'AA 应强于 KK');
  assert(t['KK'][0] > t['QQ'][0], 'KK 应强于 QQ');
  assert(t['QQ'][0] > t['AKs'][0], 'QQ 应强于 AKs');
  assert(t['AKs'][0] > t['72o'][0], 'AKs 应强于 72o');
  assert(t['AA'][0] > 0.80 && t['AA'][0] < 0.90, `AA 单挑胜率应在 80~90%，实际 ${t['AA'][0]}`);
});

check('对手越多，胜率越低', () => {
  const t = require('../src/preflop-table');
  for (const key of ['AA', 'AKs', '72o']) {
    const row = t[key];
    for (let i = 1; i < row.length; i++) {
      assert(row[i] < row[i - 1], `${key} 对抗 ${i + 1} 人应低于对抗 ${i} 人`);
    }
  }
});

check('查表和蒙特卡洛结果接近', () => {
  const bot = require('../src/bot');
  const cases = [
    [['As', 'Ad'], 1],
    [['Ks', 'Kd'], 1],
    [['As', 'Ks'], 1],
    [['7s', '2d'], 1],
  ];
  for (const [hole, opp] of cases) {
    const fromTable = bot.preflopEquity(hole, opp);
    const fromSim = bot.equity(hole, [], opp, 3000);
    const diff = Math.abs(fromTable - fromSim);
    assert(diff < 0.03, `${hole.join('')} 查表 ${fromTable} 与模拟 ${fromSim} 差太多`);
  }
});

check('紧玩家的加注比松玩家更受尊重', () => {
  const bot = require('../src/bot');
  const tight = { stats: { hands: 30, vpip: 4, betsRaises: 2 } };
  const loose = { stats: { hands: 30, vpip: 22, betsRaises: 10 } };

  const fTight = bot.pressureFactor({ street: 'flop', raiser: tight, raisesThisStreet: 1 });
  const fLoose = bot.pressureFactor({ street: 'flop', raiser: loose, raisesThisStreet: 1 });

  assert(fTight > fLoose, '紧玩家加注的压力系数应更高');

  const eq = 0.55;
  assert(bot.adjustEquity(eq, fTight) < bot.adjustEquity(eq, fLoose),
    '面对紧玩家的加注，修正后胜率应更低');
});

check('样本太少时不会过度解读', () => {
  const bot = require('../src/bot');
  const few = { stats: { hands: 2, vpip: 0, betsRaises: 1 } };
  const f = bot.pressureFactor({ street: 'flop', raiser: few, raisesThisStreet: 1 });
  assert(f > 1 && f < 1.6, `2 手样本的压力系数应温和，实际 ${f}`);
});

check('没有统计数据的对手按中性处理', () => {
  const bot = require('../src/bot');
  const prof = bot.profileOf(null);
  assert(prof.conf === 0, '没数据时置信度应为 0');
  assert(Math.abs(prof.vpip - 0.36) < 0.001, '没数据时按中性 vpip');
});

check('多次加注压力叠加但递减', () => {
  const bot = require('../src/bot');
  const p = { stats: { hands: 30, vpip: 10, betsRaises: 4 } };
  const f1 = bot.pressureFactor({ street: 'turn', raiser: p, raisesThisStreet: 1 });
  const f2 = bot.pressureFactor({ street: 'turn', raiser: p, raisesThisStreet: 2 });
  const f3 = bot.pressureFactor({ street: 'turn', raiser: p, raisesThisStreet: 3 });
  assert(f2 > f1 && f3 > f2, '加注次数越多压力越大');
  assert((f3 - f2) < (f2 - f1), '增量应递减');
});

check('服务端记录了每位玩家的 VPIP 和加注次数', () => {
  const room = makeRoom(4);
  room.startHand();
  let guard = 0;
  while (room.phase !== 'showdown' && guard++ < 3000) {
    if (room.actorSeat < 0) room.advanceStreet();
    else room.botAct(room.actorSeat);
  }

  const played = room.seats.filter((p) => p && p.stats && p.stats.hands > 0);
  assert(played.length >= 2, '应有玩家累计了统计');
  for (const p of played) {
    assert(p.stats.hands >= 1, `${p.name} 应记录手数`);
    assert(p.stats.vpip <= p.stats.hands, 'VPIP 不应超过手数');
    assert(p.stats.betsRaises <= p.stats.hands * 4, '加注次数不应异常');
  }
});

check('AI 决策在翻牌前不再跑蒙特卡洛（速度）', () => {
  const bot = require('../src/bot');
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    bot.preflopEquity(['As', 'Ad'], 3);
  }
  const ms = Date.now() - t0;
  assert(ms < 50, `200 次查表应在 50ms 内完成，实际 ${ms}ms`);
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
