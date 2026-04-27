// ═══════════════════════════════════════════════════════
//  LibraOS-4677  —  Relay Server v7
//  Filename: index.js
// ═══════════════════════════════════════════════════════
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LibraOS-4677 relay v7');
});

const wss = new WebSocketServer({ server });

const clients  = new Map(); // id → ws
const groups   = new Map(); // gid → Set<id>
const tokens   = new Map(); // token → entry
const queue    = new Map(); // id → [{payload,ts}]
const rates    = new Map(); // id → {count,resetAt}

const MAX_Q = 400, Q_TTL = 48*60*60*1000, RATE = 150, RATE_W = 60000, MAX_MSG = 700*1024;

function rateOK(id){const n=Date.now();let r=rates.get(id);if(!r||n>r.resetAt){r={count:0,resetAt:n+RATE_W};rates.set(id,r);}if(r.count>=RATE)return false;r.count++;return true;}
function gJoin(gid,id){if(!groups.has(gid))groups.set(gid,new Set());groups.get(gid).add(id);}
function gLeave(gid,id){const s=groups.get(gid);if(s){s.delete(id);if(!s.size)groups.delete(gid);}}
function gLeaveAll(id){for(const[gid]of groups)gLeave(gid,id);}
function enq(toId,payload){if(!queue.has(toId))queue.set(toId,[]);const q=queue.get(toId);q.push({payload,ts:Date.now()});if(q.length>MAX_Q)q.shift();}
function flushQ(id,ws){const q=queue.get(id);if(!q||!q.length)return;const n=Date.now();q.filter(m=>n-m.ts<Q_TTL).forEach(m=>{try{ws.send(JSON.stringify(m.payload));}catch{}});queue.delete(id);}
function relay(toId,payload){const c=clients.get(toId);if(c&&c.readyState===1){c.send(JSON.stringify(payload));return true;}enq(toId,payload);return false;}
function gcast(gid,fromId,payload){const s=groups.get(gid);if(!s)return;const out=JSON.stringify(payload);for(const mid of s){if(mid===fromId)continue;const c=clients.get(mid);if(c&&c.readyState===1)c.send(out);else enq(mid,payload);}}

wss.on('connection',ws=>{
  let myId=null;
  ws.on('message',raw=>{
    if(raw.length>MAX_MSG)return;
    let m;try{m=JSON.parse(raw);}catch{return;}
    if(!m||typeof m!=='object')return;
    if(myId&&m.type!=='PING'&&!rateOK(myId)){ws.send(JSON.stringify({type:'RATE_LIMITED'}));return;}
    switch(m.type){
      case 'REGISTER':
        if(!m.clientId||typeof m.clientId!=='string'||m.clientId.length>64)return;
        myId=m.clientId;clients.set(myId,ws);
        ws.send(JSON.stringify({type:'REGISTERED'}));
        flushQ(myId,ws);
        break;
      case 'DM':
        if(m.to&&m.enc)relay(m.to,{type:'DM',from:m.from,enc:m.enc});
        break;
      case 'GROUP_JOIN':
        if(myId&&m.groupId)gJoin(m.groupId,myId);
        break;
      case 'GROUP_LEAVE':
        if(myId&&m.groupId)gLeave(m.groupId,myId);
        break;
      case 'GROUP_MSG':
        if(m.groupId&&m.enc)gcast(m.groupId,m.from,{type:'GROUP_MSG',groupId:m.groupId,from:m.from,enc:m.enc});
        break;
      case 'CREATE_INVITE':
        if(!m.token||!m.fromId)return;
        tokens.set(m.token,{fromId:m.fromId,fromAlias:m.fromAlias||'',groupId:m.groupId||null,groupName:m.groupName||null,expires:Date.now()+10*60*1000});
        ws.send(JSON.stringify({type:'INVITE_CREATED',token:m.token}));
        break;
      case 'REDEEM_INVITE':{
        const e=tokens.get(m.token);
        if(!e){ws.send(JSON.stringify({type:'INVITE_INVALID',reason:'not_found'}));break;}
        if(Date.now()>e.expires){tokens.delete(m.token);ws.send(JSON.stringify({type:'INVITE_INVALID',reason:'expired'}));break;}
        tokens.delete(m.token);
        ws.send(JSON.stringify({type:'INVITE_REDEEMED',fromId:e.fromId,fromAlias:e.fromAlias,groupId:e.groupId,groupName:e.groupName,redeemerId:m.myId,redeemerAlias:m.myAlias}));
        relay(e.fromId,{type:'INVITE_ACCEPTED',redeemerId:m.myId,redeemerAlias:m.myAlias,groupId:e.groupId});
        break;
      }
      case 'PING':ws.send(JSON.stringify({type:'PONG'}));break;
    }
  });
  ws.on('close',()=>{if(myId){clients.delete(myId);gLeaveAll(myId);}});
  ws.on('error',()=>{if(myId){clients.delete(myId);gLeaveAll(myId);}});
});

setInterval(()=>{
  const n=Date.now();
  for(const[t,e]of tokens)if(n>e.expires)tokens.delete(t);
  for(const[id,q]of queue){const f=q.filter(m=>n-m.ts<Q_TTL);if(!f.length)queue.delete(id);else queue.set(id,f);}
  for(const[id,r]of rates)if(n>r.resetAt)rates.delete(id);
},5*60*1000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('LibraOS relay v7 :%d',PORT));
