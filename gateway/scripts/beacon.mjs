#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
const base='https://your-worker.example.workers.dev';
const dir=homedir()+'/.config/jarvis';
const key=readFileSync(dir+'/gateway_key','utf8').trim();
const adminKey=()=>readFileSync(dir+'/admin_key','utf8').trim();
// Login links, status and the scheduler use the laptop-only admin key; imports use the service key.
const ADMIN=new Set(['/access-link','/snapshot','/tick']);
async function api(path,data){const auth=ADMIN.has(path)?{'X-Jarvis-Admin-Key':adminKey()}:{'X-Jarvis-Key':key};const r=await fetch(base+'/api'+path,{method:data===undefined?'GET':'POST',headers:{...auth,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});const result=await r.json();if(!r.ok)throw new Error(result.error||'Request failed');return result;}
const [command,file]=process.argv.slice(2);
if(command==='access-link'){
 const {url}=await api('/access-link',{});mkdirSync(dir,{recursive:true,mode:0o700});
 const path=dir+'/open-beacon.html';
 writeFileSync(path,`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open your Beacon</title><style>body{font:20px system-ui;max-width:600px;margin:15vh auto;padding:24px;color:#203e32}a{display:inline-block;padding:16px 24px;background:#203e32;color:white;border-radius:8px}</style><h1>Your Beacon is ready</h1><p>This private link signs in one device and expires after 15 minutes. Delete this file after you open it.</p><a href="${url}">Open Beacon</a><p>Then enable notifications under Connections. For iPhone, add Beacon to your Home Screen first.</p>`,{mode:0o600});
 console.log(path);
}else if(command==='voice-pin'){
 // Reads a 6+ digit PIN without echoing it and stores only its hash as a Worker secret.
 const {createInterface}=await import('node:readline');const {spawnSync}=await import('node:child_process');const {createHash}=await import('node:crypto');
 if(!process.stdin.isTTY)throw new Error('Run this in a regular terminal window (it needs hidden keyboard input).');
 const rl=createInterface({input:process.stdin,output:process.stdout,terminal:true});rl._writeToOutput=()=>{};
 process.stdout.write('New voice PIN (6-12 digits, hidden): ');
 const pin=await new Promise(r=>{let done=false;rl.on('close',()=>{if(!done)r('');});rl.question('',a=>{done=true;rl.close();r(a.trim());});});process.stdout.write('\n');
 if(!/^\d{6,12}$/.test(pin))throw new Error('PIN must be 6-12 digits');
 const digest=createHash('sha256').update('jarvis-voice-pin:v1:'+pin).digest('hex');
 const res=spawnSync('npx',['wrangler','secret','put','VOICE_PIN_HASH'],{input:digest,stdio:['pipe','inherit','inherit']});
 if(res.status!==0)throw new Error('wrangler secret put failed');console.log('Voice PIN set.');
}else if(command==='step-up'){
 // Opens a single-use 15-minute step-up link in the browser where Beacon is signed in; the link is never printed.
 const r=await fetch(base+'/api/step-up',{method:'POST',headers:{'X-Jarvis-Admin-Key':adminKey(),'content-type':'application/json'},body:'{}'}).then(r=>r.json());
 if(!r.url)throw new Error(r.error||'Step-up failed');(await import('node:child_process')).spawnSync('open',[r.url]);console.log('Step-up link opened (15 minutes).');
}else if(command==='status'){
 const s=await api('/snapshot');console.log(JSON.stringify({blocks:s.blocks.length,tasks:s.tasks.length,sources:s.sources,pushDevices:s.pushDevices,voiceReady:s.voiceReady,aiProvider:s.aiProvider},null,2));
}else if(command==='import-calendar'||command==='import-tasks'){
 console.log(await api('/sync/'+(command==='import-calendar'?'calendar':'tasks'),JSON.parse(readFileSync(file,'utf8'))));
}else if(command==='source')console.log(await api('/source',JSON.parse(readFileSync(file,'utf8'))));
else if(command==='tick')console.log(await api('/tick',{}));
else throw new Error('Use access-link, step-up, voice-pin, status, import-calendar FILE, import-tasks FILE, source FILE, or tick.');
