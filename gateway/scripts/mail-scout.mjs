#!/usr/bin/env node
// Inbox scout: tallies recurring bulk senders in both Google accounts over the last N days (default 90)
// and writes a numbered report to research/mail-scout/ (git-ignored). Read-only; nothing is unsubscribed.
// Usage: node scripts/mail-scout.mjs [days]
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
const base='https://your-worker.example.workers.dev',key=readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim();
const days=Number(process.argv[2])||90;
async function api(path,data){const r=await fetch(base+'/api'+path,{method:data?'POST':'GET',headers:{'X-Jarvis-Admin-Key':key,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const out=await r.json();if(!r.ok)throw new Error(out.error||r.status);return out;}
const LABEL={personal:'Personal Gmail (owner@example.com)',school:'UChicago (owner@uchicago.edu)'};
const day=iso=>iso?iso.slice(0,10):'';
const how=s=>s.unsub_oneclick?'one-click':s.unsub_http?'link':s.unsub_mailto?'email only':'none';
const cell=v=>String(v??'').replace(/\|/g,'/').replace(/\s+/g,' ');
let n=0,out=`# Inbox scout — ${new Date().toISOString().slice(0,10)}\n\nRecurring bulk senders over the last ${days} days (mail from people is not listed). Per month = count ÷ ${(days/30).toFixed(1)}.\nReply with the numbers to unsubscribe from (e.g. "1-12, 15, 40"). "one-click" can be done automatically; "link" needs a web page; "email only" needs an email sent from your account (you'd do those yourself).\n`;
for(const account of ['personal','school']){
  let page=null,scanned=0,pages=0;
  // Gmail rate-limits bursts: pause between pages and back off (up to ~4 minutes) when limited.
  const scan=async body=>{for(let wait=15000;;wait*=2){try{return await api('/mail/scan',body);}catch(e){if(!/rateLimit|429/.test(e.message)||wait>120000)throw e;process.stdout.write(` (rate limited, waiting ${wait/1000}s)`);await new Promise(r=>setTimeout(r,wait));}}};
  try{do{const r=await scan({account,days,page});scanned+=r.scanned;page=r.next;process.stdout.write(`\r${account}: ${scanned} messages`);await new Promise(r=>setTimeout(r,2000));}while(page&&++pages<250);}
  catch(e){console.log(`\n${account}: ${e.message}`);out+=`\n## ${LABEL[account]}\n\nNot scanned: ${/scope/.test(e.message)?'account not connected':e.message}.\n`;continue;}
  console.log();
  const {senders}=await api(`/mail/scan-report?account=${account}`);
  out+=`\n## ${LABEL[account]}\n\n${scanned} messages scanned, ${senders.length} recurring bulk senders.\n\n| # | Sender | Name | Count | Per month | Last | Unsubscribe | Latest subject |\n|---|---|---|---|---|---|---|---|\n`;
  for(const s of senders)out+=`| ${++n} | ${cell(s.sender)} | ${cell(s.name)} | ${s.count} | ${(s.count/(days/30)).toFixed(1)} | ${day(s.last_at)} | ${how(s)} | ${cell(s.subject)} |\n`;
}
const dir=new URL('../../research/mail-scout/',import.meta.url);mkdirSync(dir,{recursive:true});
const file=new URL(`${new Date().toISOString().slice(0,10)}.md`,dir);writeFileSync(file,out,{mode:0o600});
console.log(file.pathname);
