'use strict';

// 验证新增功能：摊牌结果、房主开始下一手、房主交接、房间解散
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

async function waitFor(fn, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

(async () => {
  console.log('\n【接口】新增功能验证\n');

  const { data: created } = await post('/api/create', {});
  const room = created.room;
  const A = (await post('/api/join', { room, name: '房主甲' })).data.pid;
  const B = (await post('/api/join', { room, name: '乙' })).data.pid;
  await post('/api/addai', { room, pid: A });
  await post('/api/addai', { room, pid: A });

  // 等开局
  const started = await waitFor(async () => {
    const s = await getState(room, A);
    return s.phase !== 'waiting' ? s : null;
  });
  check('人数够了自动开第一手', !!started);

  // 两个真人能行动就过牌/跟注，把这一手打完
  const showdown = await waitFor(async () => {
    const s = await getState(room, A);
    if (s.phase === 'showdown') return s;

    for (const pid of [A, B]) {
      const p = s.seats.find((x) => x && x.id === pid);
      if (p && s.actorSeat === p.seat && !p.folded && !p.allIn) {
        const toCall = s.currentBet - p.bet;
        await post('/api/action', { room, pid, action: toCall > 0 ? 'call' : 'check' });
      }
    }
    return null;
  });

  check('一手能打到摊牌', !!showdown);
  if (showdown) {
    check('摊牌后有 result 排名', !!showdown.result && Array.isArray(showdown.result.rows));
    check('result 里带了底池金额', showdown.result.pot > 0, String(showdown.result.pot));
    check('摊牌后等待房主开始下一手', showdown.awaitingNext === true);

    const rows = showdown.result.rows || [];
    const shown = rows.filter((r) => !r.folded);
    check('亮牌的玩家都参与排名', shown.length > 0, `亮牌 ${shown.length} 人`);
    check('排名第一是赢家', rows.length > 0 && rows[0].won > 0);

    const sorted = shown.every((r, i) => i === 0 || shown[i - 1].score >= r.score);
    check('亮牌按牌力降序排列', sorted);

    // 非房主不能开始下一手
    const denied = await post('/api/start', { room, pid: B });
    check('非房主开下一手被拒绝', denied.status === 400, JSON.stringify(denied.data));

    const started2 = await post('/api/start', { room, pid: A });
    check('房主可以开始下一手', started2.status === 200, JSON.stringify(started2.data));

    await sleep(500);
    const s2 = await getState(room, A);
    check('开始后进入新的一手', s2.phase === 'preflop' && s2.handNo === showdown.handNo + 1);
  }

  // 房主离开 → 交接
  await post('/api/leave', { room, pid: A });
  await sleep(300);
  const afterLeave = await getState(room, B);
  check('房主离开后交给下一个真人', afterLeave.hostId === B, afterLeave.hostId);
  check('房间还在（还有真人）', !afterLeave.dissolved);

  // 最后一个真人离开 → 解散
  await post('/api/leave', { room, pid: B });
  await sleep(400);
  const gone = await fetch(`${BASE}/api/state?room=${room}&pid=${B}`).then((r) => r.json());
  check('真人走光后房间解散或已删除', gone.dissolved === true || gone.error, JSON.stringify(gone).slice(0, 80));

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
