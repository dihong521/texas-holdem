'use strict';

const $ = (id) => document.getElementById(id);

const SUIT_CHAR = { s: '♠', h: '♥', d: '♦', c: '♣' };

// 座位在牌桌上的位置百分比（第 0 位永远是自己，位于正下方）
const SEAT_POS = [
  { x: 50, y: 87 },
  { x: 12, y: 63 },
  { x: 12, y: 23 },
  { x: 50, y: 9 },
  { x: 88, y: 23 },
  { x: 88, y: 63 },
];

let state = null;
let pid = '';
let roomId = '';
let es = null;
let lastActionKey = '';
let lastActionSeq = 0;
let resultKey = '';
let lastHandNo = 0;
let lastTurnKey = '';
let lastCountdownSec = null;
let pauseBaseMs = 0;
let pauseBaseAt = 0;

// ---------------- 网络 ----------------

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------------- 大厅 ----------------

function getName() {
  const v = $('nameInput').value.trim();
  if (!v) { $('lobbyMsg').textContent = '请先填个昵称'; return ''; }
  return v;
}

async function joinRoom(room, name) {
  const res = await post('/api/join', { room, name, pid: pid || undefined });
  pid = res.pid;
  roomId = res.room;
  localStorage.setItem('poker_pid', pid);
  localStorage.setItem('poker_room', roomId);
  localStorage.setItem('poker_name', name);
  enterTable();
}

$('createBtn').addEventListener('click', async () => {
  const name = getName();
  if (!name) return;

  // 填了房间号就用这个号，留空则随机生成
  const wanted = $('roomInput').value.trim();
  if (wanted && !/^\d{4}$/.test(wanted)) {
    $('lobbyMsg').textContent = '自定义房间号必须是 4 位数字';
    return;
  }

  $('lobbyMsg').textContent = '';
  try {
    const r = await post('/api/create', wanted ? { room: wanted } : {});
    await joinRoom(r.room, name);
  } catch (e) {
    $('lobbyMsg').textContent = e.message;
  }
});

$('joinBtn').addEventListener('click', async () => {
  const name = getName();
  if (!name) return;
  const room = $('roomInput').value.trim();
  if (!/^\d{4}$/.test(room)) { $('lobbyMsg').textContent = '房间号是 4 位数字'; return; }
  $('lobbyMsg').textContent = '';
  try {
    await joinRoom(room, name);
  } catch (e) {
    $('lobbyMsg').textContent = e.message;
  }
});

$('roomInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinBtn').click();
});

function enterTable() {
  $('lobby').classList.add('hidden');
  $('table').classList.remove('hidden');
  $('roomLabel').textContent = roomId;
  connect();
}

// ---------------- SSE ----------------

function connect() {
  if (es) es.close();
  let firstSnapshot = true;

  es = new EventSource(
    `/events?room=${encodeURIComponent(roomId)}&pid=${encodeURIComponent(pid)}`
  );
  es.addEventListener('message', (ev) => {
    try {
      const next = JSON.parse(ev.data);
      // 网络抖动可能让快照乱序到达，旧手数的快照直接丢弃
      if (state && typeof next.handNo === 'number' && next.handNo < state.handNo) return;

      if (next.dissolved && !(state && state.dissolved)) {
        toast('房间已解散：房间里没有真人玩家了');
      }

      state = next;

      // 暂停计时基准：服务端已经暂停的毫秒数 + 本地流逝
      if (state.paused) {
        pauseBaseMs = state.pausedForMs || 0;
        pauseBaseAt = Date.now();
      }

      // 刚进入房间时不要补播上一条旧动作的提示音
      if (firstSnapshot) {
        firstSnapshot = false;
        if (state.lastAction) lastActionSeq = state.lastAction.seq;
        lastHandNo = state.handNo;
      } else {
        // 新的一手开始了
        if (state.handNo > lastHandNo && state.phase === 'preflop') {
          lastHandNo = state.handNo;
          if (soundOn) playStartSound();
        }
        handleActionFlash();
      }

      render();
    } catch (e) { /* 忽略坏消息 */ }
  });
  es.addEventListener('error', () => {
    // EventSource 会自动重连，这里只做提示
    $('handLabel').textContent = '连接中断，重连中…';
  });
}

