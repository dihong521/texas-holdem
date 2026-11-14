'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('./src/room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const hub = new Hub();
const STARTED_AT = Date.now();
const VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try { rel = decodeURIComponent(rel); } catch (e) { /* 保持原样 */ }

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('禁止访问');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 未找到');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (p === '/status' || p === '/status/') {
      return serveStatic(req, res, '/status.html');
    }

    if (p === '/api/status') {
      return sendJson(res, 200, buildStatus());
    }

    if (p === '/api/create' && req.method === 'POST') {
      const room = hub.createRoom();
      return sendJson(res, 200, { room: room.id });
    }

    if (p === '/api/join' && req.method === 'POST') {
      const body = await readBody(req);
      const room = hub.getRoom(body.room);
      if (!room) return sendJson(res, 404, { error: '房间不存在，检查一下房间号' });
      const player = room.addPlayer(body.name, false, body.pid);
      if (!player) return sendJson(res, 409, { error: '房间坐满了' });
      return sendJson(res, 200, { pid: player.id, room: room.id });
    }

    if (p === '/api/addai' && req.method === 'POST') {
      const body = await readBody(req);
      const room = hub.getRoom(body.room);
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      if (!room.seats.some(x => x && x.id === body.pid)) {
        return sendJson(res, 403, { error: '请先坐下再加入机器人' });
      }
      const player = room.addAI();
      if (!player) return sendJson(res, 409, { error: '房间坐满了' });
      return sendJson(res, 200, { pid: player.id });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const body = await readBody(req);
      const room = hub.getRoom(body.room);
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const seat = room.seats.findIndex(x => x && x.id === body.pid);
      if (seat < 0) return sendJson(res, 403, { error: '你不在这个房间' });
      try {
        room.act(seat, body.action, body.amount);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      const room = hub.getRoom(body.room);
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      try {
        room.startNextHand(body.pid);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/leave' && req.method === 'POST') {
      const body = await readBody(req);
      const room = hub.getRoom(body.room);
      if (room && body.pid) room.removePlayer(body.pid);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/state') {
      const room = hub.getRoom(url.searchParams.get('room'));
      const pid = url.searchParams.get('pid');
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      return sendJson(res, 200, room.snapshot(pid || ''));
    }

    if (p === '/events') {
      const room = hub.getRoom(url.searchParams.get('room'));
      const pid = url.searchParams.get('pid');
      if (!room || !pid) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('缺少参数');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      room.subscribe(pid, res);
      return;
    }

    serveStatic(req, res, p);
  } catch (e) {
    sendJson(res, 500, { error: e.message || '服务器错误' });
  }
});

// SSE 心跳，防止代理/浏览器断开
const heartbeat = setInterval(() => {
  for (const room of hub.rooms.values()) {
    for (const set of room.subscribers.values()) {
      for (const res of set) {
        try { res.write(': ping\n\n'); } catch (e) { /* 忽略 */ }
      }
    }
  }
}, 20000);
if (heartbeat.unref) heartbeat.unref();

// 服务状态：房间、玩家、内存占用，给 /status 页面和 status.bat 用
function buildStatus() {
  const addrs = lanAddresses();
  const mem = process.memoryUsage();
  const rooms = [];

  let totalHumans = 0;
  let totalBots = 0;
  let activeHands = 0;

  for (const room of hub.rooms.values()) {
    const seated = room.seats.filter(Boolean);
    const humans = seated.filter(p => !p.isAI);
    const bots = seated.filter(p => p.isAI);
    const online = humans.filter(p => p.connected).length;

    totalHumans += humans.length;
    totalBots += bots.length;
    if (room.phase !== 'waiting' && room.phase !== 'showdown') activeHands++;

    const host = seated.find(p => p.id === room.hostId);

    rooms.push({
      id: room.id,
      phase: room.phase,
      handNo: room.handNo,
      pot: room.potSize(),
      seated: seated.length,
      maxSeats: room.seats.length,
      humans: humans.length,
      online,
      bots: bots.length,
      host: host ? host.name : null,
      audience: room.subscribers.size,
      players: seated.map(p => ({
        name: p.name,
        isAI: p.isAI,
        chips: p.chips,
        connected: p.connected,
        folded: p.folded,
      })),
      idleSec: Math.round((Date.now() - room.lastActivity) / 1000),
    });
  }

  rooms.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ok: true,
    version: VERSION,
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    port: PORT,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    startedAt: STARTED_AT,
    addresses: addrs.map(a => ({ ip: a.address, iface: a.name })),
    memory: {
      rssMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
    },
    totals: {
      rooms: rooms.length,
      humans: totalHumans,
      online: rooms.reduce((s, r) => s + r.online, 0),
      bots: totalBots,
      connections: rooms.reduce((s, r) => s + r.audience, 0),
      activeHands,
    },
    rooms,
  };
}

function lanAddresses() {
  const out = [];
  // 过滤掉 Docker / 虚拟机 / VPN 之类的虚拟网卡，只留真实局域网口
  const skip = /(virtual|vmware|vbox|hyper-?v|vethernet|wsl|docker|loopback|tailscale|zerotier|^tap|^tun|^utun)/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (!list || skip.test(name)) continue;
    for (const a of list) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('198.18.')) {
        out.push({ name, address: a.address });
      }
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ♠ ♥ ♦ ♣  德州扑克已启动');
  console.log('');
  console.log(`  本机访问：  http://localhost:${PORT}`);
  const addrs = lanAddresses();
  if (addrs.length) {
    for (const a of addrs) {
      console.log(`  局域网访问：http://${a.address}:${PORT}   (${a.name})  ← 手机连同一个 WiFi 用这个`);
    }
  } else {
    console.log('  未检测到局域网地址，请确认电脑已连接 WiFi/网线');
  }
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个端口启动：PORT=3001 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
