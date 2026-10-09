#!/usr/bin/env node
// Refreshes Beacon's searchable knowledge base from the repo's markdown (never finance/ or mail-scout lists).
//   node scripts/kb-index.mjs          → laptop, admin key
//   node scripts/kb-index.mjs --node   → the Mac node after a pull (Keychain node token)
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=join(dirname(fileURLToPath(import.meta.url)),'../..'),BASE='https://your-worker.example.workers.dev';
const SKIP=/^(finance|gateway|node_modules|\.git|\.claude|\.wrangler|research\/mail-scout)(\/|$)/;
const files=[];(function walk(d){for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name),rel=relative(ROOT,p);if(SKIP.test(rel)||e.name.startsWith('.'))continue;if(e.isDirectory())walk(p);else if(e.name.endsWith('.md')&&statSync(p).size<400000)files.push(rel);}})(ROOT);
// Chunks by heading, about 1500 characters each.
function chunks(text){const out=[];let title='',buf='';const flush=()=>{if(buf.trim())out.push({title,body:buf.trim()});buf='';};
  for(const line of text.split('\n')){const h=/^#{1,4}\s+(.*)/.exec(line);if(h){flush();title=h[1].slice(0,200);continue;}buf+=line+'\n';if(buf.length>1500)flush();}flush();return out;}
const node=process.argv.includes('--node');
const key=node?execFileSync('/usr/bin/security',['find-generic-password','-s','jarvis-node','-a','jarvis','-w'],{encoding:'utf8'}).trim():readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim();
const send=async body=>{const r=await fetch(BASE+(node?'/api/node/kb':'/api/kb/sync'),{method:'POST',headers:{[node?'X-Jarvis-Node-Key':'X-Jarvis-Admin-Key']:key,'content-type':'application/json'},body:JSON.stringify(body)});const o=await r.json();if(!r.ok)throw new Error(o.error||r.status);return o;};
const docs=files.map(path=>{const text=readFileSync(join(ROOT,path),'utf8');return {path,hash:createHash('sha256').update(text).digest('hex'),chunks:chunks(text)};});
let batch=[],size=0,changed=0,removed=0;
for(const d of docs){const s=JSON.stringify(d).length;if(size+s>600000&&batch.length){changed+=(await send({docs:batch})).changed;batch=[];size=0;}batch.push(d);size+=s;}
const last=await send({docs:batch,paths:files});changed+=last.changed;removed+=last.removed;
console.log(`Knowledge base: ${files.length} files, ${changed} updated, ${removed} removed.`);