// ---------------- 渲染 ----------------

function me() {
  if (!state) return null;
  return state.seats.find((p) => p && p.id === state.me.id) || null;
}

function cardEl(card, big) {
  const d = document.createElement('div');
  d.className = 'card' + (big ? ' big' : '');

  if (!card || card === '??' || card === '') {
    d.classList.add('back');
    d.textContent = '';
    return d;
  }

  const suit = card[1];
  if (suit === 'h' || suit === 'd') d.classList.add('red');
  const r = document.createElement('span');
  r.textContent = card[0];
  const s = document.createElement('span');
  s.className = 'cs';
  s.textContent = SUIT_CHAR[suit] || '';
  d.append(r, s);
  return d;
}

function emptyCard() {
  const d = document.createElement('div');
  d.className = 'card empty';
  return d;
}

function render() {
  if (!state) return;

  if (state.phase === 'closed') { handleClosed(); return; }
  if (state.me && state.me.kicked) { handleKicked(); return; }

  $('handLabel').textContent =
    state.phase === 'waiting' ? '等待开始' : `第 ${state.handNo} 手`;
  $('hostTag').classList.toggle('hidden', !state.me.isHost);
  $('potLabel').textContent = state.pot;

  renderBoard();
  renderPhase();
  renderSeats();
  renderMyCards();
  renderActions();
  renderLog();
  renderResult();
  renderBust();
  renderPause();
}

// ---------- 暂停 ----------

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderPause() {
  const inPlay = ['preflop', 'flop', 'turn', 'river'].includes(state.phase);

  // 顶栏「暂停」按钮：只有房主、牌局进行中、且还没暂停时显示
  const pauseBtn = $('pauseBtn');
  pauseBtn.classList.toggle('hidden', !(state.me.isHost && inPlay && !state.paused));

  const overlay = $('pauseOverlay');
  overlay.classList.toggle('hidden', !state.paused);

  if (!state.paused) return;

  const resumeBtn = $('resumeBtn');
  const sub = $('pauseSub');

  if (state.me.isHost) {
    resumeBtn.classList.remove('hidden');
    sub.textContent = '';
  } else {
    resumeBtn.classList.add('hidden');
    const host = state.seats.find((p) => p && p.id === state.hostId);
    sub.textContent = host ? `等待房主 ${host.name} 继续` : '等待房主继续';
  }
}

$('pauseBtn').addEventListener('click', async () => {
  try {
    await post('/api/pause', { room: roomId, pid });
  } catch (e) {
    toast(e.message);
  }
});

$('resumeBtn').addEventListener('click', async () => {
  try {
    await post('/api/resume', { room: roomId, pid });
  } catch (e) {
    toast(e.message);
  }
});

function renderBoard() {
  const el = $('board');
  el.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const c = state.community[i];
    el.appendChild(c ? cardEl(c) : emptyCard());
  }
}

const PHASE_TEXT = {
  waiting: '等待玩家',
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  showdown: '摊牌',
};

function renderPhase() {
  const el = $('phaseLabel');
  if (state.phase === 'waiting') {
    const n = state.seats.filter(Boolean).length;
    el.textContent = n >= 2
      ? '即将开始…'
      : `等待玩家（${n}/${state.maxSeats}）· 可点右上角「+ 机器人」补位`;
    return;
  }
  if (state.phase === 'showdown') {
    el.textContent = state.awaitingNext ? '本手结束' : '摊牌';
    return;
  }
  el.textContent = PHASE_TEXT[state.phase] || '';
}

