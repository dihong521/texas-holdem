'use strict';

// 验证 SSE 推送：连上后应立刻收到一帧状态，加入机器人后应再收到推送
async function main() {
  const B = 'http://localhost:3000';
  const post = (p, b) => fetch(B + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }).then((r) => r.json());

  const { room } = await post('/api/create', {});
  const a = await post('/api/join', { room, name: '真人A' });
  const b = await post('/api/join', { room, name: '真人B' });
  console.log('房间', room);

  const res = await fetch(`${B}/events?room=${room}&pid=${a.pid}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let frames = 0;

  const timer = setTimeout(() => {
    console.log(`超时：收到 ${frames} 帧`);
    process.exit(frames > 0 ? 0 : 1);
  }, 8000);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;

      frames++;
      const s = JSON.parse(line.slice(6));
      console.log(`帧#${frames} 阶段=${s.phase} 座位=${s.seats.filter(Boolean).length} 我的座位=${s.me.seat}`);

      if (frames === 1) await post('/api/addai', { room, pid: a.pid });
      if (frames >= 3) {
        clearTimeout(timer);
        console.log('\nSSE 正常，共收到', frames, '帧');
        reader.cancel();
        process.exit(0);
      }
    }
  }
}

main();
