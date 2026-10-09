#!/usr/bin/env node
// Agent eval replay (M7 batch 6, design "Evaluation and tests"): runs the asks.json eval set through the real planner
// (ANTHROPIC_API_KEY or ~/.config/jarvis/anthropic_key) on an in-memory SQLite copy of the schema with seeded rows and
// mocked network tools (email, GroupMe, weather), so nothing touches Google, Telegram or the live D1. Each ask is judged by
// route, required tools, the action it ended in and must_not; the markdown report (asks, tool names, action types, reply
// snippets) stays in research/agent-eval/ (git-ignored), and only counts, failing ids and code-built failure notes go to
// the gateway (POST /api/eval/result, admin key) as eval_runs and capability_requests for the Sunday review.
//   node scripts/agent-eval.mjs            → fixed 40-phrase sample, report, post
//   node scripts/agent-eval.mjs --all      → every eval phrase;  --only a006,a088  → those asks
//   --dry-run (list the sample, no model, no post)   --no-post (report only)
import {readFileSync,readdirSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const GW=resolve(dirname(fileURLToPath(import.meta.url)),'..'),ROOT=resolve(GW,'..'),BASE=process.env.JARVIS_URL||'https://your-worker.example.workers.dev';
export const REPORT_DIR=join(ROOT,'research','agent-eval');
const SAMPLE_N=40,DEADLINE_MS=90000,DAY=86400000;

// ---- judging (pure, shared with the vitest routing table) ----------------------------------------------------------
// o: {route,tools:[names],action|null,effects:[proposal|task_change|draft|contact|calendar_write|model_call…],kind,error}.
// expect.tools entries are a name or a list of alternatives; expect.action a type, a list of types or null (read phrasing).
export function judge(ask,o){
  const why=[];
  if(o.route!==ask.route)why.push(`route ${o.route} (expected ${ask.route})`);
  if(o.kind==='error')why.push(`error ${o.error||'unknown'}`);
  for(const t of ask.expect.tools){const alts=[].concat(t);if(!alts.some(n=>o.tools.includes(n)))why.push(`no ${alts.join('|')} call`);}
  const exp=ask.expect.action,got=o.action||null;
  if(exp==null?got!=null:![].concat(exp).includes(got))why.push(`action ${got||'none'} (expected ${[].concat(exp??'none').join('|')})`);
  for(const m of ask.expect.must_not){if(o.tools.includes(m))why.push(`called ${m}`);if((o.effects||[]).includes(m))why.push(m);}
  return {pass:!why.length,why:why.join('; ')};
}
// A fixed, evenly spread subset (same input → same sample), so weekly runs are comparable.
export function sample(items,n){if(items.length<=n)return items;const out=[];let last=-1;for(let i=0;i<items.length;i++){const b=Math.floor(i*n/items.length);if(b!==last){out.push(items[i]);last=b;}}return out;}

// ---- one isolated environment per ask ---------------------------------------------------------------------------------
async function freshEnv(){
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(':memory:');
  for(const f of readdirSync(join(GW,'migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(join(GW,'migrations',f),'utf8'));
  const prepare=sql=>({args:[],bind(...a){this.args=a;return this;},async all(){return {results:db.prepare(sql).all(...this.args)};},async first(){return db.prepare(sql).get(...this.args)||null;},async run(){return {meta:db.prepare(sql).run(...this.args)};}});
  const env={DB:{prepare,batch:async l=>{db.exec('BEGIN');try{const r=await Promise.all(l.map(q=>q.run()));db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}},GATEWAY_KEY:'eval',ADMIN_KEY:'eval',TOKEN_ENC_KEY:'eval',AGENT_MODE:'true',ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY};
  await seed(env);return {env,db};
}
const chicago=(dayOffset,hh,mm=0)=>{const d=new Date(Date.now()+dayOffset*DAY),p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));
  const guess=Date.parse(`${p.year}-${p.month}-${p.day}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00Z`),off=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',timeZoneName:'shortOffset'}).format(new Date(guess)).split('GMT')[1]||'0';return new Date(guess-(+off)*3600000).toISOString();};
// Fictional rows only: names and example addresses, no real mail or calendar data.
async function seed(env){
  const {capture}=await import('../src/service.js'),{logMeal}=await import('../src/meals.js');
  const q=(sql,...a)=>env.DB.prepare(sql).bind(...a).run();
  await q("INSERT INTO contacts(id,name,email,phone,notes,created_at,origin) VALUES('c00000000f1','Dana Lee','dana@example.edu',NULL,'','x','web'),('c00000000f2','Mom',NULL,'+13125550123','','x','web'),('c00000000f3','Professor Smith','smith@example.edu',NULL,'','x','web')");
  for(const [id,title,category,due] of [['t1','ECON 21010 pset 3','school',3],['t2','Persian essay','persian',2],['t3','CIBC application','career',6],['t4','Russian history reading','school',-1],['t5','Buy printer paper','personal',null]])await capture(env,{id,title,category,due_at:due==null?null:chicago(due,17)});
  const ev=[['e1','PERS 10101',1,9,30,10,50,'class'],['e2','ECON 21010',1,13,0,14,20,'class'],['b1','Class work — Persian practice',1,15,0,16,0,'class'],['e3','Dinner with mom',2,18,0,20,0,'personal'],['b2','Career — Coffee chat',0,20,0,20,30,'work']];
  for(const [id,title,d,h1,m1,h2,m2,cat] of ev){await q('INSERT INTO events(id,title,start_at,end_at,all_day,owned,category,updated_at) VALUES(?,?,?,?,0,1,?,?)',id,title,chicago(d,h1,m1),chicago(d,h2,m2),cat,'x');
    if(id.startsWith('b'))await q('INSERT INTO blocks(id,title,start_at,end_at,category,updated_at) VALUES(?,?,?,?,?,?)',id,title,chicago(d,h1,m1),chicago(d,h2,m2),cat==='work'?'career':'persian','x');}
  await q("INSERT INTO sources(id,status,detail,updated_at) VALUES('calendar','ok','',?),('gmail','ok','',?),('uchicago','ok','',?)",new Date().toISOString(),new Date().toISOString(),new Date().toISOString());
  await q("INSERT INTO mail_items(id,received_at,sender,subject,level,reason,verified,account) VALUES('g1',?,'\"Dana Lee\" <dana@example.edu>','DC trek application','notify','reply',1,'personal'),('g2',?,'Registrar <registrar@example.edu>','Add/drop ends Friday','digest','dates',1,'school')",new Date(Date.now()-3600000).toISOString(),new Date(Date.now()-7200000).toISOString());
  await q("INSERT INTO kb(path,title,body) VALUES('notes/people/dana.md','Dana Lee','UChicago senior, organizes the DC trek; met at the career fair; coffee chat went well'),('plan/career.md','Deadlines','DC trek applications open December to January; Truman deadline early January; CIBC summer analyst due next week')");
  await logMeal(env,{description:'two eggs and toast',eaten_at:new Date(Date.now()-3*3600000).toISOString(),items:[{name:'2 eggs',calories:180,protein_g:12,carbs_g:2,fat_g:14},{name:'toast',calories:160,protein_g:5,carbs_g:30,fat_g:2}]},'eval');
  await q("UPDATE settings SET value=json_set(value,'$.agentTurnsPerDay',1000) WHERE id='preferences'");
}
// Network tools answer from canned data; the planner sees exactly what the real tools would shape (names, domains, subjects).
const MAIL=[{id:'m1',from_name:'Dana Lee',from_domain:'example.edu',verified:true,subject:'DC trek application',snippet:'The trek application is open until the 20th; let me know if you are in.',level:'notify',sender_candidate:true,address:'dana@example.edu'},
  {id:'m2',from_name:'Prof Smith',from_domain:'example.edu',verified:true,subject:'Problem set 3 posted',snippet:'Pset 3 is on Canvas and due Friday; office hours Thursday.',level:'digest',sender_candidate:true,address:'smith@example.edu'},
  {id:'m3',from_name:'Goldman Sachs Recruiting',from_domain:'example.com',verified:true,subject:'Summer analyst application received',snippet:'Thank you for applying; next steps within two weeks.',level:'notify',sender_candidate:false,address:'recruiting@example.com'}];
function mockTools(TOOLS){
  TOOLS.email_search.run=async(env,a,turn)=>{const words=String(a.query||'').toLowerCase().match(/[a-z0-9]{3,}/g)||[];const rows=MAIL.filter(m=>!words.length||words.some(w=>`${m.from_name} ${m.subject} ${m.snippet}`.toLowerCase().includes(w)));
    for(const m of rows)turn.aliases[m.id]={message_id:'g'+m.id.slice(1),account:'personal',from_address:m.address,from_name:m.from_name,verified:m.verified,thread_id:'th'+m.id.slice(1),candidate:m.sender_candidate,level:m.level};
    return rows.map(({address,...m})=>({...m,date:new Date(Date.now()-3600000).toISOString()}));};
  TOOLS.email_read.run=async(env,a)=>{const m=MAIL.find(x=>x.id===a.id);return m?`${m.from_name} writes about ${m.subject.toLowerCase()}: ${m.snippet}`:{error:'that id is not from this conversation; search first'};};
  TOOLS.groupme_recent.run=async()=>[{at:new Date(Date.now()-DAY).toISOString(),text:'Chapter meeting Thursday at 7 at the house'},{at:new Date(Date.now()-2*DAY).toISOString(),text:'Formal is November 14; tickets due Friday'}];
  TOOLS.weather.run=async()=>'Today in campus: 58°F, cloudy, 20% chance of rain this afternoon.';
}
const counts=async(env,t)=>(await env.DB.prepare(`SELECT count(*) n FROM ${t}`).first()).n;
async function effectsOf(env,before,calls,modelCalls){
  const a={};for(const t of Object.keys(before))a[t]=await counts(env,t);const e=[];
  if(a.proposals>before.proposals)e.push('proposal');if(a.tasks!==before.tasks||a.action_undo!==before.action_undo)e.push('task_change');if(a.drafts>before.drafts)e.push('draft');if(a.contacts!==before.contacts)e.push('contact');
  if(calls.some(u=>u.includes('googleapis.com/calendar')))e.push('calendar_write');if(modelCalls)e.push('model_call');return {effects:e,capability:a.capability_requests>before.capability_requests};
}
async function runOne(item,hasKey){
  const {env,db}=await freshEnv(),{TOOLS}=await import('../src/agent.js'),{converse}=await import('../src/conversation.js'),{PLANNER,costOf}=await import('../src/budget.js');
  mockTools(TOOLS);
  const calls=[];let modelCalls=0;const real=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{const u=String(url);if(u.includes('api.anthropic.com')){modelCalls++;return real(url,init);}calls.push(u);return Response.json({ok:true});};
  const tables=['proposals','tasks','action_undo','drafts','contacts','capability_requests'],before={};for(const t of tables)before[t]=await counts(env,t);
  const t0=Date.now();let reply='',crashed=null;
  if(item.ask.route==='agent'&&!hasKey){globalThis.fetch=real;db.close();return {...item,skipped:true,pass:false,why:'skipped: no ANTHROPIC_API_KEY',o:{route:'skipped',tools:[],action:null,effects:[]},ms:0,tokens:0,cost:0,reply:''};}
  try{reply=(await converse(env,item.phrase,'web',{deadline:Date.now()+DEADLINE_MS})).reply;}
  catch(e){crashed=String(e?.message||e).slice(0,120);}
  finally{globalThis.fetch=real;}
  const row=await env.DB.prepare('SELECT route,kind,error,action_type,tools,latency_ms,input_tokens,output_tokens,cache_read_tokens FROM interactions ORDER BY created_at DESC LIMIT 1').first();
  const {effects,capability}=await effectsOf(env,before,calls,modelCalls);db.close();
  const tools=row?JSON.parse(row.tools).map(t=>t.name):[];
  const o={route:crashed?'crash':row?.route||'none',tools,action:capability?'request_capability':row?.action_type||null,effects,kind:crashed?'error':row?.kind||'error',error:crashed||row?.error||(row?null:'no_row')};
  const cost=row?costOf(PLANNER,row.input_tokens,row.output_tokens,row.cache_read_tokens):0;
  return {...item,o,...judge(item.ask,o),ms:Date.now()-t0,tokens:row?row.input_tokens+row.output_tokens:0,cost,reply:reply.replace(/\s+/g,' ').slice(0,200)};
}

// ---- multi-turn conversations (tests/fixtures/conversations.json) ------------------------------------------------------
// Each scenario runs in one fresh environment, turn by turn, against the real planner. "after_min" simulates time passing by
// moving every stored timestamp back (messages, interactions, proposals, photos, the working set), so gaps behave as live.
async function shift(env,min){
  const m=`'-${Number(min)} minutes'`,f=c=>`${c}=strftime('%Y-%m-%dT%H:%M:%fZ',${c},${m})`;
  for(const sql of [`UPDATE messages SET ${f('created_at')}`,`UPDATE interactions SET ${f('created_at')}`,`UPDATE proposals SET ${f('created_at')},${f('expires_at')}`,`UPDATE photo_inbox SET ${f('created_at')},${f('updated_at')}`,`UPDATE audit SET ${f('created_at')}`,
    `UPDATE settings SET value=json_set(value,'$.expires_at',strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(value,'$.expires_at'),${m})) WHERE id='agent_working_set' AND json_extract(value,'$.expires_at') IS NOT NULL`])await env.DB.prepare(sql).run();
}
async function setup(env,name){
  if(name!=='photo_career')return;
  const ago=n=>new Date(Date.now()-n*60000).toISOString(),q=(sql,...a)=>env.DB.prepare(sql).bind(...a).run(),path='Career_Plan/photos/2026-10-06_csis-info-session.jpg';
  await q("INSERT INTO node_jobs(id,kind,query,status,origin,created_at) VALUES('j1','save_photo',?,'done','telegram',?)",path,ago(1));
  await q("INSERT INTO photo_inbox(id,file_id,mime,size,caption,status,bucket,title,path,job_id,created_at,updated_at) VALUES('ph0000000001','f','image/jpeg',1000,NULL,'filed','career','csis info session',?,'j1',?,?)",path,ago(1),ago(1));
  await q("INSERT INTO messages(id,role,content,created_at) VALUES('pm1','user','[photo]',?),('pm2','assistant',?,?)",ago(1),`📷 Flyer for a CSIS info session Thursday 6pm. Filing to Career_Plan/photos/ as ${path.split('/').pop()}.`,ago(1));
}
export function judgeTurn(e,o){
  const why=[];
  if(e.route&&o.route!==e.route)why.push(`route ${o.route} (expected ${e.route})`);
  if(!e.route&&o.route!=='agent'&&o.route!=='fell_back'&&!String(o.route).startsWith('fast:'))why.push(`route ${o.route}`);
  if(o.kind==='error')why.push(`error ${o.error}`);
  for(const t of e.tools||[])if(!o.tools.includes(t))why.push(`no ${t} call`);
  if('action' in e){const want=[].concat(e.action),got=o.action??null;if(!want.includes(got))why.push(`action ${got||'none'} (expected ${want.map(w=>w??'none').join('|')})`);}
  if(e.replaces&&!o.replaced)why.push('old card not replaced');
  for(const m of e.must_not||[]){if(m==='replaces'?o.replaced:(o.tools.includes(m)||o.action===m))why.push(`did ${m}`);}
  if(e.photo_bucket&&o.photo_bucket!==e.photo_bucket)why.push(`photo in ${o.photo_bucket} (expected ${e.photo_bucket})`);
  if(e.history!=null&&o.history!==e.history)why.push(`saw ${o.history} earlier messages (expected ${e.history})`);
  return {pass:!why.length,why:why.join('; ')};
}
async function runConversation(sc){
  const {env,db}=await freshEnv(),{TOOLS}=await import('../src/agent.js'),{converse}=await import('../src/conversation.js'),{PLANNER,costOf}=await import('../src/budget.js');
  mockTools(TOOLS);await setup(env,sc.setup);
  const real=globalThis.fetch;let first=null;
  globalThis.fetch=async(url,init)=>{const u=String(url);if(u.includes('api.anthropic.com')){if(!first&&init?.body)first=JSON.parse(init.body);return real(url,init);}return Response.json({ok:true});};
  const out=[];
  try{
    for(const t of sc.turns){
      if(t.after_min)await shift(env,t.after_min);
      first=null;const sup0=(await env.DB.prepare("SELECT count(*) n FROM audit WHERE action='proposal:superseded'").first()).n,t0=Date.now();
      let reply='',crashed=null;try{reply=(await converse(env,t.say,'web',{deadline:Date.now()+DEADLINE_MS})).reply;}catch(e){crashed=String(e?.message||e).slice(0,120);}
      const row=await env.DB.prepare('SELECT route,kind,error,action_type,tools,input_tokens,output_tokens,cache_read_tokens FROM interactions ORDER BY created_at DESC LIMIT 1').first();
      const sup1=(await env.DB.prepare("SELECT count(*) n FROM audit WHERE action='proposal:superseded'").first()).n,photo=await env.DB.prepare('SELECT bucket FROM photo_inbox LIMIT 1').first();
      const tools=row?JSON.parse(row.tools||'[]').map(x=>x.name):[];
      const o={route:crashed?'crash':row?.route||'none',kind:crashed?'error':row?.kind,error:crashed||row?.error,tools,action:tools.includes('clarify')&&!row?.action_type?'clarify':row?.action_type||null,replaced:sup1>sup0,photo_bucket:photo?.bucket,history:first?first.messages.length-1:0};
      const cost=row?costOf(PLANNER,row.input_tokens||0,row.output_tokens||0,row.cache_read_tokens||0):0;
      out.push({say:t.say,after:t.after_min||0,o,...judgeTurn(t.expect||{},o),ms:Date.now()-t0,cost,reply:reply.replace(/\s+/g,' ').slice(0,160)});
    }
  }finally{globalThis.fetch=real;db.close();}
  return {id:sc.id,name:sc.name,turns:out,pass:out.every(x=>x.pass)};
}

// ---- main -------------------------------------------------------------------------------------------------------------
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const args=process.argv.slice(2),flag=f=>args.includes(f),only=(args.find(a=>a.startsWith('--only='))||'').slice(7).split(',').filter(Boolean);
  if(flag('--conversations')){
    const keyFile=homedir()+'/.config/jarvis/anthropic_key';if(!process.env.ANTHROPIC_API_KEY&&existsSync(keyFile))process.env.ANTHROPIC_API_KEY=readFileSync(keyFile,'utf8').trim();
    if(!process.env.ANTHROPIC_API_KEY){console.log('No ANTHROPIC_API_KEY; conversations need the real model.');process.exit(1);}
    const scs=JSON.parse(readFileSync(join(GW,'tests/fixtures/conversations.json'),'utf8')).filter(c=>!only.length||only.includes(c.id));
    const res=[];for(const sc of scs){const r=await runConversation(sc);res.push(r);console.log(`${r.pass?'ok  ':'FAIL'} ${r.id} ${r.name}`);for(const t of r.turns)console.log(`     ${t.pass?'✓':'✗'} ${t.after?`(+${t.after}m) `:''}${JSON.stringify(t.say)} → ${t.o.route} ${t.o.tools.join(',')||'-'} → ${t.o.action||'none'}${t.o.replaced?' (replaced card)':''} · saw ${t.o.history} msgs · ${t.ms}ms${t.pass?'':`  ← ${t.why}`}\n       “${t.reply}”`);}
    const turns=res.flatMap(r=>r.turns),cost=turns.reduce((a,t)=>a+t.cost,0);
    console.log(`\n${res.filter(r=>r.pass).length}/${res.length} conversations, ${turns.filter(t=>t.pass).length}/${turns.length} turns passed; ~$${cost.toFixed(2)}; median ${[...turns.map(t=>t.ms)].sort((a,b)=>a-b)[Math.floor(turns.length/2)]}ms per turn.`);
    process.exit(0);
  }
  const asks=JSON.parse(readFileSync(join(GW,'tests/fixtures/asks.json'),'utf8')).flatMap(d=>d.asks).filter(a=>a.route&&(!only.length||only.includes(a.id)));
  const items=asks.flatMap(a=>a.eval_phrases.map(i=>({ask:a,phrase:a.phrases[i]}))),set=flag('--all')||only.length?items:sample(items,SAMPLE_N);
  const keyFile=homedir()+'/.config/jarvis/anthropic_key';
  if(!process.env.ANTHROPIC_API_KEY&&existsSync(keyFile))process.env.ANTHROPIC_API_KEY=readFileSync(keyFile,'utf8').trim();
  const hasKey=!!process.env.ANTHROPIC_API_KEY;
  if(flag('--dry-run')){for(const x of set)console.log(`${x.ask.id} ${x.ask.route} ${JSON.stringify(x.phrase)}`);console.log(`${set.length} phrases; model ${hasKey?'available':'NOT configured (agent asks would be skipped)'}`);process.exit(0);}
  const all=[];
  for(const x of set){const r=await runOne(x,hasKey);all.push(r);process.stdout.write(`${r.skipped?'skip':r.pass?'ok  ':'FAIL'} ${r.ask.id} ${r.o.route.padEnd(16)} ${String(r.ms).padStart(6)}ms ${r.phrase.slice(0,60)}${r.pass||r.skipped?'':`  ← ${r.why}`}\n`);}
  // Skipped asks (no key) are neither passes nor failures: they stay out of the counts and never become capability requests.
  const results=all.filter(r=>!r.skipped),skipped=all.length-results.length;
  const passed=results.filter(r=>r.pass).length,cost=results.reduce((s,r)=>s+r.cost,0),date=new Date().toISOString().slice(0,10);
  const med=xs=>{const v=[...xs].sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:0;};
  const by=new Map();for(const r of results){const k=r.ask.route;if(!by.has(k))by.set(k,[0,0]);by.get(k)[0]+=r.pass?1:0;by.get(k)[1]++;}
  const cell=v=>String(v??'').replace(/\|/g,'/').replace(/\s+/g,' ');
  const md=[`# Agent eval — ${date}`,'',`${passed}/${results.length} passed${skipped?` (${skipped} agent asks skipped: no API key)`:''}; est. cost $${cost.toFixed(2)}; median agent latency ${med(results.filter(r=>r.ask.route==='agent').map(r=>r.ms))} ms.`,'',
    `By route: ${[...by].map(([k,[p,n]])=>`${k} ${p}/${n}`).join(', ')}.`,'','| ask | phrase | route exp → got | tools called | action exp → got | ms | result |','|---|---|---|---|---|---|---|',
    ...results.map(r=>`| ${r.ask.id} | ${cell(r.phrase)} | ${r.ask.route} → ${r.o.route} | ${cell(r.o.tools.join(', ')||'—')} | ${cell([].concat(r.ask.expect.action??'none').join('/'))} → ${r.o.action||'none'} | ${r.ms} | ${r.pass?'pass':`FAIL: ${cell(r.why)}`} |`),'',
    '## Replies (local only; never committed or posted)','',...results.map(r=>`- ${r.ask.id}: ${cell(r.reply)||'(no reply)'}`),''].join('\n');
  mkdirSync(REPORT_DIR,{recursive:true});const file=join(REPORT_DIR,`${date}.md`);writeFileSync(file,md,{mode:0o600});console.log(`\n${passed}/${results.length} passed${skipped?`, ${skipped} skipped`:''}, ~$${cost.toFixed(2)}. Report: ${file}`);
  if(flag('--no-post')||!results.length)process.exit(0);
  // Only counts, ids and code-built notes leave the Mac (what: expected vs observed names; why: route and tools; text: the ask phrase).
  const failures=results.filter(r=>!r.pass).map(r=>({id:r.ask.id,text:r.phrase,what:r.why.slice(0,300),why:`route ${r.o.route}, tools ${r.o.tools.join(',')||'none'}`}));
  const adminFile=homedir()+'/.config/jarvis/admin_key';if(!existsSync(adminFile)){console.log('No admin key; not posted.');process.exit(0);}
  const r=await fetch(BASE+'/api/eval/result',{method:'POST',headers:{'X-Jarvis-Admin-Key':readFileSync(adminFile,'utf8').trim(),'content-type':'application/json'},body:JSON.stringify({asks:results.length,passed,failures})});
  const out=await r.json().catch(()=>({}));if(!r.ok)throw new Error(out.error||`post failed (${r.status})`);console.log(`Posted: run ${out.id}, ${out.logged} new capability request${out.logged===1?'':'s'}.`);
}
