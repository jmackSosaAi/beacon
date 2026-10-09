import {buildPushPayload} from '@block65/webcrypto-web-push';
import {localParts,isQuiet,scheduleNotices,cleanText,validInstant,blockCategory,eventCategory,safeUrl,STATES} from './core.js';
import {hash} from './auth.js';
import {sendTelegram} from './tgapi.js';
import {criteriaProposals} from './mail.js';
import {usageToday} from './budget.js';

export const all=async(env,sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
export const run=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).run();
export const nowIso=()=>new Date().toISOString();
// One chat-history row tagged with the channel it came through (web|telegram|voice) so typed and called turns stay distinguishable.
export const messageStmt=(env,role,content,channel=null)=>env.DB.prepare('INSERT INTO messages(id,role,content,created_at,channel) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),role,content,nowIso(),channel);
// Kill switch: every executor checks this. Pausing works from any channel; resuming only from the web app.
export async function isPaused(env){return (await env.DB.prepare("SELECT value FROM settings WHERE id='paused'").first())?.value==='true';}
export async function setPaused(env,paused,via){
  await run(env,"INSERT INTO settings(id,value) VALUES('paused',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",paused?'true':'false');
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`${paused?'pause':'resume'}:${String(via).slice(0,20)}`,null,nowIso());
}
export async function preferences(env) {return JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first()).value);}
export async function source(env,id,status,detail,coverageEnd=null){
  const now=nowIso();
  await run(env,'INSERT INTO sources(id,status,last_success,detail,coverage_end,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_success=CASE WHEN excluded.status IN (\'ok\',\'snapshot\') THEN excluded.last_success ELSE sources.last_success END,detail=excluded.detail,coverage_end=excluded.coverage_end,updated_at=excluded.updated_at',id,status,['ok','snapshot'].includes(status)?now:null,detail,coverageEnd,now);
}
export async function health(env) {
  const rows=await all(env,'SELECT * FROM sources');
  const expected=['calendar','gmail','uchicago','groupme','canvas','discord','scheduler','twilio'];
  return expected.map(id=>{
    const row=rows.find(r=>r.id===id)||{id,status:'not_connected',last_success:null,detail:'Not connected'};
    const maxAge=id==='scheduler'?15*60000:30*3600000;
    const stale=row.status==='ok' && (!row.last_success || Date.now()-Date.parse(row.last_success)>maxAge || (row.coverage_end && Date.parse(row.coverage_end)<=Date.now()));
    return {...row,status:(stale||(row.status==='snapshot'&&row.coverage_end&&Date.parse(row.coverage_end)<=Date.now()))?'stale':row.status};
  });
}
export async function snapshot(env) {
  const [blocks,tasks,notifications,sources,prefs,subs]=await Promise.all([
    all(env,'SELECT * FROM blocks WHERE active=1 AND end_at>? ORDER BY start_at LIMIT 250',new Date(Date.now()-7*86400000).toISOString()),
    all(env,"SELECT * FROM tasks ORDER BY CASE WHEN status='done' THEN 1 ELSE 0 END, COALESCE(due_at,'9999'),created_at DESC LIMIT 150"),
    all(env,'SELECT * FROM notifications ORDER BY created_at DESC LIMIT 60'),health(env),preferences(env),all(env,'SELECT id FROM subscriptions')]);
  // Scout roles with their real links, for the signed-in web app only (Telegram shows defanged links).
  const jobs=await all(env,'SELECT company,title,location,url,sent_at FROM scout_jobs WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 25').catch(()=>[]);
  return {jobs,googleConfigured:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),breakers:(await all(env,"SELECT id FROM settings WHERE id LIKE 'breaker:%' AND value='open'")).map(r=>r.id.slice(8)),blocks,tasks,notifications,sources,preferences:prefs,pushDevices:subs.length,paused:await isPaused(env),telegram:!!(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_OWNER_ID),vapidPublicKey:env.VAPID_PUBLIC_KEY||null,timezone:'America/Chicago',voiceReady:env.VOICE_ENABLED==='true',aiProvider:env.ANTHROPIC_API_KEY?'Claude API':env.AI?'Cloudflare Workers AI':'unavailable',llmUsage:await usageToday(env)};
}
export async function capture(env,input,origin='capture') {
  const title=cleanText(input.title,500),notes=typeof input.notes==='string'?input.notes.slice(0,6000):'';
  if(input.due_at && !validInstant(input.due_at)) throw new Error('Deadline needs a time and timezone');
  const id=input.id?cleanText(input.id,160):crypto.randomUUID(),now=nowIso();
  const category=['personal','school','persian','career'].includes(input.category)?input.category:'personal';
  const confidence=['confirmed','verified','unconfirmed'].includes(input.confidence)?input.confidence:'unconfirmed';
  await run(env,'INSERT INTO tasks(id,title,notes,category,due_at,source,source_url,confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes=excluded.notes,due_at=excluded.due_at,source_url=excluded.source_url,confidence=excluded.confidence,updated_at=excluded.updated_at WHERE tasks.source=excluded.source',id,title,notes,category,input.due_at?new Date(input.due_at).toISOString():null,origin,safeUrl(input.source_url),confidence,now,now);
  return {id,title};
}
export async function checkin(env,kind,id,input) {
  if(!STATES.includes(input.status)) throw new Error('Unknown check-in status');
  const table=kind==='tasks'?'tasks':'blocks';
  const row=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first();
  if(!row) throw new Error('Item not found');
  const note=typeof input.note==='string'?input.note.slice(0,3000):'';
  if(table==='blocks') {
    const minutes=input.actual_minutes==null?null:Number(input.actual_minutes);
    if(minutes!==null&&(!Number.isInteger(minutes)||minutes<0||minutes>1440)) throw new Error('Minutes must be between 0 and 1440');
    await run(env,'UPDATE blocks SET status=?,note=?,actual_minutes=?,updated_at=? WHERE id=?',input.status,note,minutes,nowIso(),id);
  } else await run(env,'UPDATE tasks SET status=?,note=?,completed_at=?,updated_at=? WHERE id=?',input.status,note,input.status==='done'?nowIso():null,nowIso(),id);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`checkin:${input.status}`,id,nowIso());
  return {ok:true,status:input.status,calendarChanged:false};
}
export async function syncCalendar(env,input) {
  if(!Array.isArray(input.events)||input.events.length>500||!validInstant(input.from)||!validInstant(input.to)||Date.parse(input.to)<=Date.parse(input.from)) throw new Error('Complete bounded calendar snapshot required');
  if(input.complete!==true) throw new Error('Fetch all calendar pages before syncing');
  const now=nowIso(),from=new Date(input.from).toISOString(),to=new Date(input.to).toISOString();
  const events=input.events.filter(e=>/^(Class work|Career) — /.test(e.summary||''));
  for(const e of events) if(!e.id||!validInstant(e.start)||!validInstant(e.end)||Date.parse(e.end)<=Date.parse(e.start)) throw new Error('Invalid calendar event');
  // No mass deactivation: an import that would drop more than half of 4+ active blocks is held. Only the same
  // shrink seen 3 syncs in a row (about 45 minutes) is accepted, so one bad or partial fetch can't wipe the schedule.
  const active=(await all(env,'SELECT id FROM blocks WHERE active=1 AND start_at>=? AND start_at<?',from,to)).map(r=>r.id),keep=new Set(events.map(e=>e.id)),dropped=active.filter(id=>!keep.has(id));
  if(active.length>=4&&dropped.length*2>active.length){
    const sig=await hash(dropped.sort().join(',')),prior=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='calendar_shrink'").first())?.value||'{}'),seen=prior.sig===sig?(prior.n||0)+1:1;
    if(seen<3){
      await run(env,"INSERT INTO settings(id,value) VALUES('calendar_shrink',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",JSON.stringify({sig,n:seen}));
      await source(env,'calendar','error',`Held a calendar import that would remove ${dropped.length} of ${active.length} work blocks. It applies if it's still the same after 3 checks.`);
      throw new Error('Calendar import would remove most blocks; held');
    }
  }
  await run(env,"DELETE FROM settings WHERE id='calendar_shrink'");
  const statements=[env.DB.prepare('UPDATE blocks SET active=0 WHERE start_at>=? AND start_at<?').bind(from,to)];
  for(const e of events) statements.push(env.DB.prepare('INSERT INTO blocks(id,title,description,start_at,end_at,category,calendar_url,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,start_at=excluded.start_at,end_at=excluded.end_at,category=excluded.category,calendar_url=excluded.calendar_url,active=1,updated_at=excluded.updated_at').bind(String(e.id),String(e.summary).slice(0,500),String(e.description||'').slice(0,6000),new Date(e.start).toISOString(),new Date(e.end).toISOString(),blockCategory(e.summary),safeUrl(e.web_link||e.display_url||null),now));
  // Full calendar for the agent's calendar tools (M7 `events`: title and times only, never descriptions). Blocks stay the
  // work subset above, and the shrink guard ignores this table. owned defaults to true: a snapshot is his own calendar.
  statements.push(env.DB.prepare('DELETE FROM events WHERE start_at>=? AND start_at<?').bind(from,to));
  for(const e of input.events.filter(e=>e.id&&validInstant(e.start)&&validInstant(e.end)&&Date.parse(e.end)>Date.parse(e.start)))
    statements.push(env.DB.prepare('INSERT INTO events(id,title,start_at,end_at,all_day,owned,category,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,owned=excluded.owned,category=excluded.category,updated_at=excluded.updated_at').bind(String(e.id),String(e.summary||'').slice(0,500),new Date(e.start).toISOString(),new Date(e.end).toISOString(),e.all_day?1:0,e.owned===false?0:1,eventCategory(e.summary),now));
  await env.DB.batch(statements);
  await source(env,'calendar','snapshot','Calendar snapshot imported. Continuous sync requires the Google connector or a configured routine.',to);
  return {ok:true,blocks:events.length};
}
export async function notify(env,notice) {
  const now=nowIso();
  const inserted=await run(env,'INSERT OR IGNORE INTO notifications(id,title,body,kind,block_id,created_at) VALUES(?,?,?,?,?,?)',notice.id,notice.title,notice.body,notice.kind,notice.block_id||null,now);
  if(!inserted.meta.changes) return;
  // Inbox is always retained. Push failures must not duplicate the notification.
  await deliver(env,notice);
}
async function deliver(env,notice) {
  const prefs=await preferences(env);
  if(!['test','emergency'].includes(notice.kind)&&!notice.urgent&&(!prefs.notifications||isQuiet(new Date(),prefs)))return;
  // Telegram gets the same short, low-sensitivity text as push; it is not end-to-end encrypted.
  // Security alerts carry a one-tap pause, which only ever sets paused=true.
  // Email alerts carry 👍/👎 feedback buttons keyed to the stored mail_items row (callback_data max 64 bytes).
  const mailId=['mail','phishing'].includes(notice.kind)&&/^mail:([A-Za-z0-9_-]{1,40})$/.exec(notice.id)?.[1];
  const markup=notice.kind==='security'?{inline_keyboard:[[{text:'Not me → pause Beacon',callback_data:'s:pause'}]]}:mailId?{inline_keyboard:[[{text:'👍 Matters',callback_data:`f:${mailId}:m`},{text:'👎 Ignore',callback_data:`f:${mailId}:i`}]]}:null;
  // C3 content (DATA.md: finance summaries and other sensitive detail) never goes out as Telegram or push text:
  // those notices carry a pointer, and the full text stays in the web app's inbox behind sign-in.
  const out=notice.pointer?{title:notice.pointer,body:`Details in the Beacon web app: ${env.PUBLIC_URL||'https://your-worker.example.workers.dev'}`}:notice;
  await sendTelegram(env,`${out.title}\n${out.body}`,markup?{reply_markup:markup}:{})?.catch?.(()=>null);
  if(!env.VAPID_PRIVATE_KEY||!env.VAPID_PUBLIC_KEY) return;
  const subs=await all(env,'SELECT * FROM subscriptions');
  let delivered=0,failed=0;
  for(const row of subs){
    try {
      const sub=JSON.parse(row.subscription);
      const payload=await buildPushPayload({data:JSON.stringify({title:out.title,body:out.body.slice(0,500),url:'/',tag:notice.id}),options:{ttl:600}},sub,{subject:'mailto:owner@example.com',publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY});
      const res=await fetch(sub.endpoint,{...payload,redirect:'error',signal:AbortSignal.timeout(10000)});
      if(res.status===404||res.status===410) await run(env,'DELETE FROM subscriptions WHERE id=?',row.id);
      if(res.ok) delivered++;else failed++;
    }catch{failed++;}
  }
  await run(env,'UPDATE notifications SET delivery=?,attempts=attempts+1 WHERE id=?',delivered?'push_sent':failed?'push_failed':'inbox',notice.id);
}
export async function tick(env,at=new Date()) {
  const prefs=await preferences(env),local=localParts(at);
  await source(env,'scheduler','ok','Check-ins scheduled every five minutes; silence remains unknown.');
  // Scout fetches public boards from 6am, inside quiet hours; it only stores finds. Sending waits for scoutDigest below.
  await (await import('./scout.js')).scoutStep(env,at).catch(()=>console.error(JSON.stringify({event:'scout_failed'})));
  // Suppress all outgoing prompts during quiet hours, and never catch up a backlog.
  // Overnight fix session at 2:00am (runs during quiet hours, so it sits before that check): if feedback issues are open, the Mac node drafts fixes on a fix/DATE branch
  // (signed system job; never merged or deployed; the summary goes to Telegram for review).
  if(local.hour==='02'&&Number(local.minute)<5&&env.GITHUB_TOKEN){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`fix:${local.date}`,nowIso());
    if(first.meta.changes){try{const gh=await import('./github.js'),issues=await gh.openFeedback(env);if(issues.length)await (await import('./node.js')).queueJob(env,{kind:'fix',prompt:gh.fixPrompt(issues,local.date)},'routine');}catch{console.error(JSON.stringify({event:'fix_session_queue_failed'}));}}
  }
  // Reminder calls he asked for ring at the time he chose, even in quiet hours; /stop still blocks them (reminders.js).
  await (await import('./reminders.js')).dueReminders(env,at).catch(()=>console.error(JSON.stringify({event:'reminder_calls_failed'})));
  if(!prefs.notifications||isQuiet(at,prefs)) return;
  const sources=await health(env),calendar=sources.find(s=>s.id==='calendar');
  const blocks=await all(env,'SELECT * FROM blocks WHERE active=1 AND start_at>? AND start_at<? ORDER BY start_at',new Date(at.getTime()-86400000).toISOString(),new Date(at.getTime()+86400000).toISOString());
  if(['ok','snapshot'].includes(calendar.status)) for(const block of blocks) for(const n of scheduleNotices(block,at)) await notify(env,n);
  const inWindow=time=>{const minute=Number(local.hour)*60+Number(local.minute),[h,m]=time.split(':').map(Number);return minute>=h*60+m&&minute<h*60+m+5;};
  const today=blocks.filter(b=>localParts(new Date(b.start_at)).date===local.date);
  const tasks=await all(env,"SELECT * FROM tasks WHERE status NOT IN ('done','skipped') ORDER BY COALESCE(due_at,'9999') LIMIT 50");
  for(const task of tasks){
    if(!task.due_at||task.confidence==='unconfirmed') continue;
    const remaining=Date.parse(task.due_at)-at.getTime();
    for(const hours of [24,2])if(remaining>0&&remaining<=hours*3600000&&remaining>(hours*3600000-5*60000))await notify(env,{id:`deadline:${task.id}:${task.due_at}:${hours}`,kind:'deadline',title:`Due in ${hours} hours`,body:task.title});
  }
  // Rich brief (Telegram + optional call) once per window; the short inbox notice below stays for the web app.
  for(const kind of ['morning','evening'])if(inWindow(prefs[kind])){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`brief:${kind}:${local.date}`,nowIso());
    if(first.meta.changes)await (await import('./brief.js')).deliverBrief(env,kind,at).catch(()=>console.error(JSON.stringify({event:'brief_failed',kind})));
  }
  if(inWindow(prefs.morning)) {
    const priorities=[...tasks.filter(t=>t.due_at&&Date.parse(t.due_at)<at.getTime()+86400000).map(t=>t.title),...today.map(b=>b.title)].slice(0,3);
    await notify(env,{id:`morning:${local.date}`,kind:'brief',title:'Your morning check-in',body:priorities.length?priorities.join(' · '):'Capture today’s priorities. No current work blocks available.'});
  }
  if(inWindow(prefs.evening)) {
    const unresolved=today.filter(b=>!['done','skipped'].includes(b.status)&&Date.parse(b.end_at)<at.getTime());
    await notify(env,{id:`evening:${local.date}`,kind:'review',title:'Close out today',body:`${today.filter(b=>b.status==='done').length} blocks marked done; ${unresolved.length} still need an update. Report what happened; no blocks will be moved.`});
  }
  if(local.weekday==='Sun'&&inWindow(prefs.weekly)){
    await notify(env,{id:`weekly:${local.date}`,kind:'review',title:'Weekly review',body:'Review actual Persian practice against 6 hours, submissions, applications and follow-ups. Check the next week’s schedule and unresolved deadlines.'});
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`criteria:${local.date}`,nowIso());
    if(first.meta.changes){const text=await criteriaProposals(env,at);if(text)await sendTelegram(env,text)?.catch?.(()=>null);}
    await (await import('./review.js')).sendReview(env,at).catch(()=>console.error(JSON.stringify({event:'review_failed'})));
  }
  await (await import('./finance.js')).financeNotices(env,at).catch(()=>console.error(JSON.stringify({event:'finance_notices_failed'})));
  await (await import('./notes.js')).retryGithub(env).catch(()=>console.error(JSON.stringify({event:'github_retry_failed'})));
  await (await import('./outreach.js')).outreachNudges(env,at).catch(()=>console.error(JSON.stringify({event:'outreach_nudges_failed'})));
  // Career update call (default Mon 11:30, Thu 11:00): scout finds, follow-ups due and career deadlines, once per slot.
  for(const slot of prefs.careerCalls||[{day:'Mon',time:'11:30'},{day:'Thu',time:'11:00'}])if(local.weekday===slot.day&&inWindow(slot.time)){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`career:${local.date}`,nowIso());
    if(first.meta.changes)await (await import('./brief.js')).deliverCareer(env,at).catch(()=>console.error(JSON.stringify({event:'career_update_failed'})));
  }
  await (await import('./fellowships.js')).watchTick(env,at).catch(()=>console.error(JSON.stringify({event:'watch_failed'})));
  await (await import('./fellowships.js')).eventsTick(env,at).catch(()=>console.error(JSON.stringify({event:'events_watch_failed'})));
  // Credential expiry warnings, checked once a day at 5:15pm (after classes).
  if(inWindow('17:15')){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`credcheck:${local.date}`,nowIso());
    if(first.meta.changes)await (await import('./brief.js')).credentialNotices(env,at).catch(()=>console.error(JSON.stringify({event:'credential_notices_failed'})));
  }
  // Weekly quarantine review (default Sunday 5:00pm, after the weekly review; no classes): Telegram, plus a call if calls are on.
  const qslot=prefs.quarantineCall||{day:'Sun',time:'17:00'};
  if(local.weekday===qslot.day&&inWindow(qslot.time)){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`quarantine:${local.date}`,nowIso());
    if(first.meta.changes)await (await import('./brief.js')).deliverQuarantineCall(env,at).catch(()=>console.error(JSON.stringify({event:'quarantine_review_failed'})));
  }
  if(inWindow(prefs.morning)) {
    const gaps=sources.filter(s=>!['ok'].includes(s.status));
    if(gaps.length) await notify(env,{id:`health:${local.date}`,kind:'health',title:'Some sources need attention',body:gaps.map(s=>`${s.id}: ${s.status.replaceAll('_',' ')}`).join(' · ')});
  }
  await run(env,'DELETE FROM sessions WHERE expires_at<? OR last_seen_at<?',nowIso(),new Date(at.getTime()-7*86400000).toISOString());
  await run(env,'DELETE FROM rate_limits WHERE expires_at<?',nowIso());
  await run(env,'DELETE FROM voice_sessions WHERE expires_at<?',nowIso());
  // Interaction log and chat history keep 90 days (DATA.md); the agent working set (addresses, names, ids) is ignored on
  // read after 30 minutes (agent.js) and deleted here so it never sits in D1 past that.
  await (await import('./agent.js')).purgeInteractions(env,at).catch(()=>null);
  await run(env,"DELETE FROM settings WHERE id='agent_working_set' AND json_extract(value,'$.expires_at')<?",at.toISOString()).catch(()=>null);
}
export async function subscribe(env,sub){const id=await hash(sub.endpoint);await run(env,'INSERT INTO subscriptions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET subscription=excluded.subscription',id,JSON.stringify(sub),nowIso());return {ok:true};}
