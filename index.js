'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LibraOS-4677 relay v6 — operational');
});

const wss = new WebSocketServer({ server });

// clientId → WebSocket
const clients = new Map();
// groupId  → Set<clientId>
const groups  = new Map();
// token    → { fromId, fromAlias, groupId, groupName, expires }
const tokens  = new Map();
// clientId → [{ payload, ts }]   (48-hour offline queue, max 300 per user)
const queue   = new Map();
// clientId → { count, resetAt }
const rates   = new Map();

const MAX_Q    = 300;
const Q_TTL    = 48 * 60 * 60 * 1000;
const RATE_MAX = 150;
const RATE_WIN = 60 * 1000;
const MSG_MAX  = 600 * 1024; // 600 KB

function rateOK(id) {
  const now = Date.now();
  let r = rates.get(id);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + RATE_WIN }; rates.set(id, r); }
  if (r.count >= RATE_MAX) return false;
  r.count++; return true;
}

function gJoin(gid, id) { if (!groups.has(gid)) groups.set(gid, new Set()); groups.get(gid).add(id); }
function gLeave(gid, id) { const s = groups.get(gid); if (s) { s.delete(id); if (!s.size) groups.delete(gid); } }
function gLeaveAll(id) { for (const [gid] of groups) gLeave(gid, id); }

function enqueue(toId, payload) {
  if (!queue.has(toId)) queue.set(toId, []);
  const q = queue.get(toId);
  q.push({ payload, ts: Date.now() });
  if (q.length > MAX_Q) q.shift();
}

function flushQueue(id, ws) {
  const q = queue.get(id); if (!q || !q.length) return;
  const now = Date.now();
  q.filter(m => now - m.ts < Q_TTL).forEach(m => {
    try { ws.send(JSON.stringify(m.payload)); } catch {}
  });
  queue.delete(id);
}

function relay(toId, payload) {
  const c = clients.get(toId);
  if (c && c.readyState === 1) { c.send(JSON.stringify(payload)); return true; }
  enqueue(toId, payload); return false;
}

function gcast(gid, fromId, payload) {
  const s = groups.get(gid); if (!s) return;
  const out = JSON.stringify(payload);
  for (const mid of s) {
    if (mid === fromId) continue;
    const c = clients.get(mid);
    if (c && c.readyState === 1) c.send(out);
    else enqueue(mid, payload);
  }
}

wss.on('connection', ws => {
  let myId = null;

  ws.on('message', raw => {
    if (raw.length > MSG_MAX) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (myId && m.type !== 'PING' && !rateOK(myId)) {
      ws.send(JSON.stringify({ type: 'RATE_LIMITED' })); return;
    }

    switch (m.type) {

      case 'REGISTER':
        if (!m.clientId || typeof m.clientId !== 'string' || m.clientId.length > 64) return;
        myId = m.clientId;
        clients.set(myId, ws);
        ws.send(JSON.stringify({ type: 'REGISTERED' }));
        flushQueue(myId, ws);
        break;

      case 'DM':
        if (m.to && m.enc) relay(m.to, { type: 'DM', from: m.from, enc: m.enc });
        break;

      case 'GROUP_JOIN':
        if (myId && m.groupId) gJoin(m.groupId, myId);
        break;

      case 'GROUP_LEAVE':
        if (myId && m.groupId) gLeave(m.groupId, myId);
        break;

      case 'GROUP_MSG':
        if (m.groupId && m.enc) gcast(m.groupId, m.from, { type: 'GROUP_MSG', groupId: m.groupId, from: m.from, enc: m.enc });
        break;

      case 'CREATE_INVITE':
        if (!m.token || !m.fromId) return;
        tokens.set(m.token, { fromId: m.fromId, fromAlias: m.fromAlias || '', groupId: m.groupId || null, groupName: m.groupName || null, expires: Date.now() + 10 * 60 * 1000 });
        ws.send(JSON.stringify({ type: 'INVITE_CREATED', token: m.token }));
        break;

      case 'REDEEM_INVITE': {
        const e = tokens.get(m.token);
        if (!e) { ws.send(JSON.stringify({ type: 'INVITE_INVALID', reason: 'not_found' })); break; }
        if (Date.now() > e.expires) { tokens.delete(m.token); ws.send(JSON.stringify({ type: 'INVITE_INVALID', reason: 'expired' })); break; }
        tokens.delete(m.token);
        ws.send(JSON.stringify({ type: 'INVITE_REDEEMED', fromId: e.fromId, fromAlias: e.fromAlias, groupId: e.groupId, groupName: e.groupName, redeemerId: m.myId, redeemerAlias: m.myAlias }));
        relay(e.fromId, { type: 'INVITE_ACCEPTED', redeemerId: m.myId, redeemerAlias: m.myAlias, groupId: e.groupId });
        break;
      }

      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG' }));
        break;
    }
  });

  ws.on('close', () => { if (myId) { clients.delete(myId); gLeaveAll(myId); } });
  ws.on('error', () => { if (myId) { clients.delete(myId); gLeaveAll(myId); } });
});

// Cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of tokens) if (now > e.expires) tokens.delete(t);
  for (const [id, q] of queue) { const f = q.filter(m => now - m.ts < Q_TTL); if (!f.length) queue.delete(id); else queue.set(id, f); }
  for (const [id, r] of rates) if (now > r.resetAt) rates.delete(id);
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('LibraOS relay v6 :%d', PORT));
