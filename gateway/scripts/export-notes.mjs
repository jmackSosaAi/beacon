#!/usr/bin/env node
// Pulls unexported notes and feedback from Beacon and appends them to the repo:
//   feedback/BEACON_FEEDBACK.md (fix backlog, with context) and notes/INBOX.md (personal notes).
// Then marks them exported. Usage: node scripts/export-notes.mjs [--dry-run]
import {readFileSync,appendFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
const base='https://your-worker.example.workers.dev',key=readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim(),dry=process.argv.includes('--dry-run');
const repo=new URL('../../',import.meta.url).pathname;
const api=async(path,data)=>{const r=await fetch(base+'/api'+path,{method:data?'POST':'GET',headers:{'X-Jarvis-Admin-Key':key,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const j=await r.json();if(!r.ok)throw new Error(j.error||'request failed');return j;};
const {notes}=await api('/notes/export');
if(!notes.length){console.log('Nothing new to export.');process.exit(0);}
const chicago=iso=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'});
const files={feedback:[repo+'feedback','BEACON_FEEDBACK.md','# Beacon feedback\n\nFeedback Jackson gave by call or Telegram, in his words. Work items for fixes; mark done with [x].\n'],note:[repo+'notes','INBOX.md','# Notes inbox\n\nNotes Jackson captured by call or Telegram, in his words.\n']};
for(const kind of ['feedback','note']){
  const rows=notes.filter(n=>n.kind===kind);if(!rows.length)continue;
  const [dir,name,header]=files[kind],path=`${dir}/${name}`;
  const entries=rows.map(n=>{
    if(kind==='note')return `- ${chicago(n.created_at)} (${n.channel}): ${n.text}`;
    let ctx='';try{const c=JSON.parse(n.context||'{}');ctx=(c.recent||[]).map(m=>`  - ${m.role==='assistant'?'Beacon':'Jackson'}: ${m.text.replace(/\s+/g,' ')}`).join('\n');}catch{}
    return `- [ ] ${chicago(n.created_at)} (${n.channel}): ${n.text}${ctx?`\n  <details><summary>Context</summary>\n\n${ctx}\n  </details>`:''}`;
  }).join('\n')+'\n';
  if(dry){console.log(`--- ${name}\n${entries}`);continue;}
  mkdirSync(dir,{recursive:true});if(!existsSync(path))writeFileSync(path,header+'\n');
  appendFileSync(path,entries);console.log(`${rows.length} ${kind} entr${rows.length===1?'y':'ies'} → ${path}`);
}
if(!dry)console.log(await api('/notes/mark-exported',{ids:notes.map(n=>n.id)}));
