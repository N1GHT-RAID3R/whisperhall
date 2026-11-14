import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const MAX_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 20000);
const MAX_TTL = Number(process.env.MAX_TTL_SECONDS || 3600);
const DEFAULT_TTL = Number(process.env.DEFAULT_TTL_SECONDS || 300);
const RATE_WINDOW = 10000;
const RATE_MAX = 20;

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || ORIGINS.length === 0 || ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'OPTIONS']
}));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'whisperhall-relay', uptimeSeconds: Math.floor(process.uptime()) }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
const rooms = new Map();
const publicHistory = new Map();
const secretHistory = new Map();

function cleanText(v, max=2000) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0,max) : ''; }
function cleanHandle(v) { const s=cleanText(v,24).replace(/^@+/, ''); return /^[A-Za-z0-9_-]{1,24}$/.test(s)?s:'Student'; }
function cleanSchool(v) { return cleanText(v,80) || 'Campus Peer'; }
function validRoom(v) { return typeof v==='string' && /^[a-z0-9:_-]{3,128}$/.test(v); }
function ttl(v) { const n=Number(v); return Number.isFinite(n)&&n>0?Math.min(Math.max(Math.floor(n),10),MAX_TTL):DEFAULT_TTL; }
function getRoom(key) { if(!rooms.has(key)) rooms.set(key,new Set()); return rooms.get(key); }
function peers(key) { return [...(rooms.get(key)||[])].filter(c=>c.readyState===WebSocket.OPEN).map(c=>({handle:c.meta.handle,school:c.meta.school,status:c.meta.status})); }
function broadcast(key,payload,except=null) { const data=JSON.stringify(payload); for(const c of rooms.get(key)||[]) if(c!==except&&c.readyState===WebSocket.OPEN)c.send(data); }
function presence(key) { const list=peers(key); broadcast(key,{type:'presence_update',count:list.length,peers:list}); }
function leave(ws) {
 const key=ws.meta?.roomKey;if(!key)return;
 const set=rooms.get(key);if(set){set.delete(ws);if(!set.size)rooms.delete(key);else presence(key);}
 ws.meta.roomKey=null;
}
function join(ws,key) {
 if(!validRoom(key))return false;
 leave(ws);ws.meta.roomKey=key;getRoom(key).add(ws);presence(key);
 if(key==='public:campus-commons')ws.send(JSON.stringify({type:'public_history',messages:(publicHistory.get('campus-commons')||[]).filter(m=>m.expiresAt>Date.now()).slice(-50)}));
 if(key.startsWith('secret:')){const hash=key.slice(7);if(/^[a-f0-9]{64}$/.test(hash))ws.send(JSON.stringify({type:'secret_history',roomHash:hash,envelopes:(secretHistory.get(hash)||[]).filter(m=>m.expiresAt>Date.now()).slice(-50)}));}
 return true;
}
function rateAllowed(meta){const now=Date.now();meta.events=meta.events.filter(t=>now-t<RATE_WINDOW);if(meta.events.length>=RATE_MAX)return false;meta.events.push(now);return true;}
function purge(){const now=Date.now();for(const [k,v] of publicHistory){const a=v.filter(x=>x.expiresAt>now);if(a.length)publicHistory.set(k,a);else publicHistory.delete(k);}for(const [k,v] of secretHistory){const a=v.filter(x=>x.expiresAt>now);if(a.length)secretHistory.set(k,a);else secretHistory.delete(k);}}
setInterval(purge,5000).unref();

server.on('upgrade',(req,socket,head)=>{
 const origin=req.headers.origin;
 if(origin && ORIGINS.length && !ORIGINS.includes(origin)){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
 if(NODE_ENV==='production' && !origin){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});

wss.on('connection',ws=>{
 ws.isAlive=true;ws.meta={handle:'Student',school:'Campus Peer',status:'Online',roomKey:null,events:[]};
 join(ws,'public:campus-commons');
 ws.on('pong',()=>ws.isAlive=true);
 ws.on('message',(raw)=>{
  if(raw.length>MAX_BYTES){ws.send(JSON.stringify({type:'error',message:'Message too large.'}));return;}
  if(!rateAllowed(ws.meta)){ws.send(JSON.stringify({type:'error',message:'Rate limit reached. Please slow down.'}));return;}
  let p;try{p=JSON.parse(raw.toString());}catch{ws.send(JSON.stringify({type:'error',message:'Invalid JSON.'}));return;}
  if(!p||typeof p.type!=='string')return;
  if(p.type==='auth_profile'){
   ws.meta.handle=cleanHandle(p.handle);ws.meta.school=cleanSchool(p.school);ws.meta.status=cleanText(p.status,24)||'Online';
   if(p.roomKey)join(ws,p.roomKey);else if(ws.meta.roomKey)presence(ws.meta.roomKey);
  }else if(p.type==='join_room'){
   if(!join(ws,p.roomKey))ws.send(JSON.stringify({type:'error',message:'Invalid room identifier.'}));
  }else if(p.type==='public_message'){
   if(ws.meta.roomKey!=='public:campus-commons'){ws.send(JSON.stringify({type:'error',message:'Join the public lounge before sending.'}));return;}
   const text=cleanText(p.text,1600);if(!text)return;
   const life=ttl(p.ttlSeconds),now=Date.now();
   const m={id:crypto.randomUUID(),senderHandle:ws.meta.handle,senderSchool:ws.meta.school,text,createdAt:now,expiresAt:now+life*1000,replyTo:p.replyTo&&typeof p.replyTo==='object'?{handle:cleanHandle(p.replyTo.handle),preview:cleanText(p.replyTo.preview,100)}:null};
   const list=publicHistory.get('campus-commons')||[];list.push(m);publicHistory.set('campus-commons',list.slice(-100));
   broadcast('public:campus-commons',{type:'public_message',message:m});
  }else if(p.type==='secret_envelope'){
   const hash=p.roomHash;
   if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||ws.meta.roomKey!==`secret:${hash}`){ws.send(JSON.stringify({type:'error',message:'Join this private room before sending.'}));return;}
   const ciphertext=typeof p.ciphertext==='string'?p.ciphertext:'';const iv=typeof p.iv==='string'?p.iv:'';const salt=typeof p.salt==='string'?p.salt:'';
   if(ciphertext.length>12000||!/^[a-f0-9]+$/i.test(ciphertext)||!/^[a-f0-9]{24}$/i.test(iv)||!/^[a-f0-9]{32}$/i.test(salt)){ws.send(JSON.stringify({type:'error',message:'Invalid encrypted message.'}));return;}
   const life=ttl(p.ttlSeconds),now=Date.now();
   const env={id:crypto.randomUUID(),roomHash:hash,senderHandle:ws.meta.handle,senderSchool:ws.meta.school,ciphertext,iv,salt,createdAt:now,expiresAt:now+life*1000};
   const list=secretHistory.get(hash)||[];list.push(env);secretHistory.set(hash,list.slice(-100));
   broadcast(`secret:${hash}`,{type:'secret_envelope',roomHash:hash,envelope:env});
  }else if(p.type==='ping'){ws.send(JSON.stringify({type:'pong',ts:Date.now()}));}
 });
 ws.on('close',()=>leave(ws));ws.on('error',()=>leave(ws));
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){leave(ws);ws.terminate();continue;}ws.isAlive=false;ws.ping();}},25000);heartbeat.unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`WhisperHall relay listening on ${PORT} (${NODE_ENV})`));
