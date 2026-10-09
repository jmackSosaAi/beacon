#!/usr/bin/env node
// Imports the Active table of finance/subscriptions.md (local, git-ignored) into Beacon known_subscriptions.
// Only name, monthly amount and billing day leave the laptop; card, notes and statement text stay local (DATA.md C4).
// Usage: node scripts/import-subscriptions.mjs [--dry-run]   (dry run prints the JSON and sends nothing)
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const base='https://your-worker.example.workers.dev';
const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.replace(/\*\*|__|`/g,'').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').trim());
export function parseActive(markdown){
 const lines=String(markdown).split('\n'),start=lines.findIndex(l=>/^##\s+Active\b/i.test(l));if(start<0)throw new Error('No "## Active" section in subscriptions.md');
 const table=[];for(const l of lines.slice(start+1)){if(/^#{1,2}\s/.test(l))break;if(/^\s*\|/.test(l))table.push(l);else if(table.length&&l.trim())break;}
 if(table.length<2)throw new Error('No table under "## Active"');
 const head=cells(table[0]).map(h=>h.toLowerCase()),col=re=>head.findIndex(h=>re.test(h));
 const [n,a,d]=[col(/service|name|merchant/),col(/monthly|amount|cost|price/),col(/bills|day|renew/)];if(n<0||a<0)throw new Error('Active table needs Service and Monthly columns');
 const out=[];
 for(const row of table.slice(1).filter(l=>!/^[\s|:-]+$/.test(l)).map(cells)){
  const name=(row[n]||'').replace(/\s+/g,' ').slice(0,60),amount=Number(/\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/.exec(row[a]||'')?.[1]?.replace(/,/g,'')),day=Number(/\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(d<0?'':row[d]||'')?.[1]);
  if(!name||!(amount>0))continue;
  out.push({name,amount,cadence:'monthly',...(day>=1&&day<=31?{billing_day:day}:{})});
 }
 return out;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const subscriptions=parseActive(readFileSync(new URL('../../finance/subscriptions.md',import.meta.url),'utf8'));
 if(!subscriptions.length)throw new Error('No active subscriptions found');
 if(process.argv.includes('--dry-run'))console.log(JSON.stringify({subscriptions,replace:true},null,2));
 else{
  const r=await fetch(base+'/api/import/subscriptions',{method:'POST',headers:{'X-Jarvis-Admin-Key':readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim(),'Content-Type':'application/json'},body:JSON.stringify({subscriptions,replace:true})});
  const result=await r.json();if(!r.ok)throw new Error(result.error||'Import failed');console.log(result);
 }
}
