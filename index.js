// LibraOS-4677 — Relay Server v4
// Only routes encrypted blobs. Never sees content, passwords, or keys.
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((_, res) => {
  res.writeHead(200); res.end('LibraOS relay v4 — OK');
});
const wss = new WebSocketServer({ server });

const clients   = new Map(); // clientId  → ws
const groups    = new Map(); // groupId   → Set<clientId>
const tokens    = new Map(); // token     → entry

function groupJoin(gid, id)  { if (!groups.has(gid)) groups.set(gid, new Set()); groups.get(gid).add(id); }
function groupLeave(gid, id) { const r = groups.get(gid); if (r) { r.delete(id); if (!r.size) groups.delete(gid); } }
function groupLeaveAll(id)   { for (const [gid] of groups) groupLeave(gid, id); }
function groupcast(gid, from, payload) {
  const r = groups.get(gid); if (!r) return;
  const out = JSON.stringify(payload);
  for (const mid of r) { if (mid === from) continue; const c = clients.get(mid); if (c && c.readyState === 1) c.send(out); }
}
function dm(toId, payload) {
  const c = clients.get(toId); if (c && c.readyState === 1) { c.send(JSON.stringify(payload)); return true; } return false;
}

wss.on('connection', ws => {
  let myId = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {

      case 'REGISTER':
        myId = m.clientId;
        clients.set(myId, ws);
        ws.send(JSON.stringify({ type: 'REGISTERED' }));
        break;

      case 'DM':
        if (!dm(m.to, { type: 'DM', from: m.from, enc: m.enc }))
          ws.send(JSON.stringify({ type: 'OFFLINE', targetId: m.to }));
        break;

      case 'GROUP_JOIN':
        if (myId && m.groupId) groupJoin(m.groupId, myId);
        break;

      case 'GROUP_LEAVE':
        if (myId && m.groupId) groupLeave(m.groupId, myId);
        break;

      case 'GROUP_MSG':
        groupcast(m.groupId, m.from, { type: 'GROUP_MSG', groupId: m.groupId, from: m.from, enc: m.enc });
        break;

      case 'CREATE_INVITE':
        tokens.set(m.token, {
          fromId: m.fromId, fromAlias: m.fromAlias,
          groupId: m.groupId || null, groupName: m.groupName || null,
          expires: Date.now() + 10 * 60 * 1000,
        });
        ws.send(JSON.stringify({ type: 'INVITE_CREATED', token: m.token }));
        break;

      case 'REDEEM_INVITE': {
        const e = tokens.get(m.token);
        if (!e) { ws.send(JSON.stringify({ type: 'INVITE_INVALID', reason: 'not_found' })); break; }
        if (Date.now() > e.expires) { tokens.delete(m.token); ws.send(JSON.stringify({ type: 'INVITE_INVALID', reason: 'expired' })); break; }
        tokens.delete(m.token);
        ws.send(JSON.stringify({ type: 'INVITE_REDEEMED', fromId: e.fromId, fromAlias: e.fromAlias, groupId: e.groupId, groupName: e.groupName, redeemerId: m.myId, redeemerAlias: m.myAlias }));
        dm(e.fromId, { type: 'INVITE_ACCEPTED', redeemerId: m.myId, redeemerAlias: m.myAlias, groupId: e.groupId });
        break;
      }

      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG' }));
        break;
    }
  });

  ws.on('close', () => { if (myId) { clients.delete(myId); groupLeaveAll(myId); } });
  ws.on('error', () => { if (myId) { clients.delete(myId); groupLeaveAll(myId); } });
});

setInterval(() => { const n = Date.now(); for (const [t, e] of tokens) if (n > e.expires) tokens.delete(t); }, 3 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('LibraOS relay v4 on :%d', PORT));
