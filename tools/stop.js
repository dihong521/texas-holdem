'use strict';

/**
 * 停止占用指定端口的服务。
 * 用法：node tools/stop.js [端口]
 */

const { execSync } = require('child_process');

const PORT = Number(process.argv[2]) || 3000;
const LINE = '============================================';

function findPids() {
  let out = '';
  try {
    out = execSync(`netstat -ano | findstr ":${PORT}"`, {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (e) {
    return [];
  }

  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = cols[cols.length - 1];
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  return [...pids];
}

function main() {
  console.log(LINE);
  console.log(`   停止德州扑克服务   (端口 ${PORT})`);
  console.log(LINE);
  console.log('');

  const pids = findPids();

  if (!pids.length) {
    console.log(`   端口 ${PORT} 上没有正在运行的服务，无需停止。`);
    console.log(LINE);
    return;
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { windowsHide: true, stdio: 'ignore' });
      console.log(`   ✅ 已停止进程 ${pid}`);
    } catch (e) {
      console.log(`   ❌ 停止进程 ${pid} 失败`);
    }
  }

  console.log('');
  console.log('   服务已关闭。房间和筹码数据已清空。');
  console.log(LINE);
}

main();
