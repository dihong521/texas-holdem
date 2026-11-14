'use strict';

// 完整对局：1 个真人（用 HTTP 接口操作）+ 3 个 AI，连打 5 手，验证筹码守恒
const BASE = 'http://localhost:3000';
const NAMES = ['小李', '老王', '阿明'];

const post = (p, b) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

const getState = async (room, pid) =>
  (await fetch(`${BASE}/api/state?room=${room}&pid=${pid}`)).json();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { data: created } = await post('/api/create', {});
  const room = created.room;
  const humans = [];
  for (const n of NAMES) {
    const { data } = await post('/api/join', { room, name: n });
    humans.push(data.pid);
  }
  console.log(`房间 ${room}，3 位真人入座\n`);

  // 补 3 个 AI，凑成一桌 6 人
  for (let i = 0; i < 3; i++) {
    await post('/api/addai', { room, pid: humans[0] });
  }

  // 每手结束后检查筹码守恒
  const startChips = {};
  let handsPlayed = 0;
  let actions = 0;
  let errors = 0;
  let sawShowdown = false;
  let sawAllIn = false;

  const t0 = Date.now();
  let lastHand = 0;

  while (handsPlayed < 5 && Date.now() - t0 < 120000) {
    const s = await getState(room, humans[0]);

    // 一手结束：房主点「开始下一手」
    if (s.phase === 'showdown' && s.awaitingNext) {
      if (s.handNo > lastHand) lastHand = s.handNo;
      handsPlayed = s.handNo;
      sawShowdown = true;
      const r = await post('/api/start', { room, pid: humans[0] });
      if (r.status !== 200) console.log('  开始下一手失败:', r.data.error);
      await sleep(250);
      continue;
    }

    if (s.phase === 'waiting' || s.phase === 'closed') { await sleep(300); continue; }

    const me = s.seats.find((p) => p && p.id === humans[0]);
    if (!me) { await sleep(300); continue; }

    if (s.actorSeat === me.seat && !me.folded && !me.allIn) {
      const toCall = s.currentBet - me.bet;
      let action = toCall > 0 ? 'call' : 'check';
      let amount;
      // 偶尔加注，覆盖加注路径
      if (Math.random() < 0.25 && me.bet + me.chips > s.currentBet) {
        action = 'raise';
        amount = Math.min(me.bet + me.chips, s.minRaiseTo + Math.round(s.pot * 0.5));
      }
      const r = await post('/api/action', { room, pid: humans[0], action, amount });
      if (r.status !== 200) {
        const r2 = await post('/api/action', { room, pid: humans[0], action: toCall > 0 ? 'call' : 'check' });
        if (r2.status !== 200) { console.log('  动作失败:', r2.data.error); errors++; }
      }
      actions++;
    }

    // 另外两个真人也自己操作，验证多人类玩家
    for (let i = 1; i < humans.length; i++) {
      const p = s.seats.find((x) => x && x.id === humans[i]);
      if (p && s.actorSeat === p.seat && !p.folded && !p.allIn) {
        const tc = s.currentBet - p.bet;
        await post('/api/action', { room, pid: humans[i], action: tc > 0 ? 'call' : 'check' });
      }
    }

    await sleep(250);
  }

  const final = await getState(room, humans[0]);
  console.log('\n最终状态：');
  for (const p of final.seats) {
    if (!p) continue;
    console.log(`  ${p.name}${p.isAI ? '[AI]' : '[人]'}  筹码 ${p.chips}${p.folded ? ' (弃牌)' : ''}`);
  }
  const initialTotal = 6 * 10000; // 3 真人 + 3 AI，各 1 万
  const total = final.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0) + final.pot;
  const lost = initialTotal - total;
  // 被淘汰的人最多带走 20 筹码（低于一个大盲才出局），所以差额应在这个范围内
  const ok = lost >= 0 && lost < 6 * 20;

  console.log(`\n  手数: ${final.handNo}  动作数: ${actions}  错误: ${errors}`);
  console.log(`  筹码总额: ${total}  初始: ${initialTotal}  差额: ${lost}  ${ok ? '✅ 没有凭空生钱' : '❌ 账目异常'}`);
  console.log(`  摊牌出现过: ${sawShowdown ? '是' : '否'}`);

  // 清理
  for (const pid of humans) await post('/api/leave', { room, pid });

  process.exit(ok && errors === 0 && handsPlayed >= 5 ? 0 : 1);
}

main();
