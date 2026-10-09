#!/usr/bin/env node
// Imports tracker/outreach.md into Beacon (POST /api/import/outreach, admin key) so the Worker can send 7/14-day follow-up nudges.
// Only id, name, organization, sent/last-reply dates, status and an optional email domain leave the laptop; notes and next steps stay local.
// Usage: node scripts/import-outreach.mjs [--dry-run]   (dry run prints the JSON and sends nothing)
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const base='https://your-worker.example.workers.dev';
const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.replace(/\*\*|__|`/g,'').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').trim());
const slug=v=>v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50);
const date=v=>/\b(\d{4}-\d{2}-\d{2})\b/.exec(v||'')?.[1]||null;
// Every table whose header has Name and Organization columns. Rows without a name are skipped.
export function parseOutreach(markdown){
 const lines=String(markdown).split('\n'),out=[];
 for(let i=0;i<lines.length;i++){
  if(!/^\s*\|/.test(lines[i])||!/^\s*\|[\s|:-]+\|\s*$/.test(lines[i+1]||''))continue;
  const head=cells(lines[i]).map(h=>h.toLowerCase()),col=re=>head.findIndex(h=>re.test(h));
  const [n,o,s,st,r,e]=[col(/^name$|contact/),col(/org|company|firm/),col(/^sent/),col(/^status/),col(/last repl|replied/),col(/e-?mail|domain/)];
  if(n<0||o<0)continue;
  for(i+=2;i<lines.length&&/^\s*\|/.test(lines[i]);i++){
   const row=cells(lines[i]),name=(row[n]||'').replace(/\s+/g,' ').slice(0,80),org=(row[o]||'').replace(/\s+/g,' ').slice(0,120);
   if(!name||!org)continue;
   const domain=/(?:@|^)((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec(e<0?'':row[e]||'')?.[1]?.toLowerCase();
   out.push({id:`${slug(name)}--${slug(org)}`,name,org,sent_at:date(s<0?'':row[s]),last_reply_at:date(r<0?'':row[r]),status:(st<0?'':row[st]||'').slice(0,40),...(domain?{domain}:{})});
  }
 }
 return out;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const outreach=parseOutreach(readFileSync(new URL('../../tracker/outreach.md',import.meta.url),'utf8'));
 if(!outreach.length)throw new Error('No outreach rows found in tracker/outreach.md');
 if(process.argv.includes('--dry-run'))console.log(JSON.stringify({outreach,replace:true},null,2));
 else{
  const r=await fetch(base+'/api/import/outreach',{method:'POST',headers:{'X-Jarvis-Admin-Key':readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim(),'Content-Type':'application/json'},body:JSON.stringify({outreach,replace:true})});
  const result=await r.json();if(!r.ok)throw new Error(result.error||'Import failed');console.log(result);
 }
}