function renderSeats() {
  const el = $('seats');
  el.innerHTML = '';

  const meSeat = state.me.seat >= 0 ? state.me.seat : 0;
  const canKick = state.me.isHost && state.phase === 'waiting' && !state.paused;

  state.seats.forEach((p, seat) => {
    if (!p) return;

    let rel = (seat - meSeat + 6) % 6;
    if (state.me.seat < 0) rel = seat;
    const pos = SEAT_POS[rel];

    const d = document.createElement('div');
    d.className = 'seat';
    d.dataset.seat = String(seat);
    d.style.left = pos.x + '%';
    d.style.top = pos.y + '%';

    if (seat === state.actorSeat) d.classList.add('active');
    if (p.folded) d.classList.add('folded');
    if (!p.connected && !p.isAI) d.classList.add('offline');

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = (p.isAI ? '🤖 ' : '') + p.name;

    if (p.style) {
      const st = document.createElement('i');
      st.className = 'style-tag ' + (p.style === '紧' ? 'tight' : p.style === '凶' ? 'aggro' : 'loose');
      st.textContent = p.style;
      name.appendChild(st);
    }

    d.appendChild(name);

    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.textContent = p.chips;
    d.appendChild(chips);

    const hole = document.createElement('div');
    hole.className = 'hole';
    if (p.hole && p.hole.length) {
      for (const c of p.hole) hole.appendChild(cardEl(c));
    }
    d.appendChild(hole);

    if (p.handName) {
      const hn = document.createElement('div');
      hn.className = 'handname';
      hn.textContent = p.handName;
      d.appendChild(hn);
    }

    if (seat === state.dealerSeat) {
      const dl = document.createElement('div');
      dl.className = 'dealer';
      dl.textContent = 'D';
      d.appendChild(dl);
    }

    // 下注额：本轮下注 + 本手累计投入
    if (p.bet > 0 || p.totalBet > 0) {
      const b = document.createElement('div');
      b.className = 'bet-inline';

      if (p.bet > 0) {
        const now = document.createElement('span');
        now.className = 'bet-now';
        now.textContent = `本轮 ${p.bet}`;
        b.appendChild(now);
      }

      if (p.totalBet > 0) {
        const total = document.createElement('span');
        total.className = 'bet-total';
        total.textContent = `共 ${p.totalBet}`;
        b.appendChild(total);
      }

      d.appendChild(b);
    }

    // 房主在开局前可以踢人
    if (canKick && p.id !== state.me.id) {
      const k = document.createElement('button');
      k.className = 'kick-btn';
      k.textContent = '×';
      k.title = `移出 ${p.name}`;
      k.addEventListener('click', (ev) => {
        ev.stopPropagation();
        kickPlayer(p);
      });
      d.appendChild(k);
    }

    if (p.sittingOut) {
      const t = document.createElement('div');
      t.className = 'tag sitting-out';
      t.textContent = '下局加入';
      d.appendChild(t);
    } else if (p.allIn) {
      const t = document.createElement('div');
      t.className = 'tag';
      t.textContent = '全下';
      d.appendChild(t);
    }

    if (seat === state.actorSeat) {
      const t = document.createElement('div');
      t.className = 'timer';
      const bar = document.createElement('i');
      t.appendChild(bar);
      d.appendChild(t);
    }

    // 最近这次操作，在座位上冒个气泡
    const la = state.lastAction;
    if (la && la.seat === seat && Date.now() - la.at < 2600) {
      const b = document.createElement('div');
      b.className = 'bubble ' + actionKind(la.text);
      b.dataset.at = String(la.at);
      b.textContent = la.text;
      d.appendChild(b);
    }

    el.appendChild(d);
  });
}

function renderMyCards() {
  const el = $('mycards');
  el.innerHTML = '';
  const p = me();
  if (!p) return;

  if (p.hole && p.hole.length) {
    for (const c of p.hole) el.appendChild(cardEl(c, true));
    if (p.handName) {
      const t = document.createElement('span');
      t.textContent = ' ' + p.handName;
      el.appendChild(t);
    }
  } else if (state.phase !== 'waiting') {
    const t = document.createElement('span');
    t.textContent = '等待发牌…';
    el.appendChild(t);
  }
}

function makeBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'act' + (cls ? ' ' + cls : '');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function renderActions() {
  const el = $('actions');
  const p = me();

  if (!p) {
    el.innerHTML = '';
    lastActionKey = '';
    return;
  }

  const myTurn =
    state.actorSeat === p.seat &&
    !p.folded &&
    !p.allIn &&
    state.phase !== 'waiting' &&
    state.phase !== 'showdown';

  if (!myTurn) {
    el.innerHTML = '';
    lastActionKey = '';

    // 暂停中，任何人都不能操作
    if (state.paused) {
      const hint = document.createElement('div');
      hint.className = 'waiting-hint paused';
      hint.textContent = '游戏已暂停';
      el.appendChild(hint);
      return;
    }

    // 等待开局：房主看到「开始游戏」按钮
    if (state.phase === 'waiting') {
      const seated = state.seats.filter(Boolean).length;

      if (state.me.isHost) {
        if (state.canStart) {
          const btn = makeBtn('开始游戏', 'raise', startGame);
          el.appendChild(btn);
        } else {
          const hint = document.createElement('div');
          hint.className = 'waiting-hint';
          hint.textContent =
            `等待玩家（${seated}/${state.maxSeats}）· 至少 2 人才能开始 · 可点右上角「+ 机器人」补位`;
          el.appendChild(hint);
        }
      } else {
        const hint = document.createElement('div');
        hint.className = 'waiting-hint';
        hint.textContent = `等待房主开始游戏（${seated}/${state.maxSeats}）`;
        el.appendChild(hint);
      }
      return;
    }

    const hint = document.createElement('div');
    hint.className = 'waiting-hint';
    if (p.folded) {
      hint.textContent = p.sittingOut ? '本手不参与，下一手开始' : '你已弃牌，等待本手结束';
    } else if (p.allIn) {
      hint.textContent = '你已全下，等待摊牌';
    } else if (state.phase === 'showdown') {
      hint.textContent = '本手结束，等待开始下一手';
    } else {
      const actor = state.seats[state.actorSeat];
      hint.textContent = actor ? `等待 ${actor.name} 行动…` : '等待中…';
    }
    el.appendChild(hint);
    return;
  }

  // 避免同一回合反复重建导致滑块被重置
  const key = [state.handNo, state.actorSeat, state.currentBet, p.bet, p.chips, state.phase].join('|');
  if (key === lastActionKey && el.children.length) return;
  lastActionKey = key;

  const toCall = Math.max(0, Math.min(state.currentBet - p.bet, p.chips));
  const maxTo = p.bet + p.chips;
  const minTo = Math.min(state.minRaiseTo, maxTo);
  // 只有还能行动的对手才能跟注你的加注
  const opponentsCanAct = state.seats.some(
    (q) => q && q.seat !== p.seat && !q.folded && !q.allIn
  );
  const canRaise = maxTo > state.currentBet && opponentsCanAct;

  el.innerHTML = '';
  el.appendChild(makeBtn('弃牌', 'fold', () => act('fold')));

  if (toCall <= 0) {
    el.appendChild(makeBtn('过牌', 'call', () => act('check')));
  } else {
    const allIn = toCall >= p.chips;
    el.appendChild(makeBtn(allIn ? `全下 ${toCall}` : `跟注 ${toCall}`, 'call', () => act('call')));
  }

  if (!canRaise) return;

  const box = document.createElement('div');
  box.className = 'raise-box';

  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(minTo);
  range.max = String(maxTo);
  range.step = String(state.bigBlind);

  const start = Math.min(maxTo, Math.max(minTo, state.currentBet + Math.round(state.pot * 0.5)));
  range.value = String(start);

  const amount = document.createElement('span');
  amount.className = 'amount';

  const raiseBtn = makeBtn('', 'raise', () => act('raise', Number(range.value)));

  const update = () => {
    const v = Number(range.value);
    amount.textContent = String(v);
    if (v >= maxTo) {
      raiseBtn.textContent = '全下';
    } else {
      raiseBtn.textContent = state.currentBet > 0 ? `加注到 ${v}` : `下注 ${v}`;
    }
  };

  range.addEventListener('input', update);
  update();

  box.append(range, amount);
  el.appendChild(box);

  const quick = document.createElement('div');
  quick.className = 'quick';
  const options = [['½池', 0.5], ['池', 1], ['全下', null]];
  for (const [label, frac] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      let v;
      if (frac === null) {
        v = maxTo;
      } else {
        v = state.currentBet + Math.round(Math.max(state.pot * frac, minTo - state.currentBet));
      }
      range.value = String(Math.min(maxTo, Math.max(minTo, v)));
      update();
    });
    quick.appendChild(b);
  }
  el.appendChild(quick);
  el.appendChild(raiseBtn);
}

