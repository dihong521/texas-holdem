'use strict';

const crypto = require('crypto');
const { makeDeck, shuffle, evaluate, bestFive, describe } = require('./cards');
const bot = require('./bot');

const MAX_SEATS = 6;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const BUY_IN = 10000;                 // 初始买入
const MIN_CHIPS_TO_PLAY = BIG_BLIND;  // 低于这个数就出局
const TURN_MS = 30000;                // 每人思考时间
const AUTO_START_MS = 3000;           // 人数够了自动开第一手
const OFFLINE_GRACE_MS = 3 * 60000;   // 等待阶段掉线多久后清座
const OFFLINE_IN_GAME_MS = 5 * 60000; // 牌局进行中掉线多久后清座
const HOST_GONE_AUTO_START_MS = 60000; // 房主掉线后，等待多久自动开下一手

const AI_NAMES = ['阿法','贝塔','伽马','德尔塔','艾普西龙','泽塔'];

class Room {
  constructor(id) {
    this.id = id;
    this.hostId = null;
    this.seats = new Array(MAX_SEATS).fill(null);

    this.phase = 'waiting';     // waiting | preflop | flop | turn | river | showdown
    this.handNo = 0;
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.lastRaiseSize = BIG_BLIND;
    this.lastRaiserSeat = -1;   // 这条街上最后一次加注的人
    this.raisesThisStreet = 0;  // 这条街上加注了几次
    this.dealerSeat = -1;
    this.actorSeat = -1;
    this.revealed = false;
    this.winners = null;
    this.handNames = {};
    this.log = [];
    this.replenished = 0;       // 累计补充的筹码，用于核对账目

    // 一手结束后的状态
    this.awaitingNext = false;  // 等房主点「开始下一手」
    this.result = null;         // 摊牌结果排名
    this.lastAction = null;     // 最近一次操作，用于前端高亮提示
    this.actionSeq = 0;
    this.dissolved = false;     // 没有真人后房间解散
    this.eliminated = new Set(); // 被淘汰出局的玩家 id

    this.smallBlind = SMALL_BLIND;
    this.bigBlind = BIG_BLIND;
    this.buyIn = BUY_IN;

    this.subscribers = new Map();  // pid -> Set<res>
    this.turnDeadline = null;
    this.nextHandAt = null;
    this.lastActivity = Date.now();

    this.turnTimer = null;
    this.aiTimer = null;
    this.nextHandTimer = null;
    this.createdAt = Date.now();
  }

