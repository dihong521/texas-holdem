'use strict';

// 端到端冒烟测试：模拟真实的 HTTP 调用流程，包括 SSE 推送
const ROOM = process.argv[2];
const PID = process.argv[3];
const BASE = 'http://localhost:3000';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

function show(state) {
  console.log(`  阶段=${state.phase} 手数=${state.handNo} 底池=${state.pot} 公共牌=[${state.community.join(' ')}] 行动座位=${state.actorSeat}`);
  for (const p of state.seats) {
    if (!p) continue;
    console.log(`    ${p.seat} ${p.name}${p.isAI ? '[AI]' : '[人]'} 筹码=${p.chips} 下注=${p.bet} 牌=${p.hole.join(' ')}${p.folded ? ' 已弃牌' : ''}`);
  }
}

(async () => {
  let s = await (await fetch(`${BASE}/api/state?room=${ROOM}&pid=${PID}`)).json();
  show(s);

  // 自己是庄家还是大盲？找到轮到我时执行动作
  const me = s.seats.find((p) => p && p.id === PID);
  console.log(`\n  我方座位: ${me.seat}`);

  if (s.actorSeat === me.seat) {
    const toCall = s.currentBet - me.bet;
    console.log(`  轮到我，跟注 ${toCall}`);
    const r = await post('/api/action', { room: ROOM, pid: PID, action: toCall > 0 ? 'call' : 'check' });
    console.log('  结果:', JSON.stringify(r.data), r.status);
  } else {
    console.log('  现在不轮到我');
  }

  // 验证过去的错误动作被拒绝
  const bad = await post('/api/action', { room: ROOM, pid: PID, action: 'raise', amount: 5 });
  console.log('\n  非法加注返回值:', bad.status, JSON.stringify(bad.data));

  const bad2 = await post('/api/action', { room: ROOM, pid: PID, action: 'fold' });
  console.log('  非本回合行动返回值:', bad2.status, JSON.stringify(bad2.data));
})();