// ---------- 操作提示音 ----------

let audioCtx = null;
let soundOn = localStorage.getItem('poker_sound') !== 'off';

// 浏览器要求先有用户手势才能出声
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function beep(freq, { dur = 0.08, type = 'sine', gain = 0.05, delay = 0, to = 0 } = {}) {
  const ctx = ensureAudio();
  if (!ctx) return;

  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);

  // 起音和收音都做淡入淡出，避免爆音
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function playActionSound(text) {
  const allIn = text.includes('全下');

  if (allIn) {
    // 全下：三连上行 + 一记低音，最有存在感
    beep(520, { dur: 0.09, gain: 0.05 });
    beep(680, { dur: 0.09, gain: 0.05, delay: 0.07 });
    beep(880, { dur: 0.16, gain: 0.055, delay: 0.14 });
    beep(190, { dur: 0.32, type: 'triangle', gain: 0.05, delay: 0.14, to: 120 });
    return;
  }

  switch (actionKind(text)) {
    case 'fold':
      // 弃牌：一声下滑，听感上「收掉」
      beep(340, { dur: 0.17, type: 'triangle', gain: 0.045, to: 170 });
      break;
    case 'check':
      // 过牌：一声轻响
      beep(560, { dur: 0.07, gain: 0.04 });
      break;
    case 'call':
      // 跟注：两连上行
      beep(560, { dur: 0.07, gain: 0.05 });
      beep(730, { dur: 0.08, gain: 0.045, delay: 0.06 });
      break;
    case 'raise':
      // 加注：三连上行
      beep(620, { dur: 0.07, gain: 0.05 });
      beep(790, { dur: 0.07, gain: 0.05, delay: 0.06 });
      beep(950, { dur: 0.11, gain: 0.045, delay: 0.12 });
      break;
  }
}

function playStartSound() {
  // 新的一手开始：两声柔和的「叮—咚」
  beep(523, { dur: 0.1, gain: 0.05 });
  beep(784, { dur: 0.17, gain: 0.05, delay: 0.1 });
}

function playCountdownSound(sec) {
  // 别人思考快超时了，最后 3 秒各滴一声，越接近越尖
  const freq = 820 + (3 - sec) * 110;
  beep(freq, { dur: 0.06, gain: 0.055 });
}

function syncSoundBtn() {
  const b = $('soundBtn');
  b.textContent = soundOn ? '🔊' : '🔇';
  b.classList.toggle('muted', !soundOn);
}

$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('poker_sound', soundOn ? 'on' : 'off');
  syncSoundBtn();
  if (soundOn) beep(680, { dur: 0.09, gain: 0.05 }); // 开启时给个确认音
});

// 第一次点屏幕就激活音频（浏览器策略要求）
document.addEventListener('pointerdown', () => ensureAudio(), { once: true });

// ---------- 操作提示 ----------

const ACTION_KIND = {
  '弃牌': 'fold',
  '过牌': 'check',
  '跟注': 'call',
  '加注': 'raise',
};

function actionKind(text) {
  for (const [k, v] of Object.entries(ACTION_KIND)) {
    if (text.startsWith(k)) return v;
  }
  return 'call';
}

