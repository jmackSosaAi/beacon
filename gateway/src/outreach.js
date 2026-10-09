// Outreach follow-ups (M5, CRITERIA.md "Applications and outreach deadlines"). The Worker can't read the repo, so
// tracker/outreach.md is imported with the admin key (scripts/import-outreach.mjs). Nudges at 7 and 14 days, then move on.
// Beacon never sends outreach (SAFETY.md: Never tier); it only reminds Jackson.
import {clip,scrub} from './mail.js';
import {run,all,notify,isPaused,nowIso} from './service.js';
import {localParts} from './core.js';

const DATE=/^\d{4}-\d{2}-\d{2}$/;
const day=v=>{if(v==null||v==='')return null;const d=String(v).slice(0,10);if(!DATE.test(d)||!Number.isFinite(Date.parse(d)))throw new Error('Dates must be YYYY-MM-DD');return d;};
const text=(v,max)=>clip(scrub(clip(v,max*2)),max);
// A status that means the thread is over or answered. Anything else with a sent date and no reply is still waiting.
export const CLOSED=/^(?!.*\bno (reply|response)\b).*(\brepl(ied|y received)\b|\bresponded\b|\bclosed\b|\bdone\b|declined|dropped|\bmet\b|meeting|scheduled|call (booked|set)|moved on|\bdead\b|rejected|no longer)/i;
export const days=(from,to)=>Math.round((Date.parse(to)-Date.parse(from))/86400000);
const under=(domain,base)=>domain===base||domain.endsWith('.'+base);

// POST /api/import/outreach (admin key). [{id,name,org,sent_at,last_reply_at,status,domain?}] or {outreach:[...],replace?}.
export async function importOutreach(env,input){
  const list=Array.isArray(input)?input:input?.outreach,replace=!Array.isArray(input)&&input?.replace===true;
  if(!Array.isArray(list)||!list.length||list.length>300)throw new Error('1 to 300 outreach rows per import');
  const rows=new Map(),now=nowIso();
  for(const o of list){
    const id=clip(o?.id,120).replace(/[^A-Za-z0-9:._-]/g,'-'),name=text(o?.name,80),org=text(o?.org,120);
    if(!id||!name||!org)throw new Error('Each row needs id, name and org');
    const domain=o.domain==null||o.domain===''?null:String(o.domain).toLowerCase().trim();
    if(domain!==null&&!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain))throw new Error('domain must be a bare domain like example.com');
    rows.set(id,[id,name,org,domain,day(o.sent_at),day(o.last_reply_at),clip(o.status,40).toLowerCase(),now]);
  }
  const statements=[...rows.values()].map(r=>env.DB.prepare('INSERT INTO outreach(id,name,org,domain,sent_at,last_reply_at,status,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,org=excluded.org,domain=excluded.domain,sent_at=excluded.sent_at,last_reply_at=excluded.last_reply_at,status=excluded.status,updated_at=excluded.updated_at').bind(...r));
  if(replace)statements.push(env.DB.prepare(`DELETE FROM outreach WHERE id NOT IN (${[...rows.keys()].map(()=>'?').join(',')})`).bind(...rows.keys()));
  const results=await env.DB.batch(statements);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'outreach:imported',String(rows.size),now);
  return {imported:rows.size,removed:replace?results.at(-1).meta.changes:0};
}

// Sent, no reply on file (tracker or Gmail), status still open.
export async function waiting(env){return (await all(env,'SELECT * FROM outreach WHERE sent_at IS NOT NULL AND last_reply_at IS NULL AND replied_at IS NULL ORDER BY sent_at')).filter(o=>!CLOSED.test(o.status));}

// Scheduler (outside quiet hours, not while paused): one nudge at 7 days and one at 14, deduped by notification id.
// Each nudge has a 7-day window, so a missed day still fires once but nothing older than 21 days ever does.
export async function outreachNudges(env,at=new Date()){
  if(await isPaused(env))return;
  const today=localParts(at).date;
  for(const o of await waiting(env)){
    const d=days(o.sent_at,today),step=d>=14&&d<21?14:d>=7&&d<14?7:null;if(!step)continue;
    await notify(env,{id:`outreach:${o.id}:${step}`,kind:'outreach',title:`📨 Follow up with ${o.name} at ${o.org} — sent ${d} days ago`,body:step===7?'No reply yet. One more nudge at 14 days, then move on.':'Still no reply. Last nudge; after this, move on.'});
  }
}

// Gmail triage: a verified In-Reply-To reply from an outreach contact's domain (or with their name as the sender) marks it replied.
// Best effort only; free-mail domains match by name, never by domain alone.
const FREE=/^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail)\.(com|me)$/;
export async function markReplied(env,domain,from,receivedAt){
  const name=clip(String(from||'').replace(/<.*>/,'').replace(/"/g,''),80).toLowerCase();
  const hits=(await waiting(env)).filter(o=>(o.domain&&domain&&!FREE.test(o.domain)&&under(domain,o.domain))||(name.length>3&&name===o.name.toLowerCase()));
  for(const o of hits){
    await run(env,'UPDATE outreach SET replied_at=? WHERE id=?',receivedAt,o.id);
    await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'outreach:replied',o.id,nowIso());
  }
  return hits.length;
}
