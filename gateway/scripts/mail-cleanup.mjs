#!/usr/bin/env node
// Applies Jackson's picks from an inbox scout report. Usage:
//   node scripts/mail-cleanup.mjs <report.md> <personal|school> --u "2,8,9" --q "5,6"
// u = one-click unsubscribe (manual ones are listed with their link), q = Gmail filter to the Quarantine label.
// Writes results plus one Gmail search per sender (to bulk-delete old mail yourself) next to the report.
import {readFileSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
const base='https://your-worker.example.workers.dev',key=readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim();
const [report,account]=process.argv.slice(2),arg=f=>{const i=process.argv.indexOf(f);return i>0?process.argv[i+1]:'';};
const nums=s=>String(s||'').split(/[\s,]+/).filter(Boolean).flatMap(x=>{const [a,b]=x.split('-').map(Number);return b?Array.from({length:b-a+1},(_,i)=>a+i):[a];});
const section=account==='school'?'## UChicago':'## Personal',text=readFileSync(report,'utf8');
const rows=Object.fromEntries([...text.matchAll(/^\| (\d+) \| ([^ |]+@[^ |]+) \|/gm)].map(m=>[Number(m[1]),m[2]]));
const pick=list=>nums(list).map(n=>rows[n]||(console.log(`#${n} not in report`),null)).filter(Boolean);
async function api(path,data){const r=await fetch(base+'/api'+path,{method:'POST',headers:{'X-Jarvis-Admin-Key':key,'content-type':'application/json'},body:JSON.stringify(data)});const out=await r.json();if(!r.ok)throw new Error(out.error||r.status);return out;}
const batches=(list,n)=>Array.from({length:Math.ceil(list.length/n)},(_,i)=>list.slice(i*n,i*n+n));
const email=account==='school'?'owner@uchicago.edu':'owner@example.com';
let out=`# Inbox cleanup — ${account} (${new Date().toISOString().slice(0,10)})\n`;
for(const [kind,path,list] of [['Unsubscribe','/mail/unsubscribe',pick(arg('--u'))],['Quarantine','/mail/quarantine',pick(arg('--q'))]]){
  if(!list.length)continue;out+=`\n## ${kind}\n\n| Sender | Result | Old mail (search, then select all → delete) |\n|---|---|---|\n`;
  for(const b of batches(list,8)){
    let res;try{res=(await api(path,{account,senders:b})).results;}catch(e){res=b.map(sender=>({sender,status:'error: '+e.message}));}
    for(const r of res){console.log(kind.padEnd(11),r.sender,'→',r.status);out+=`| ${r.sender} | ${r.status}${r.link?` ([open](${r.link}))`:''} | [search](https://mail.google.com/mail/u/${email}/#search/from%3A${encodeURIComponent(r.sender)}) |\n`;}
  }
}
const file=report.replace(/\.md$/,`-cleanup-${account}.md`);appendFileSync(file,out,{mode:0o600});console.log(file);