function handleActionFlash() {
  const a = state.lastAction;
  if (!a || a.seq === lastActionSeq) return;
  lastActionSeq = a.seq;

  if (soundOn) playActionSound(a.text);

  const el = $('actionFlash');
  el.className = 'action-flash ' + actionKind(a.text);
  el.innerHTML = '';

  const who = document.createElement('b');
  who.textContent = a.name;
  const what = document.createElement('span');
  what.textContent = a.text;
  el.append(who, what);

  // 重新触发动画
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';

  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 1800);

  // 出牌的人在座位上闪一下
  highlightSeat(a.seat);
}

function highlightSeat(seat) {
  const nodes = document.querySelectorAll('.seat');
  for (const n of nodes) {
    if (Number(n.dataset.seat) === seat) {
      n.classList.remove('acted');
      void n.offsetWidth;
      n.classList.add('acted');
      setTimeout(() => n.classList.remove('acted'), 1200);
    }
  }
}

// ---------- 摊牌结果 ----------

function renderResult() {
  const modal = $('resultModal');

  if (state.phase !== 'showdown' || !state.result) {
    modal.classList.add('hidden');
    return;
  }

  const r = state.result;
  const key = `${state.handNo}:${r.at}`;
  if (key === resultKey) {
    updateNextHandButton();
    return;
  }
  resultKey = key;

  $('resultPot').textContent = r.pot;

  // 公共牌：发了几张就显示几张
  const board = $('resultBoard');
  board.innerHTML = '';
  const community = r.community || [];
  if (community.length) {
    board.classList.remove('hidden');

    const label = document.createElement('span');
    label.className = 'board-label';
    label.textContent = '公共牌';
    board.appendChild(label);

    for (const c of community) board.appendChild(cardEl(c));
  } else {
    board.classList.add('hidden');
  }

  // 自己的底牌和成牌单独放在最上面，一眼就能看到
  const mineBox = $('resultMine');
  const mineRow = r.rows.find((x) => x.isMine);
  mineBox.innerHTML = '';

  if (mineRow && mineRow.hole.length) {
    mineBox.classList.remove('hidden');

    const label = document.createElement('span');
    label.className = 'rm-label';
    label.textContent = '你的底牌';
    mineBox.appendChild(label);

    for (const c of mineRow.hole) mineBox.appendChild(cardEl(c));

    if (mineRow.handName) {
      const hn = document.createElement('span');
      hn.className = 'rm-hand';
      hn.textContent = mineRow.handName;
      mineBox.appendChild(hn);
    }

    if (mineRow.madeHand && mineRow.madeHand.length) {
      const sep = document.createElement('span');
      sep.className = 'rm-label';
      sep.textContent = '成牌';
      mineBox.appendChild(sep);

      for (const c of mineRow.madeHand) mineBox.appendChild(cardEl(c));
    }
  } else {
    mineBox.classList.add('hidden');
  }

  const list = $('resultList');
  list.innerHTML = '';

  r.rows.forEach((row, i) => {
    const item = document.createElement('div');
    item.className = 'result-row';
    if (row.won > 0) item.classList.add('winner');
    if (row.folded) item.classList.add('folded');
    if (row.isMine) item.classList.add('mine');

    const rank = document.createElement('span');
    rank.className = 'result-rank';
    rank.textContent = row.folded ? '—' : String(i + 1);
    item.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'result-main';

    // 第一行：底牌 + 名字 + 赢得
    const line1 = document.createElement('div');
    line1.className = 'rr-line1';

    const cards = document.createElement('span');
    cards.className = 'result-cards';
    for (const c of row.hole) cards.appendChild(cardEl(c));
    line1.appendChild(cards);

    const nm = document.createElement('b');
    nm.className = 'rr-name';
    nm.textContent = (row.isAI ? '🤖 ' : '') + row.name + (row.isMine ? '（你）' : '');
    line1.appendChild(nm);

    const won = document.createElement('span');
    won.className = 'result-won';
    won.textContent = row.won > 0 ? `+${row.won}` : '';
    line1.appendChild(won);

    main.appendChild(line1);

    // 第二行：牌型 + 成牌（最强的 5 张）
    const line2 = document.createElement('div');
    line2.className = 'rr-line2';

    const hn = document.createElement('em');
    hn.className = 'rr-hand';
    hn.textContent = row.folded ? '已弃牌' : (row.handName || '');
    line2.appendChild(hn);

    if (row.madeHand && row.madeHand.length) {
      const made = document.createElement('span');
      made.className = 'rr-made';
      for (const c of row.madeHand) made.appendChild(cardEl(c));
      line2.appendChild(made);
    }

    main.appendChild(line2);
    item.appendChild(main);
    list.appendChild(item);
  });

  modal.classList.remove('hidden');
  updateNextHandButton();
}


