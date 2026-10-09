// Interaction log (M7 batch 5, decisions/agentic-beacon.md "Interaction log"): one `interactions` row per turn from every
// channel, corrections detected by code from the next message or a button tap (the model never labels them), outcomes
// derived from audit/proposals/action_undo at read time, the /log text, the web Log page rows and the 90-day purge.
// Rows hold his words, tool names/timing/arg keys, the reply (withheld on email_read turns), ids and short error codes:
// never bodies, summaries or raw exception text.
import {all,run,nowIso} from './service.js';
import {turnSignals,correctionSignal,signalStmt} from './signals.js';

const KEEP_DAYS=90,MIN=60000,TEN_MIN=10*MIN,FIFTEEN_MIN=15*MIN,UNDO_FAST_MS=2*MIN,CHUNK=50;
export const ROUTES=['fast:schedule','fast:mail','fast:assignments','fast:next','fast:tasks','followup','undo','agent','command','slash','photo','fell_back','single','limit'];
export const interactionStmt=(env,r)=>env.DB.prepare('INSERT INTO interactions(id,created_at,channel,route,text,tools,reply,reply_len,reply_withheld,action_type,proposal_id,undo_id,note_id,latency_ms,model,input_tokens,output_tokens,cache_read_tokens,kind,error,tainted,demoted,correction_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(r.id||crypto.randomUUID(),r.created_at||nowIso(),String(r.channel||'web').slice(0,20),String(r.route||'agent').slice(0,30),String(r.text||'').slice(0,3000),JSON.stringify(r.tools||[]),r.withheld?null:String(r.reply??'').slice(0,4000),String(r.reply??'').length,r.withheld?1:0,r.action_type||null,r.proposal_id||null,r.undo_id||null,r.note_id||null,r.latency_ms??null,r.model||null,r.input_tokens||0,r.output_tokens||0,r.cache_read_tokens||0,['turn','error','gap','undone'].includes(r.kind)?r.kind:'turn',r.error?String(r.error).slice(0,40):null,r.tainted?1:0,r.demoted||null,
    // no_tools: an agent reply that looked nothing up and asked nothing; a later real correction overwrites it.
    r.route==='agent'&&!(r.tools||[]).length&&!isQuestion(r.reply)&&!r.error?'no_tools':null);

