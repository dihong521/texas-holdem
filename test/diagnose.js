'use strict';

// 逐手核对筹码，找出漏洞
const { Room } = require('../src/room');

const room = new Room('diag');
room.scheduleActor = () => {};
room.broadcast = () => {};
room.sweep = () => {};
room.bustOut = () => {};   // 关掉淘汰，保证筹码不离开桌面，方便核对

// 第一个留成真人，否则「没有真人就解散」会清空房间
for (let i = 0; i < 6; i++) room.addPlayer('P' + i, i !== 0);

let expected = 6 * 10000;
let bad = 0;

for (let h = 1; h <= 200; h++) {
  const before = room.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0);
  const beforePot = room.pot;

  room.startHand();

  let guard = 0;
  while (room.phase !== 'showdown' && room.phase !== 'waiting') {
    if (++guard > 5000) { console.log(`第 ${h} 手死循环`); process.exit(1); }
    if (room.actorSeat < 0) { room.advanceStreet(); continue; }
    room.botAct(room.actorSeat);
  }

  const after = room.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0);

  if (room.nextHandTimer) { clearTimeout(room.nextHandTimer); room.nextHandTimer = null; room.nextHandAt = null; }

  // startHand 里补充的筹码会记在 replenished
  const added = room.replenished;
  expected = 6 * 10000 + added;
  const actual = after;

  if (actual !== expected) {
    bad++;
    console.log(`❌ 第 ${h} 手：实际 ${actual}，应为 ${expected}，差 ${expected - actual}`);
    console.log(`   底池(结算后)=${room.pot} 补充合计=${added}`);
    console.log(`   阶段=${room.phase} 公共牌=${room.community.join(' ')}`);
    for (const p of room.seats) {
      if (p) console.log(`   ${p.name} chips=${p.chips} totalBet=${p.totalBet} folded=${p.folded} allIn=${p.allIn} hole=${p.hole.join(' ')}`);
    }
    console.log(`   日志:\n` + room.log.slice(-16).map((l) => '      ' + l.text).join('\n'));
    if (bad >= 2) break;
  }
  if (beforePot !== 0) console.log(`  ⚠ 第 ${h} 手开始时底池不为 0: ${beforePot}`);
}

if (!bad) console.log('200 手全部守恒，未发现漏洞');
process.exit(bad ? 1 : 0);