function updateNextHandButton() {
  const btn = $('nextHandBtn');
  const backBtn = $('backStageBtn');
  const hint = $('resultHint');

  if (state.awaitingNext) {
    if (state.me.isHost) {
      btn.classList.remove('hidden');
      btn.disabled = false;
      backBtn.classList.remove('hidden');
      hint.textContent = '';
    } else {
      btn.classList.add('hidden');
      backBtn.classList.add('hidden');
      const host = state.seats.find((p) => p && p.id === state.hostId);
      hint.textContent = host ? `等待房主 ${host.name} 开始下一手` : '等待房主开始下一手';
    }
  } else {
    btn.classList.add('hidden');
    backBtn.classList.add('hidden');
    hint.textContent = '下一手即将开始…';
  }
}

$('nextHandBtn').addEventListener('click', async () => {
  $('nextHandBtn').disabled = true;
  try {
    await post('/api/start', { room: roomId, pid });
  } catch (e) {
    toast(e.message);
    $('nextHandBtn').disabled = false;
  }
});

// ---------- 淘汰 ----------

function renderBust() {
  const modal = $('bustModal');
  modal.classList.toggle('hidden', !state.me.eliminated || state.dissolved);
}

$('rejoinBtn').addEventListener('click', async () => {
  try {
    await post('/api/join', {
      room: roomId,
      name: localStorage.getItem('poker_name') || '无名',
      pid,
    });
    $('bustModal').classList.add('hidden');
  } catch (e) {
    toast(e.message);
  }
});

$('bustLeaveBtn').addEventListener('click', () => {
  $('leaveBtn').click();
});

let kickedHandled = false;

function handleKicked() {
  if (kickedHandled) return;
  kickedHandled = true;

  $('resultModal').classList.add('hidden');
  $('bustModal').classList.add('hidden');
  $('pauseOverlay').classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'modal';
  card.innerHTML = `
    <div class="modal-card narrow">
      <h2>你已被移出房间</h2>
      <p class="bust-msg">房主把你移出了这个房间。</p>
      <div class="bust-actions">
        <button class="btn primary" id="kickedLobbyBtn">返回大厅</button>
      </div>
    </div>`;
  document.body.appendChild(card);

  card.querySelector('#kickedLobbyBtn').addEventListener('click', () => {
    if (es) es.close();
    localStorage.removeItem('poker_room');
    localStorage.removeItem('poker_pid');
    location.reload();
  });
}

function handleClosed() {
  if (state.modalHandled) return;
  state.modalHandled = true;
  $('resultModal').classList.add('hidden');
  $('bustModal').classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'modal';
  card.innerHTML = `
    <div class="modal-card narrow">
      <h2>房间已解散</h2>
      <p class="bust-msg">房间里已经没有真人玩家了。</p>
      <div class="bust-actions">
        <button class="btn primary" id="backLobbyBtn">返回大厅</button>
      </div>
    </div>`;
  document.body.appendChild(card);
  card.querySelector('#backLobbyBtn').addEventListener('click', () => {
    localStorage.removeItem('poker_room');
    localStorage.removeItem('poker_pid');
    location.reload();
  });
}