// ---- Correction detection (pure) -------------------------------------------------------------------------------------
// "no, I meant…", "nope", "not that": a correction. "No class tomorrow?" is a question, so a bare "no" needs punctuation, the end
// of the message or a correction word after it.
const NEGATION=/^(?:(?:no|nope)(?:[,.!;:]|\s*$|\s+(?:i|that|not|it|wrong|wait)\b)|(?:not that|wrong|actually|i meant|undo)\b)/i;
// Checks on the action just taken ("did you add it?"), not any "did you…" question ("did you see the email from Dana").
const VERIFY=/^(?:did (?:you|it|that)(?: actually| really)? (?:add|save|send|put|move|log|mark|create|make|change|delete|cancel|do|get|go|work)\b|is (?:it|that) (?:on|in|added|saved|done|there)|was (?:it|that) (?:added|saved|done)|are you sure|(?:is|did) (?:it|that) (?:actually )?(?:work|go through|save))/i;
const NEGATIVE=/\b(?:nothing (?:on|new|open|logged|scheduled|else|found)|no (?:open|new|events|tasks|emails|results|messages|such|match)|none|couldn'?t|could not|can'?t|cannot|not (?:connected|found|syncing|on file)|don'?t (?:have|see)|didn'?t find|ran out of time|unavailable|had to stop|not sure)\b/i;
const STOP=new Set('a an the and or but to of in on at for with my me i is are was be do does did it this that what whats when where which who how can could would should please hey ok okay beacon you your have has had get got any some about from up me'.split(' '));
const SLOT=/^(?:today|tonight|tomorrow|tmrw?|tmr|yesterday|week|weekend|next|this|last|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d+(?:st|nd|rd|th)?|\d+\/\d+|personal|school|uchicago|gmail|work|class|classes)$/;
const words=t=>String(t).toLowerCase().replace(/[’']/g,"'").replace(/[^a-z0-9'/ ]+/g,' ').split(/\s+/).filter(Boolean);
const stem=w=>w.length>4?w.replace(/(?:ing|ed|es|s)$/,''):w;
export const tokens=t=>new Set(words(t).filter(w=>w.length>1&&!STOP.has(w)).map(stem));
export const jaccard=(a,b)=>{if(!a.size||!b.size)return 0;let n=0;for(const w of a)if(b.has(w))n++;return n/(a.size+b.size-n);};
// Capitalised words after the first are names ("Dana", "Club"); together with date, weekday and account words they are the slots.
const names=t=>new Set(String(t).split(/\s+/).slice(1).filter(w=>/^[A-Z][a-z]+$/.test(w)).map(w=>w.toLowerCase()));
const shape=(t,n)=>words(t).map(w=>SLOT.test(w)||n.has(w)?'_':w).join(' ');
const slots=(t,n)=>words(t).filter(w=>SLOT.test(w)||n.has(w)).join(' ');
// Same ask with one slot changed: "what's on tomorrow" → "what's on friday", "emails from Dana" → "emails from Alex".
export const slotSwap=(a,b)=>{const na=names(a),nb=names(b),n=new Set([...na,...nb]);return shape(a,n)===shape(b,n)&&slots(a,n)!==slots(b,n)&&slots(b,n).length>0;};
export const isQuestion=reply=>/\?\s*$/.test(String(reply||'').trim());
const negative=prev=>prev.kind==='error'||!prev.reply_len||NEGATIVE.test(prev.reply||'');
const SLASH_TOPICS={food:/\b(?:food|ate|eat|meal|calorie|protein)/i,target:/\b(?:calorie|protein|target)/i,tracker:/\b(?:tracker|application|applied|submitted)/i,contacts:/\bcontact/i,notes:/\bnote/i,feedback:/\bfeedback/i,jobs:/\b(?:job|mac|server|node)/i,node:/\b(?:mac|server|node)/i,news:/\b(?:news|headline)/i,status:/\b(?:status|connected|usage|paused)/i,log:/\b(?:log|history)/i,rules:/\b(?:rule|sender)/i,search:/\b(?:search|note|file)/i,career:/\bcareer/i};
// prev/prev2: the newest two rows before this turn. cur: {text,channel,route,action_type,created_at}. Returns
// {type,text} for prev or null. Order: explicit words first, then answers to questions, then behaviour.
export function detectCorrection(prev,prev2,cur,now=Date.now()){
  if(!prev)return null;
  const t=String(cur.text||'').trim(),dt=now-Date.parse(prev.created_at),short=t.split(/\s+/).length<=2;
  if(cur.route==='undo')return null;  // the undo path marks the original row itself (undone / undo_fast)
  if(cur.action_type==='feedback')return {type:'feedback',text:t};
  const asked=isQuestion(prev.reply)&&!prev.action_type;
  if(NEGATION.test(t)&&!(asked&&short))return {type:'negation',text:t};
  if(asked){
    if(dt>TEN_MIN)return {type:'clarification_unanswered',text:t};
    const chain=prev2&&isQuestion(prev2.reply)&&!prev2.action_type&&Date.parse(prev.created_at)-Date.parse(prev2.created_at)<=TEN_MIN;
    return {type:chain?'clarify_chain':'clarify',text:t};
  }
  if(prev.action_type&&VERIFY.test(t))return {type:'verification_ask',text:t};
  if(cur.route==='slash'){const cmd=/^\/(\w+)/.exec(t)?.[1]?.toLowerCase();return prev.route!=='slash'&&dt<=TEN_MIN&&cmd&&SLASH_TOPICS[cmd]?.test(prev.text)?{type:'fell_back_to_slash',text:t}:null;}
  if(prev.route==='slash'||prev.route==='undo')return null;
  const a=tokens(prev.text),b=tokens(t),j=jaccard(a,b);
  if(cur.channel!==prev.channel&&dt<=FIFTEEN_MIN&&j>=0.5)return {type:'cross_channel_retry',text:t};
  if(dt<=TEN_MIN&&slotSwap(prev.text,t))return negative(prev)?{type:'slot_swap',text:t}:null;
  // A rephrase is the same ask again after an empty or negative reply. After a good answer, overlapping words are a follow-up
  // ("…tomorrow" → "…tomorrow afternoon", a strict superset) or a new question, never a correction.
  if(dt<=TEN_MIN&&negative(prev)&&(j>=0.5||(prev.route.startsWith('fast:')&&prev.route===cur.route)))return {type:'rephrase',text:t};
  return null;
}

// ---- Writes ---------------------------------------------------------------------------------------------------------
export const lastInteractions=(env,n=2)=>all(env,'SELECT id,created_at,channel,route,text,reply,reply_len,action_type,kind,correction_type FROM interactions ORDER BY created_at DESC LIMIT ?',n);
const correctionStmt=(env,prevId,byId,c)=>env.DB.prepare('UPDATE interactions SET corrected_by=?,correction_type=?,correction=? WHERE id=?').bind(byId,c.type,String(c.text).slice(0,1000),prevId);
// The insert for this turn, its own trouble signals, and when the message corrects the previous turn, the update of that row
// plus the signal it earns. Callers batch them.
export async function turnStmts(env,r){
  r.id=r.id||crypto.randomUUID();
  const [prev,prev2]=await lastInteractions(env,2).catch(()=>[]),c=detectCorrection(prev,prev2,r),cs=c&&correctionSignal(c.type);
  return [interactionStmt(env,r),...turnSignals(r).map(s=>signalStmt(env,r.id,s)),...(c?[correctionStmt(env,prev.id,r.id,c)]:[]),...(cs?[signalStmt(env,prev.id,cs)]:[])];
}
export async function logTurn(env,r){const s=await turnStmts(env,r);await env.DB.batch(s);return r.id;}
export const logInteraction=logTurn;
// Button taps and voice events update the row they belong to: undo (undo_fast within 2 minutes), cancelled card, voice interrupt, "what?".
export async function markOutcome(env,where,type,by,now=Date.now()){
  const [col,val]=Object.entries(where)[0];if(!val)return false;
  const row=await env.DB.prepare(`SELECT id,created_at FROM interactions WHERE ${col==='undo_id'?'undo_id':'proposal_id'}=? ORDER BY created_at DESC LIMIT 1`).bind(val).first();if(!row)return false;
  const t=type==='undone'&&now-Date.parse(row.created_at)<=UNDO_FAST_MS?'undo_fast':type;
  await run(env,'UPDATE interactions SET corrected_by=?,correction_type=?,correction=? WHERE id=?',String(by||'').slice(0,40),t,t,row.id);
  const s=correctionSignal(t);if(s)await signalStmt(env,row.id,s).run();return true;
}
export async function markVoice(env,type,text='',now=Date.now()){
  const row=await env.DB.prepare("SELECT id FROM interactions WHERE channel='voice' AND created_at>? ORDER BY created_at DESC LIMIT 1").bind(new Date(now-TEN_MIN).toISOString()).first();if(!row)return false;
  await run(env,'UPDATE interactions SET corrected_by=?,correction_type=?,correction=? WHERE id=?','voice',type,String(text).slice(0,200),row.id);
  const s=correctionSignal(type);if(s)await signalStmt(env,row.id,s,type==='interrupted'?text:null).run();return true;
}
// One-tap labels from the web Log page: "this was wrong" / "this was fine".
export async function labelInteraction(env,id,label){
  if(!['wrong','fine'].includes(label))throw new Error('Label must be wrong or fine');
  const r=await run(env,"UPDATE interactions SET correction_type='label',correction=?,corrected_by='web' WHERE id=?",label,String(id).slice(0,64));return {labelled:r.meta.changes};
}
// tick(): the log, its signals and chat history purge after 90 days (DATA.md Notes).
export async function purgeInteractions(env,at=new Date()){
  const cut=new Date(at.getTime()-KEEP_DAYS*86400000).toISOString();
  await run(env,'DELETE FROM interaction_signals WHERE interaction_id IN (SELECT id FROM interactions WHERE created_at<?)',cut);
  await Promise.all([run(env,'DELETE FROM interactions WHERE created_at<?',cut),run(env,'DELETE FROM messages WHERE created_at<?',cut),run(env,'DELETE FROM calls WHERE started_at<?',cut),run(env,'DELETE FROM review_synthesis WHERE created_at<?',cut)]);
}

// ---- Reads ------------------------------------------------------------------------------------------------------------
const chunks=ids=>{const out=[];for(let i=0;i<ids.length;i+=CHUNK)out.push(ids.slice(i,i+CHUNK));return out;};
async function byIds(env,sql,ids){const out=[];for(const c of chunks([...new Set(ids.filter(Boolean))]))out.push(...await all(env,sql.replace('?*',c.map(()=>'?').join(',')),...c));return out;}
// Outcome per row, derived by joining audit (proposal:*), proposals (expiry) and action_undo (undone_at); never written back.
export async function outcomes(env,rows,now=Date.now()){
  const pids=rows.map(r=>r.proposal_id),uids=rows.map(r=>r.undo_id);
  const audit=pids.some(Boolean)?await byIds(env,"SELECT target_id,action FROM audit WHERE target_id IN (?*) AND action LIKE 'proposal:%' ORDER BY created_at",pids):[];
  const props=pids.some(Boolean)?await byIds(env,'SELECT id,expires_at FROM proposals WHERE id IN (?*)',pids):[];
  const undos=uids.some(Boolean)?await byIds(env,'SELECT id,undone_at FROM action_undo WHERE id IN (?*)',uids):[];
  const status=new Map();for(const a of audit){const s=a.action.split(':')[1];if(['executed','failed','cancelled','rejected','voided','approved'].includes(s))status.set(a.target_id,s);}
  const expiry=new Map(props.map(p=>[p.id,p.expires_at])),undone=new Map(undos.map(u=>[u.id,!!u.undone_at]));
  return Object.fromEntries(rows.map(r=>[r.id,
    r.kind==='error'?'error':r.kind==='gap'?'gap':r.kind==='undone'?'undone':r.note_id?'noted':
    r.undo_id?(undone.get(r.undo_id)?'undone':'done'):
    r.proposal_id?(status.get(r.proposal_id)||(Date.parse(expiry.get(r.proposal_id)||0)<now?'expired':'pending')):
    /^draft/.test(r.action_type||'')?'drafted':r.action_type==='send_file'?'sent':/^meal/.test(r.action_type||'')?'logged':isQuestion(r.reply)?'asked':'answered']));
}
export async function signalsFor(env,rows){
  const out={};for(const r of rows)out[r.id]={friction:0,signals:[]};
  for(const s of await byIds(env,'SELECT interaction_id,signal,weight,evidence FROM interaction_signals WHERE interaction_id IN (?*)',rows.map(r=>r.id))){out[s.interaction_id].friction+=s.weight;out[s.interaction_id].signals.push({signal:s.signal,weight:s.weight,evidence:s.evidence});}
  return out;
}
const parseTools=t=>{try{return JSON.parse(t||'[]');}catch{return [];}};
// Newest rows (≤100) with outcome and signals, filtered in SQL by kind, route, channel, since and his own words.
export async function listInteractions(env,f={},now=Date.now()){
  const w=[],p=[];
  if(f.kind)w.push('kind=?'),p.push(String(f.kind).slice(0,10));
  if(f.route)w.push('route=?'),p.push(String(f.route).slice(0,30));
  if(f.channel)w.push('channel=?'),p.push(String(f.channel).slice(0,20));
  if(f.since&&Number.isFinite(Date.parse(f.since)))w.push('created_at>=?'),p.push(new Date(f.since).toISOString());
  if(f.q)w.push('lower(text) LIKE ?'),p.push(`%${String(f.q).toLowerCase().replace(/[%_]/g,'').slice(0,80)}%`);
  if(f.trouble)w.push("(kind='error' OR correction_type IS NOT NULL OR id IN (SELECT interaction_id FROM interaction_signals))");
  const limit=Math.min(100,Math.max(1,Number(f.limit)||100));
  const rows=await all(env,`SELECT * FROM interactions${w.length?' WHERE '+w.join(' AND '):''} ORDER BY created_at DESC LIMIT ?`,...p,limit);
  const o=await outcomes(env,rows,now),s=await signalsFor(env,rows);
  return rows.map(r=>({...r,tools:parseTools(r.tools),reply:r.reply_withheld?'[reply withheld: email summary]':r.reply,outcome:o[r.id],...s[r.id]}));
}

// /log: last 20 rows as `time · route · first 80 chars · tools · outcome · ms`, with friction; /log trouble: this week's top 10.
const clock=iso=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago',weekday:'short',hour:'numeric',minute:'2-digit'});
const line=r=>`${clock(r.created_at)} · ${r.route} · ${r.text.replace(/\s+/g,' ').slice(0,80)} · ${r.tools.length?r.tools.map(t=>t.name+(t.ok?'':'✗')).join(','):'—'} · ${r.outcome}${r.error?` (${r.error})`:''} · ${r.latency_ms!=null?`${(r.latency_ms/1000).toFixed(1)}s`:'—'}${r.friction?` · friction ${r.friction}`:''}${r.correction_type?` · ${r.correction_type}`:''}`;
export async function logText(env,trouble=false,now=Date.now()){
  if(!trouble){const rows=await listInteractions(env,{limit:20},now);return rows.length?`📋 Last ${rows.length} turns\n${rows.map(line).join('\n')}`:'No turns logged yet.';}
  const rows=(await listInteractions(env,{trouble:true,since:new Date(now-7*86400000).toISOString(),limit:100},now)).sort((a,b)=>b.friction-a.friction||(b.kind==='error')-(a.kind==='error')||b.created_at.localeCompare(a.created_at)).slice(0,10);
  return rows.length?`⚠️ Trouble this week (top ${rows.length})\n${rows.map(line).join('\n')}`:'No trouble logged this week.';
}

// ---- Calls (migration 0032): one row per voice call, so a call reads as a session and not just loose turns ----------------
const ENDS=['hangup','limit','turn_cap','pin_lockout'];
export const startCall=(env,id,at=nowIso())=>run(env,'INSERT OR IGNORE INTO calls(id,started_at) VALUES(?,?)',id,at);
export const endCall=(env,id,c)=>run(env,'UPDATE calls SET ended_at=?,duration_ms=?,turns=?,verified=?,pin_failures=?,ended_by=? WHERE id=?',nowIso(),Math.max(0,Math.round(c.duration_ms||0)),c.turns|0,c.verified?1:0,c.pin_failures|0,ENDS.includes(c.ended_by)?c.ended_by:'hangup',id);