  // ---------- 基础工具 ----------

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 200) this.log.shift();
  }

  // 记录最近一次操作，前端用它弹出「某某 加注到 300」这类提示
  setAction(p, text) {
    this.lastAction = {
      seat: p.seat,
      name: p.name,
      text,
      at: Date.now(),
      seq: ++this.actionSeq,
    };
    this.addLog(`${p.name} ${text}`);
  }

  clearTimers() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.aiTimer);
    clearTimeout(this.nextHandTimer);
    this.turnTimer = this.aiTimer = this.nextHandTimer = null;
  }

  livePlayers() {
    return this.seats.filter(p => p && !p.folded);
  }

  readyCount() {
    return this.seats.filter(p => p && p.chips > 0).length;
  }

  potSize() {
    let s = this.pot;
    for (const p of this.seats) if (p) s += p.bet;
    return s;
  }

  nextActiveSeat(from) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i) % MAX_SEATS;
      const p = this.seats[s];
      if (p && p.chips > 0 && !p.folded) return s;
    }
    return -1;
  }

  nextActor(from) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i) % MAX_SEATS;
      const p = this.seats[s];
      if (p && !p.folded && !p.allIn) return s;
    }
    return -1;
  }

  minRaiseTo() {
    return this.currentBet === 0
      ? this.bigBlind
      : this.currentBet + this.lastRaiseSize;
  }

  // ---------- 玩家管理 ----------

  addPlayer(name, isAI, pid) {
    if (this.dissolved) return null;
    if (!isAI && pid) {
      const existing = this.seats.find(p => p && p.id === pid);
      if (existing) {
        existing.connected = true;
        existing.disconnectedAt = null;
        this.eliminated.delete(pid);
        this.broadcast();
        return existing;
      }
    }
    const seat = this.seats.indexOf(null);
    if (seat < 0) return null;

    const player = {
      id: pid || crypto.randomUUID(),
      name: (name || '').slice(0, 12) || '无名',
      isAI: !!isAI,
      seat,
      chips: this.buyIn,
      hole: [],
      folded: false,
      allIn: false,
      bet: 0,
      totalBet: 0,
      hasActed: false,
      connected: true,
      disconnectedAt: null,
      // 对手建模用的历史统计：见过几手、入池几次、主动下注/加注几次
      stats: { hands: 0, vpip: 0, betsRaises: 0, seenThisHand: false },
    };
    this.seats[seat] = player;
    this.eliminated.delete(player.id);
    if (!this.hostId) this.hostId = player.id;
    this.addLog(`${player.name} 坐到了 ${seat + 1} 号位`);
    this.maybeAutoStart();
    this.broadcast();
    return player;
  }

  addAI() {
    const used = new Set(this.seats.filter(p => p && p.isAI).map(p => p.name));
    const name = AI_NAMES.find(n => !used.has(n)) || `机器人${used.size + 1}`;
    return this.addPlayer(name, true);
  }

  disconnect(pid) {
    const p = this.seats.find(x => x && x.id === pid);
    if (!p) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    this.broadcast();
  }

  removePlayer(pid) {
    const idx = this.seats.findIndex(p => p && p.id === pid);
    if (idx < 0) return;
    const p = this.seats[idx];
    const wasTurn = this.actorSeat === idx;
    const inHand = this.phase !== 'waiting' && this.phase !== 'showdown' && this.phase !== 'closed';

    this.seats[idx] = null;
    this.addLog(`${p.name} 离开了房间`);
    this.transferHost();

    // 牌局进行中离开，视为弃牌
    if (inHand) {
      p.folded = true;
      if (this.livePlayers().length <= 1) {
        this.finishHand();
        this.checkDissolve();
        this.broadcast();
        return;
      }
      if (wasTurn) {
        if (this.roundComplete()) this.advanceStreet();
        else {
          this.actorSeat = this.nextActor(idx);
          this.scheduleActor();
        }
      }
    }

    if (this.phase === 'waiting') this.maybeAutoStart();
    this.checkDissolve();
    this.broadcast();
  }

  // 房主离开后交给下一个真人；没有真人了就交给人机或置空
  transferHost() {
    if (this.seats.some(p => p && p.id === this.hostId)) return;
    const next = this.seats.find(p => p && !p.isAI) || this.seats.find(p => p);
    this.hostId = next ? next.id : null;
    if (next) this.addLog(`${next.name} 成为新房主`);
  }

  // 房间里一个真人都没有时解散
  checkDissolve() {
    if (this.seats.some(p => p && !p.isAI)) return false;
    this.dissolve();
    return true;
  }

  dissolve() {
    if (this.dissolved) return;
    this.dissolved = true;
    this.clearTimers();
    this.phase = 'closed';
    this.awaitingNext = false;
    this.actorSeat = -1;
    this.turnDeadline = null;
    this.seats.fill(null);
    this.addLog('房间里已经没有真人玩家，房间已解散');
    this.broadcast();
  }

  // 清理长时间掉线的玩家。等待阶段 1 分钟，牌局进行中 5 分钟
  sweep() {
    const now = Date.now();
    const waiting = this.phase === 'waiting';
    const limit = waiting ? OFFLINE_GRACE_MS : OFFLINE_IN_GAME_MS;

    const gone = [];
    for (const p of this.seats) {
      if (!p || p.isAI || p.connected || !p.disconnectedAt) continue;
      if (now - p.disconnectedAt > limit) gone.push(p.id);
    }

    for (const pid of gone) {
      const p = this.seats.find(x => x && x.id === pid);
      if (!p) continue;
      this.addLog(`${p.name} 掉线太久，已移出座位`);
      this.removePlayer(pid);
    }

    // 摊牌后房主一直不点开始（或者房主掉线了），自动开始下一手
    if (this.awaitingNext && !this.dissolved) {
      const host = this.seats.find(p => p && p.id === this.hostId);
      if (!host) {
        this.startHand();
      } else if (!host.isAI && !host.connected && host.disconnectedAt &&
                 now - host.disconnectedAt > HOST_GONE_AUTO_START_MS) {
        this.addLog('房主掉线，自动开始下一手');
        this.startHand();
      }
    }
  }

  // ---------- 开局 ----------

  maybeAutoStart() {
    if (this.phase !== 'waiting') return;
    if (this.nextHandAt) return;
    if (this.dissolved) return;
    if (this.readyCount() >= 2) this.scheduleNextHand(AUTO_START_MS);
  }

  // 等待阶段才有倒计时；摊牌后改由房主手动点「开始下一手」
  scheduleNextHand(delay = AUTO_START_MS) {
    if (this.nextHandTimer) return;
    this.nextHandAt = Date.now() + delay;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.nextHandAt = null;
      this.startHand();
    }, delay);
    if (this.nextHandTimer.unref) this.nextHandTimer.unref();
    this.broadcast();
  }

  // 筹码低于一个大盲就出局，回到大厅
  bustOut(p) {
    const idx = this.seats.findIndex(x => x && x.id === p.id);
    if (idx < 0) return;
    this.seats[idx] = null;
    if (!p.isAI) this.eliminated.add(p.id);
    this.addLog(`${p.name} 筹码不足 ${MIN_CHIPS_TO_PLAY}，已出局`);
    this.transferHost();
  }

  // 牌局回到等待状态（人数不够或房间刚建好）
  toWaiting(reason) {
    this.clearTimers();
    this.phase = 'waiting';
    this.actorSeat = -1;
    this.turnDeadline = null;
    this.pot = 0;
    this.community = [];
    this.currentBet = 0;
    this.awaitingNext = false;
    this.result = null;
    this.lastAction = null;
    this.nextHandAt = null;
    for (const p of this.seats) {
      if (!p) continue;
      p.hole = []; p.bet = 0; p.totalBet = 0;
      p.folded = false; p.allIn = false; p.hasActed = false;
    }
    if (reason) this.addLog(reason);
    this.maybeAutoStart();
    this.broadcast();
  }

  // 房主点击「开始下一手」
  startNextHand(pid) {
    if (this.dissolved) throw new Error('房间已解散');
    if (this.phase !== 'showdown' || !this.awaitingNext) throw new Error('现在不能开始下一手');
    if (pid !== this.hostId) throw new Error('只有房主可以开始下一手');
    this.startHand();
  }

  startHand() {
    this.clearTimers();
    this.nextHandAt = null;
    if (this.dissolved) return;

    // 上一手结束后没有筹码的玩家出局
    for (const p of [...this.seats]) {
      if (p && p.chips < MIN_CHIPS_TO_PLAY) this.bustOut(p);
    }

    if (this.checkDissolve()) return;

    const activeSeats = [];
    this.seats.forEach((p, i) => { if (p && p.chips >= MIN_CHIPS_TO_PLAY) activeSeats.push(i); });

    if (activeSeats.length < 2) {
      this.toWaiting('人数不足，等待更多玩家');
      return;
    }

    this.awaitingNext = false;
    this.result = null;
    this.handNo++;
    this.deck = shuffle(makeDeck());
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.revealed = false;
    this.winners = null;
    this.handNames = {};
    this.lastAction = null;

    for (const p of this.seats) {
      if (!p) continue;
      p.hole = []; p.bet = 0; p.totalBet = 0;
      p.folded = false; p.allIn = false; p.hasActed = false;
    }

    // 新手开始，统计每个参战的人「见过一手」
    for (const s of activeSeats) {
      const p = this.seats[s];
      if (!p.stats) p.stats = { hands: 0, vpip: 0, betsRaises: 0, seenThisHand: false };
      p.stats.hands++;
      p.stats.seenThisHand = false;
    }

    this.dealerSeat = this.nextActiveSeat(this.dealerSeat);

    // 一人一张地发
    for (let r = 0; r < 2; r++) {
      for (const s of activeSeats) this.seats[s].hole.push(this.deck.pop());
    }

    let sbSeat, bbSeat;
    if (activeSeats.length === 2) {
      sbSeat = this.dealerSeat;
      bbSeat = this.nextActiveSeat(this.dealerSeat);
    } else {
      sbSeat = this.nextActiveSeat(this.dealerSeat);
      bbSeat = this.nextActiveSeat(sbSeat);
    }

    this.postBlind(sbSeat, this.smallBlind);
    this.postBlind(bbSeat, this.bigBlind);
    this.currentBet = Math.max(this.seats[sbSeat].bet, this.seats[bbSeat].bet);

    this.phase = 'preflop';
    this.lastRaiserSeat = -1;
    this.raisesThisStreet = 0;
    this.addLog(`—— 第 ${this.handNo} 手 ——`);
    this.addLog(`庄家 ${this.seats[this.dealerSeat].name}｜小盲 ${this.seats[sbSeat].name}｜大盲 ${this.seats[bbSeat].name}`);

    if (activeSeats.length === 2) {
      const sb = this.seats[sbSeat];
      this.actorSeat = (!sb.folded && !sb.allIn) ? sbSeat : this.nextActor(sbSeat);
    } else {
      this.actorSeat = this.nextActor(bbSeat);
    }

    if (this.actorSeat < 0) this.advanceStreet();
    else this.scheduleActor();
  }

  postBlind(seat, amount) {
    const p = this.seats[seat];
    if (!p) return;
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.totalBet += pay;
    if (p.chips === 0) p.allIn = true;
  }

  // ---------- 行动 ----------

  scheduleActor() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.aiTimer);
    this.turnTimer = this.aiTimer = null;

    const s = this.actorSeat;
    if (s < 0) {
      this.turnDeadline = null;
      this.broadcast();
      return;
    }
    const p = this.seats[s];
    if (!p) { this.turnDeadline = null; this.broadcast(); return; }

    this.turnDeadline = Date.now() + TURN_MS;

    // 超时托管
    this.turnTimer = setTimeout(() => {
      if (this.actorSeat !== s) return;
      const cur = this.seats[s];
      if (!cur || cur.folded || cur.allIn) return;
      const toCall = this.currentBet - cur.bet;
      try { this.act(s, toCall > 0 ? 'fold' : 'check'); } catch (e) { /* 忽略 */ }
    }, TURN_MS);

    // AI 稍微思考一下
    if (p.isAI) {
      const delay = 700 + Math.random() * 1000;
      this.aiTimer = setTimeout(() => {
        if (this.actorSeat !== s) return;
        this.botAct(s);
      }, delay);
    }

    this.broadcast();
  }

  act(seat, action, amount) {
    if (this.actorSeat !== seat) throw new Error('还没轮到你行动');
    const p = this.seats[seat];
    if (!p) throw new Error('座位为空');
    if (p.folded || p.allIn) throw new Error('你当前无法行动');

    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold': {
        p.folded = true;
        this.setAction(p, '弃牌');
        break;
      }
      case 'check': {
        if (toCall > 0) throw new Error('有人下注，不能过牌');
        this.setAction(p, '过牌');
        break;
      }
      case 'call': {
        if (toCall <= 0) throw new Error('无需跟注');
        const pay = Math.min(toCall, p.chips);
        p.chips -= pay;
        p.bet += pay;
        p.totalBet += pay;
        if (p.chips === 0) p.allIn = true;
        this.setAction(p, `跟注 ${pay}${p.allIn ? '（全下）' : ''}`);
        break;
      }
      case 'raise': {
        const otherActors = this.seats.filter(q => q && q !== p && !q.folded && !q.allIn);
        if (!otherActors.length) throw new Error('没有其他玩家能跟注，无法加注');

        const maxTo = p.bet + p.chips;
        if (maxTo <= this.currentBet) throw new Error('筹码不足以加注');

        let target = Math.floor(Number(amount) || 0);
        if (target > maxTo) target = maxTo;
        if (target <= this.currentBet) throw new Error('加注必须高于当前注额');

        const minTo = Math.min(this.minRaiseTo(), maxTo);
        if (target < minTo && target < maxTo) throw new Error(`最少要加注到 ${minTo}`);

        const pay = target - p.bet;
        const raiseSize = target - this.currentBet;
        p.chips -= pay;
        p.bet = target;
        p.totalBet += pay;
        if (p.chips === 0) p.allIn = true;

        this.currentBet = target;
        this.lastRaiserSeat = p.seat;
        this.raisesThisStreet++;

        // 只有足额加注才重开行动权；不足额的全下不重开
        if (raiseSize >= this.lastRaiseSize) {
          this.lastRaiseSize = raiseSize;
          for (const q of this.seats) {
            if (q && q !== p && !q.folded && !q.allIn) q.hasActed = false;
          }
        }
        this.setAction(p, `加注到 ${target}${p.allIn ? '（全下）' : ''}`);
        break;
      }
      default:
        throw new Error('未知操作');
    }

    // 动作验证通过并执行后，才取消超时计时器；
    // 万一动作非法抛出异常，计时器还在，30 秒后会自动托管
    clearTimeout(this.turnTimer);
    clearTimeout(this.aiTimer);
    this.turnTimer = this.aiTimer = null;

    // 记录行为统计，供其他 AI 建模
    if (!p.stats) p.stats = { hands: 0, vpip: 0, betsRaises: 0, seenThisHand: false };
    if (!p.stats.seenThisHand && (action === 'call' || action === 'raise')) {
      p.stats.seenThisHand = true;
      p.stats.vpip++;
    }
    if (action === 'raise') p.stats.betsRaises++;

    p.hasActed = true;

    if (this.livePlayers().length <= 1) { this.finishHand(); return; }
    if (this.roundComplete()) { this.advanceStreet(); return; }

    this.actorSeat = this.nextActor(seat);
    if (this.actorSeat < 0) { this.advanceStreet(); return; }
    this.scheduleActor();
  }

  roundComplete() {
    const live = this.livePlayers();
    if (live.length <= 1) return true;
    const canAct = live.filter(p => !p.allIn);
    if (canAct.length === 0) return true;
    if (canAct.length === 1) return canAct[0].bet === this.currentBet;
    return canAct.every(p => p.hasActed && p.bet === this.currentBet);
  }

  botAct(seat) {
    const p = this.seats[seat];
    if (!p || this.actorSeat !== seat) return;

    const live = this.livePlayers();

    // 找出这条街上最后一个主动加注的人，用来判断「我面对的加注来自谁」
    const raiser = this.lastRaiserSeat >= 0 ? this.seats[this.lastRaiserSeat] : null;

    let d;
    try {
      d = bot.decide({
        player: p,
        toCall: this.currentBet - p.bet,
        pot: this.potSize(),
        opponentCount: Math.max(1, live.length - 1),
        currentBet: this.currentBet,
        minRaiseTo: this.minRaiseTo(),
        maxRaiseTo: p.bet + p.chips,
        street: this.phase,
        community: this.community,
        raiser: raiser ? { stats: raiser.stats, name: raiser.name } : null,
        raisesThisStreet: this.raisesThisStreet,
      });
    } catch (e) {
      d = { action: this.currentBet > p.bet ? 'fold' : 'check' };
    }

    try {
      this.act(seat, d.action, d.amount);
    } catch (e) {
      const toCall = this.currentBet - p.bet;
      const fallback = d.action === 'raise'
        ? (toCall > 0 ? 'call' : 'check')
        : (toCall > 0 ? 'fold' : 'check');
      try { this.act(seat, fallback); } catch (_) { /* 忽略 */ }
    }
  }

  // ---------- 换街 / 结算 ----------

  collectBets() {
    for (const p of this.seats) {
      if (p && p.bet > 0) {
        this.pot += p.bet;
        p.bet = 0;
      }
    }
  }

  dealTo(n) {
    for (let i = 0; i < n; i++) this.community.push(this.deck.pop());
  }

  advanceStreet() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.aiTimer);
    this.turnTimer = this.aiTimer = null;

    this.collectBets();
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.lastRaiserSeat = -1;
    this.raisesThisStreet = 0;
    for (const p of this.seats) if (p && !p.folded) p.hasActed = false;

    const order = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
    this.phase = order[this.phase] || 'showdown';

    if (this.phase === 'flop') {
      this.dealTo(3);
      this.addLog(`翻牌：${this.community.join(' ')}`);
    } else if (this.phase === 'turn') {
      this.dealTo(1);
      this.addLog(`转牌：${this.community[3]}`);
    } else if (this.phase === 'river') {
      this.dealTo(1);
      this.addLog(`河牌：${this.community[4]}`);
    } else {
      while (this.community.length < 5) this.dealTo(1);
      this.finishHand();
      return;
    }

    const canAct = this.seats.filter(p => p && !p.folded && !p.allIn);
    if (canAct.length <= 1) {
      // 没人还能下注，直接发完
      this.advanceStreet();
      return;
    }

    this.actorSeat = this.nextActor(this.dealerSeat);
    this.scheduleActor();
  }

  // 某个玩家的总投入超过其他所有人能匹配的部分，属于"没人跟的下注"，退回本人
  refundUncalled() {
    const players = this.seats.filter(p => p && p.totalBet > 0);
    for (const p of players) {
      let maxOther = 0;
      for (const q of players) {
        if (q !== p) maxOther = Math.max(maxOther, q.totalBet);
      }
      if (p.totalBet > maxOther) {
        const refund = p.totalBet - maxOther;
        p.totalBet -= refund;
        p.chips += refund;
        this.pot -= refund;
        this.addLog(`${p.name} 未被跟注的 ${refund} 已退回`);
      }
    }
  }

  seatOrder(seat) {
    // 从庄家左手边开始算的顺序，用于分配余数
    return (seat - this.dealerSeat + MAX_SEATS) % MAX_SEATS;
  }

  finishHand() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.aiTimer);
    clearTimeout(this.nextHandTimer);
    this.turnTimer = this.aiTimer = this.nextHandTimer = null;
    this.nextHandAt = null;
    this.actorSeat = -1;
    this.turnDeadline = null;

    this.collectBets();
    const contenders = this.livePlayers();

    const evals = new Map();
    let winners = [];
    let totalPot = this.pot;

    if (contenders.length <= 1) {
      const w = contenders[0];
      if (w) {
        w.chips += totalPot;
        winners = [{ seat: w.seat, name: w.name, amount: totalPot, handName: null }];
        this.addLog(`${w.name} 赢得底池 ${totalPot}（其余人弃牌）`);
      }
      this.revealed = false;
    } else {
      // 没有人跟注的下注部分要退还给本人
      this.refundUncalled();
      totalPot = this.pot;

      // 摊牌
      this.revealed = true;
      for (const p of contenders) {
        const v = evaluate([...p.hole, ...this.community]);
        evals.set(p.id, v);
        this.handNames[p.id] = describe(v);
        this.addLog(`${p.name} 亮出 ${p.hole.join(' ')} —— ${this.handNames[p.id]}`);
      }
      winners = this.distribute(evals);
    }

    this.winners = winners;
    this.result = this.buildResult(totalPot, evals, winners);
    this.pot = 0;
    this.phase = 'showdown';
    this.awaitingNext = true;   // 等房主点「开始下一手」
    this.broadcast();
  }

  // 摊牌结果的内部数据：含所有人真实底牌，只在服务端保存
  buildResult(totalPot, evals, winners) {
    const winMap = new Map(winners.map(w => [w.seat, w.amount]));
    const rows = [];

    for (const p of this.seats) {
      if (!p) continue;

      const shown = !p.folded && evals.has(p.id);
      // 只要公共牌够 3 张就能算出成牌；弃牌的人也算，仅供他自己看
      const canMakeHand = this.community.length + p.hole.length >= 5;
      rows.push({
        id: p.id,
        seat: p.seat,
        name: p.name,
        isAI: p.isAI,
        hole: p.hole.slice(),
        madeHand: canMakeHand ? bestFive([...p.hole, ...this.community]) : [],
        handName: shown ? describe(evals.get(p.id)) : null,
        score: shown ? evals.get(p.id) : -1,
        won: winMap.get(p.seat) || 0,
        folded: p.folded,
        chips: p.chips,
      });
    }

    rows.sort((a, b) => {
      if (a.folded !== b.folded) return a.folded ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return a.seat - b.seat;
    });

    return { pot: totalPot, at: Date.now(), rows };
  }

  // 按查看者裁剪：自己能看自己的底牌，别人只有亮牌后才可见
  resultFor(pid) {
    if (!this.result) return null;

    const rows = this.result.rows.map((r) => {
      const mine = r.id === pid;
      const shown = !r.folded && r.score > -1;
      const canSeeCards = mine || shown;
      const canSeeMade = shown || (mine && this.community.length >= 3);

      return {
        seat: r.seat,
        name: r.name,
        isAI: r.isAI,
        hole: canSeeCards ? r.hole : ['??', '??'],
        madeHand: canSeeMade ? r.madeHand : [],
        handName: r.handName,
        score: r.score,
        won: r.won,
        folded: r.folded,
        isMine: mine,
        chips: r.chips,
      };
    });

    return {
      pot: this.result.pot,
      at: this.result.at,
      community: this.community.slice(),
      rows,
    };
  }

  distribute(evals) {
    const players = this.seats.filter(p => p);
    const levels = [...new Set(players.filter(p => p.totalBet > 0).map(p => p.totalBet))]
      .sort((a, b) => a - b);

    const results = new Map();
    let prev = 0;

    for (const L of levels) {
      const contributors = players.filter(p => p.totalBet >= L);
      const amount = (L - prev) * contributors.length;
      prev = L;
      if (amount <= 0) continue;

      const eligible = contributors.filter(p => !p.folded && evals.has(p.id));
      if (!eligible.length) continue;

      const best = Math.max(...eligible.map(p => evals.get(p.id)));
      const winners = eligible.filter(p => evals.get(p.id) === best);
      winners.sort((a, b) => this.seatOrder(a.seat) - this.seatOrder(b.seat));

      const share = Math.floor(amount / winners.length);
      let remainder = amount - share * winners.length;

      for (const w of winners) {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder--;
        w.chips += share + extra;

        const r = results.get(w.seat) || {
          seat: w.seat, name: w.name, amount: 0,
          handName: this.handNames[w.id] || describe(evals.get(w.id)),
        };
        r.amount += share + extra;
        results.set(w.seat, r);
      }
    }

    const list = [...results.values()];
    for (const r of list) this.addLog(`${r.name} 以 ${r.handName} 赢得 ${r.amount}`);
    return list;
  }

  // ---------- 推送 ----------

  snapshot(pid) {
    const meSeat = this.seats.findIndex(p => p && p.id === pid);
    const canShow = (p) => p.id === pid || (this.revealed && !p.folded);

    return {
      id: this.id,
      phase: this.phase,
      handNo: this.handNo,
      replenished: this.replenished,
      dealerSeat: this.dealerSeat,
      actorSeat: this.actorSeat,
      currentBet: this.currentBet,
      minRaiseTo: this.minRaiseTo(),
      pot: this.potSize(),
      community: this.community,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      buyIn: this.buyIn,
      turnDeadline: this.turnDeadline,
      turnMs: TURN_MS,
      nextHandAt: this.nextHandAt,
      maxSeats: MAX_SEATS,
      hostId: this.hostId,
      revealed: this.revealed,
      winners: this.winners,
      awaitingNext: this.awaitingNext,
      result: this.resultFor(pid),
      lastAction: this.lastAction,
      dissolved: this.dissolved,
      log: this.log.slice(-50),
      seats: this.seats.map((p, i) => {
        if (!p) return null;
        return {
          seat: i,
          id: p.id,
          name: p.name,
          isAI: p.isAI,
          chips: p.chips,
          bet: p.bet,
          totalBet: p.totalBet,
          folded: p.folded,
          allIn: p.allIn,
          connected: p.connected,
          style: bot.styleLabel(p.stats),
          hole: canShow(p) ? p.hole : (p.hole.length ? ['??', '??'] : []),
          handName: this.revealed && !p.folded ? (this.handNames[p.id] || null) : null,
        };
      }),
      me: {
        seat: meSeat,
        id: pid,
        isHost: this.hostId === pid,
        eliminated: this.eliminated.has(pid) && meSeat < 0,
      },
    };
  }

  subscribe(pid, res) {
    if (!this.subscribers.has(pid)) this.subscribers.set(pid, new Set());
    this.subscribers.get(pid).add(res);
    this.lastActivity = Date.now();

    try {
      res.write(`data: ${JSON.stringify(this.snapshot(pid))}\n\n`);
    } catch (e) { /* 忽略 */ }

    res.on('close', () => {
      const set = this.subscribers.get(pid);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) {
        this.subscribers.delete(pid);
        const p = this.seats.find(x => x && x.id === pid);
        if (p) {
          p.connected = false;
          p.disconnectedAt = Date.now();
          this.broadcast();
        }
      }
    });
  }

  broadcast() {
    this.lastActivity = Date.now();
    for (const [pid, set] of this.subscribers) {
      let payload;
      try {
        payload = `data: ${JSON.stringify(this.snapshot(pid))}\n\n`;
      } catch (e) {
        continue;
      }
      for (const res of set) {
        try { res.write(payload); } catch (e) { /* 忽略 */ }
      }
    }
  }
}

class Hub {
  constructor() {
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 30000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  createRoom() {
    let id;
    do {
      id = Math.floor(1000 + Math.random() * 9000).toString();
    } while (this.rooms.has(id));
    const room = new Room(id);
    this.rooms.set(id, room);
    return room;
  }

  getRoom(id) {
    return this.rooms.get(String(id)) || null;
  }

  sweep() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.dissolved) {
        this.rooms.delete(id);
        continue;
      }

      room.sweep();

      const hasHumanSeat = room.seats.some(p => p && !p.isAI);
      const tooOld = now - room.lastActivity > 6 * 60 * 60 * 1000;
      const emptyAndStale = !hasHumanSeat && now - room.createdAt > 2 * 60 * 1000;

      if (emptyAndStale || tooOld) {
        room.clearTimers();
        this.rooms.delete(id);
      }
    }
  }
}

module.exports = { Hub, Room, MAX_SEATS, TURN_MS };
