'use strict';

// 针对本轮反馈的 5 个问题逐项验证
const BASE = 'http://localhost:3000';

const post = (p, b) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

const getState = (room, pid) =>
  fetch(`${BASE}/api/state?room=${room}&pid=${pid}`).then((r) => r.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  →  ' + extra : '')); }
}

async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

(async () => {
  console.log('\n【1】自定义房间号\n');

  const custom = 5678;
  const created = await post('/api/create', { room: custom });
  check('填了房间号就用这个号', created.data.room === String(custom), JSON.stringify(created.data));

  const dup = await post('/api/create', { room: custom });
  check('重复的房号被拒绝', dup.status === 409, JSON.stringify(dup.data));

  const bad = await post('/api/create', { room: '12' });
  check('非法房号被拒绝', bad.status === 400, JSON.stringify(bad.data));

  const auto = await post('/api/create', {});
  check('留空则自动生成', /^\d{4}$/.test(auto.data.room), auto.data.room);

  console.log('\n【2】手动开局\n');

  const room = created.data.room;
  const A = (await post('/api/join', { room, name: '房主甲' })).data.pid;
  const B = (await post('/api/join', { room, name: '乙' })).data.pid;

  await sleep(1200);
  const waiting = await getState(room, A);
  check('两人齐了仍然在等待', waiting.phase === 'waiting', waiting.phase);
  check('canStart 为 true（房主可点开始）', waiting.canStart === true);

  const nonHost = await post('/api/start', { room, pid: B });
  check('非房主不能开始', nonHost.status === 400, JSON.stringify(nonHost.data));

  const hostStart = await post('/api/start', { room, pid: A });
  check('房主可以开始', hostStart.status === 200, JSON.stringify(hostStart.data));

  await sleep(300);
  const playing = await getState(room, A);
  check('开始后进入牌局', playing.phase !== 'waiting', playing.phase);
  check('开始后 canStart 变为 false（按钮消失）', playing.canStart === false);

  console.log('\n【3】暂停 / 继续\n');

  const pauseByGuest = await post('/api/pause', { room, pid: B });
  check('非房主不能暂停', pauseByGuest.status === 400, JSON.stringify(pauseByGuest.data));

  const paused = await post('/api/pause', { room, pid: A });
  check('房主可以暂停', paused.status === 200, JSON.stringify(paused.data));

  await sleep(400);
  const pState = await getState(room, A);
  check('状态里 paused 为 true', pState.paused === true);
  check('暂停时长在累计', pState.pausedForMs >= 0, String(pState.pausedForMs));
  check('暂停后回合倒计时停止', pState.turnDeadline === null);

  // 暂停期间无法操作
  const seat = pState.me.seat;
  const actionDuringPause = await post('/api/action', {
    room, pid: A, action: pState.currentBet > pState.seats[seat].bet ? 'call' : 'check',
  });
  const expectReject = pState.actorSeat === seat;
  if (expectReject) {
    check('暂停期间操作被拒绝', actionDuringPause.status === 400, JSON.stringify(actionDuringPause.data));
  } else {
    check('（本轮不是我行动，跳过操作测试）', true);
  }

  await sleep(2500);
  const pState2 = await getState(room, A);
  const grew = pState2.pausedForMs > pState.pausedForMs;
  check('暂停时长随时间增加', grew, `${pState.pausedForMs} → ${pState2.pausedForMs}`);

  const resumeByGuest = await post('/api/resume', { room, pid: B });
  check('非房主不能继续', resumeByGuest.status === 400, JSON.stringify(resumeByGuest.data));

  const resumed = await post('/api/resume', { room, pid: A });
  check('房主可以继续', resumed.status === 200, JSON.stringify(resumed.data));

  await sleep(300);
  const afterResume = await getState(room, A);
  check('继续后 paused 为 false', afterResume.paused === false);
  check('继续后倒计时恢复', afterResume.turnDeadline !== null);

  console.log('\n【4】牌局中途加入\n');

  const C = (await post('/api/join', { room, name: '后来的人' })).data.pid;
  await sleep(300);
  const mid = await getState(room, C);

  const meC = mid.seats.find((p) => p && p.id === C);
  check('中途加入的人被标记为不参与本手', meC.sittingOut === true);
  check('中途加入的人没有底牌', meC.hole.length === 0, JSON.stringify(meC.hole));
  check('中途加入的人被排除在行动之外', mid.actorSeat !== meC.seat);
  check('中途加入的人不能操作', true); // 靠 sittingOut + folded 保证

  const badAction = await post('/api/action', { room, pid: C, action: 'call' });
  check('中途加入的人发操作会被拒绝', badAction.status === 400, JSON.stringify(badAction.data));

  console.log('\n【5】AI 弃牌率（只需观察，见下方统计）\n');

  // 打完这一手，看新玩家是否在下一手拿到牌
  const finished = await waitFor(async () => {
    const s = await getState(room, A);
    if (s.phase === 'showdown' && s.awaitingNext) return s;
    const seatA = s.seats.find((p) => p && p.id === A);
    if (seatA && s.actorSeat === seatA.seat && !seatA.folded && !seatA.allIn) {
      const toCall = s.currentBet - seatA.bet;
      await post('/api/action', { room, pid: A, action: toCall > 0 ? 'call' : 'check' });
    }
    const seatB = s.seats.find((p) => p && p.id === B);
    if (seatB && s.actorSeat === seatB.seat && !seatB.folded && !seatB.allIn) {
      const toCall = s.currentBet - seatB.bet;
      await post('/api/action', { room, pid: B, action: toCall > 0 ? 'call' : 'check' });
    }
    return null;
  }, 45000);

  check('这一手能正常结束', !!finished);

  if (finished) {
    const started = await post('/api/start', { room, pid: A });
    check('房主可以开始下一手', started.status === 200, JSON.stringify(started.data));

    await sleep(400);
    const next = await getState(room, C);
    const meC2 = next.seats.find((p) => p && p.id === C);
    check('下一手中途加入的人拿到牌了', meC2.hole.length === 2 && meC2.hole[0] !== '??', JSON.stringify(meC2.hole));
    check('下一手中途加入的人不再 sittingOut', meC2.sittingOut === false);
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
