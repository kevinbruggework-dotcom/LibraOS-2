const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.end('LibraOS relay running');
});

const wss = new WebSocketServer({ server });

const clients = new Map();
const tokens = new Map();
const groups = new Map();

wss.on('connection', (ws) => {
  let id = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {

      case 'REGISTER':
        id = msg.id;
        clients.set(id, ws);
        break;

      case 'DM':
        const target = clients.get(msg.to);
        if (target) target.send(JSON.stringify(msg));
        break;

      case 'CONTACT_REQUEST': {
        const t = clients.get(msg.to);
        if (t) t.send(JSON.stringify(msg));
        break;
      }

      case 'CONTACT_ACCEPT': {
        const t = clients.get(msg.to);
        if (t) t.send(JSON.stringify(msg));
        break;
      }

      case 'GROUP_CREATE':
        groups.set(msg.groupId, {
          members: [msg.creator],
          key: msg.key
        });
        break;

      case 'GROUP_JOIN': {
        const g = groups.get(msg.groupId);
        if (!g) return;

        g.members.push(msg.user);
        g.members.forEach(m => {
          if (m !== msg.user) {
            const t = clients.get(m);
            if (t) t.send(JSON.stringify(msg));
          }
        });
        break;
      }

      case 'GROUP_MSG': {
        const g = groups.get(msg.groupId);
        if (!g) return;

        g.members.forEach(m => {
          if (m !== msg.from) {
            const t = clients.get(m);
            if (t) t.send(JSON.stringify(msg));
          }
        });
        break;
      }

      case 'TOKEN_CREATE':
        tokens.set(msg.token, {
          from: msg.from,
          data: msg.data,
          exp: Date.now() + 600000
        });
        break;

      case 'TOKEN_REDEEM': {
        const t = tokens.get(msg.token);
        if (!t || Date.now() > t.exp) return;

        tokens.delete(msg.token);

        const target = clients.get(t.from);
        if (target) {
          target.send(JSON.stringify({
            type: 'TOKEN_OK',
            from: msg.from,
            data: t.data
          }));
        }
        break;
      }

      case 'CALL_SIGNAL': {
        const t = clients.get(msg.to);
        if (t) t.send(JSON.stringify(msg));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (id) clients.delete(id);
  });
});

server.listen(process.env.PORT || 3000);