function renderLog() {
  const el = $('log');
  const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = '';
  for (const item of state.log) {
    const d = document.createElement('div');
    d.textContent = item.text;
    el.appendChild(d);
  }
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// ---------------- 操作 ----------------

async function act(action, amount) {
  try {
    await post('/api/action', { room: roomId, pid, action, amount });
  } catch (e) {
    toast(e.message);
  }
}

async function startGame() {
  try {
    await post('/api/start', { room: roomId, pid });
  } catch (e) {
    toast(e.message);
  }
}

async function kickPlayer(target) {
  if (!confirm(`确定把「${target.name}」移出房间吗？`)) return;
  try {
    await post('/api/kick', { room: roomId, pid, target: target.id });
    toast(`${target.name} 已被移出房间`);
  } catch (e) {
    toast(e.message);
  }
}

async function backToStage() {
  try {
    await post('/api/back', { room: roomId, pid });
  } catch (e) {
    toast(e.message);
  }
}

$('backStageBtn').addEventListener('click', backToStage);

$('aiBtn').addEventListener('click', async () => {
  try {
    await post('/api/addai', { room: roomId, pid });
  } catch (e) {
    toast(e.message);
  }
});

$('logBtn').addEventListener('click', () => $('logbox').classList.toggle('hidden'));
$('logClose').addEventListener('click', () => $('logbox').classList.add('hidden'));

$('leaveBtn').addEventListener('click', async () => {
  if (!confirm('确定要离开房间吗？')) return;
  try { await post('/api/leave', { room: roomId, pid }); } catch (e) { /* 忽略 */ }
  if (es) es.close();
  localStorage.removeItem('poker_room');
  localStorage.removeItem('poker_pid');
  localStorage.removeItem('poker_name');
  location.reload();
});

// ---------------- 定时刷新倒计时 ----------------

setInterval(() => {
  if (!state) return;

  if (state.turnDeadline) {
    const remain = Math.max(0, state.turnDeadline - Date.now());
    const pct = Math.min(100, (remain / state.turnMs) * 100);
    const bar = document.querySelector('.seat.active .timer i');
    if (bar) bar.style.width = pct + '%';

    // 最后 3 秒每秒滴一声（同一个人只响一轮）
    const sec = Math.ceil(remain / 1000);
    const turnKey = `${state.handNo}:${state.actorSeat}:${state.phase}`;
    if (turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      lastCountdownSec = null;
    }
    if (sec <= 3 && sec >= 1 && sec !== lastCountdownSec) {
      lastCountdownSec = sec;
      if (soundOn) playCountdownSound(sec);
    }
  } else {
    lastTurnKey = '';
    lastCountdownSec = null;
  }

  // 暂停计时：服务端已暂停的时长 + 本地流逝
  if (state.paused) {
    const ms = pauseBaseMs + (Date.now() - pauseBaseAt);
    $('pauseTime').textContent = fmtDuration(ms);
  }

  // 操作气泡和顶部提示超时自动消失
  for (const b of document.querySelectorAll('.bubble')) {
    if (Date.now() - Number(b.dataset.at) > 2600) b.remove();
  }
}, 200);

// ---------------- 启动 ----------------

(async function boot() {
  syncSoundBtn();

  const savedRoom = localStorage.getItem('poker_room');
  const savedPid = localStorage.getItem('poker_pid');
  const savedName = localStorage.getItem('poker_name');

  if (savedRoom && savedPid && savedName) {
    pid = savedPid;
    try {
      await joinRoom(savedRoom, savedName);
      return;
    } catch (e) {
      localStorage.removeItem('poker_room');
      localStorage.removeItem('poker_pid');
      localStorage.removeItem('poker_name');
      pid = '';
    }
  }

  $('lobby').classList.remove('hidden');
  $('table').classList.add('hidden');
  $('nameInput').value = savedName || '';
  $('nameInput').focus();
})();
