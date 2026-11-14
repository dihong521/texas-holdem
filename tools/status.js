'use strict';

/**
 * 查询服务状态并输出中文报告。
 * 用法：node tools/status.js [端口]
 */

const http = require('http');

const PORT = Number(process.argv[2]) || 3000;

const PHASE_CN = {
  waiting: '等待中',
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌',
  closed: '已解散',
};

function fetchStatus() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 3000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

const LINE = '============================================';

(async () => {
  console.log(LINE);
  console.log(`   德州扑克服务状态   (端口 ${PORT})`);
  console.log(LINE);
  console.log('');

  const d = await fetchStatus();

  if (!d) {
    console.log('   ❌ 服务没有响应');
    console.log('');
    console.log(`   端口 ${PORT} 上没有正在监听的进程。`);
    console.log('   可能服务没启动，或者用了别的端口。');
    console.log('');
    console.log('   启动命令： start.bat');
    console.log(LINE);
    process.exit(1);
  }

  console.log('   ✅ 运行中');
  console.log('');
  console.log(`   版本       ${d.version}`);
  console.log(`   Node       ${d.node}`);
  console.log(`   进程 PID   ${d.pid}`);
  console.log(`   已运行     ${fmtUptime(d.uptimeSec)}`);
  console.log(`   内存占用   ${d.memory.rssMB} MB (堆 ${d.memory.heapMB} MB)`);
  console.log('');

  console.log('   房间总数   ' + d.totals.rooms);
  console.log('   在线真人   ' + d.totals.online + ' / ' + d.totals.humans + ' 位入座');
  console.log('   AI 机器人  ' + d.totals.bots);
  console.log('   实时连接   ' + d.totals.connections + ' 条');
  console.log('   进行中     ' + d.totals.activeHands + ' 桌');
  console.log('');

  console.log('   访问地址：');
  console.log(`     http://localhost:${d.port}`);
  for (const a of d.addresses) {
    console.log(`     http://${a.ip}:${d.port}   (${a.iface})`);
  }
  console.log('');

  if (d.rooms.length) {
    console.log('   房间明细：');
    for (const r of d.rooms) {
      const phase = PHASE_CN[r.phase] || r.phase;
      console.log('');
      console.log(`     ├ 房间 ${r.id}   ${phase}   座位 ${r.seated}/${r.maxSeats}`);
      console.log(`       手数 ${r.handNo}   底池 ${r.pot}   房主 ${r.host || '无'}`);
      for (const p of r.players) {
        const icon = p.isAI ? '🤖' : '👤';
        const state = p.isAI ? 'AI' : (p.connected ? '在线' : '离线');
        const host = p.name === r.host ? ' (房主)' : '';
        const fold = p.folded ? ' 已弃牌' : '';
        console.log(`       ${icon} ${p.name}${host}   ${p.chips}   [${state}]${fold}`);
      }
    }
  } else {
    console.log('   目前没有房间。');
  }

  console.log('');
  console.log(`   浏览器查看详情： http://localhost:${PORT}/status`);
  console.log(LINE);
})();
