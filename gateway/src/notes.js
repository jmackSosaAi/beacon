// Notes and feedback (Auto tier: Jackson's own words, stored verbatim; the model only decides which kind).
import {all,run,nowIso} from './service.js';
import {commitNote,openFeedbackIssue} from './github.js';
const PREFIX=/^\s*(?:hey\s+beacon[,\s]*)?(?:(?:take\s+a\s+|make\s+a\s+|quick\s+)?note(?:\s+to\s+self)?|feedback(?:\s+for\s+(?:you|beacon))?)\s*[:,-]?\s*/i;
export const verbatim=text=>String(text).replace(PREFIX,'').trim().slice(0,4000)||String(text).trim().slice(0,4000);
// Feedback gets context so it can be fixed later: channel, time, and what Beacon said just before.
// Notes are Jackson's own words from his own channels (SAFETY rule 9). Anything else is data and can't become a note, a rule or a preference.
export const NOTE_CHANNELS=['web','telegram','voice','voice-brief'];
export async function saveNote(env,kind,text,channel,extra=null){
  if(!NOTE_CHANNELS.includes(channel))throw new Error('Notes only come from your own channels');
  let context='';
  if(kind==='feedback'&&extra)context=JSON.stringify({channel,at:nowIso(),...extra});
  else if(kind==='feedback'){
    const prior=await all(env,"SELECT role,content,created_at FROM messages ORDER BY created_at DESC LIMIT 4");
    context=JSON.stringify({channel,at:nowIso(),recent:prior.reverse().map(m=>({role:m.role,text:String(m.content).slice(0,400),at:m.created_at}))});
  }
  const id=crypto.randomUUID();
  await run(env,'INSERT INTO notes(id,kind,text,channel,context,created_at) VALUES(?,?,?,?,?,?)',id,kind,verbatim(text),String(channel).slice(0,20),context,nowIso());
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`${kind}:saved:${String(channel).slice(0,20)}`,id,nowIso());
  await pushToGithub(env,id);
  return id;
}
export async function undoNote(env,id){const r=await run(env,'DELETE FROM notes WHERE id=? AND exported_at IS NULL',String(id).slice(0,64));return r.meta.changes>0;}
export const recentNotes=(env,kind,limit=10)=>all(env,'SELECT text,created_at,exported_at FROM notes WHERE kind=? ORDER BY created_at DESC LIMIT ?',kind,limit);
// Admin export: unexported rows; the local script writes them into the repo, then marks them exported.
export const unexported=env=>all(env,'SELECT * FROM notes WHERE exported_at IS NULL ORDER BY created_at LIMIT 500');
export async function markExported(env,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>500)throw new Error('1 to 500 ids');
  const r=await run(env,`UPDATE notes SET exported_at=? WHERE exported_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`,nowIso(),...ids.map(i=>String(i).slice(0,64)));
  return {marked:r.meta.changes};
}

// Straight into the repo when GitHub is configured: notes are committed to notes/INBOX.md, feedback becomes an issue.
// Failures leave the row unexported so scripts/export-notes.mjs (or a later retry) still picks it up.
export async function pushToGithub(env,id){
  if(!env.GITHUB_TOKEN)return null;
  const n=await env.DB.prepare('SELECT * FROM notes WHERE id=? AND exported_at IS NULL').bind(id).first();if(!n)return null;
  // Pre-commit scan: anything that looks like a secret or personal data stays in Beacon and never reaches GitHub.
  const hits=(await import('./scan.js')).scanText(n.text);
  if(hits.length){
    await run(env,'UPDATE notes SET exported_at=? WHERE id=?',nowIso(),id);
    await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`${n.kind}:held-sensitive`,id,nowIso());
    await (await import('./tgapi.js')).sendTelegram(env,`🔒 Your ${n.kind} is saved in Beacon but was not sent to GitHub: it looks like it contains a ${hits.join(', ')}.`)?.catch?.(()=>null);
    return null;
  }
  try{
    let extra={};try{extra=JSON.parse(n.context||'{}');}catch{}
    const url=n.kind==='feedback'?await openFeedbackIssue(env,{...n,call:extra.call}):await commitNote(env,n);
    await run(env,'UPDATE notes SET exported_at=? WHERE id=?',nowIso(),id);
    await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`${n.kind}:github`,id,nowIso());
    // A note commit changed the repo: the Mac node pulls on its next check-in (signed system job).
    if(n.kind==='note')await (await import('./node.js')).queueJob(env,{kind:'pull'},'routine').catch(()=>null);
    return url;
  }catch(e){console.error(JSON.stringify({event:'github_push_failed',kind:n.kind,error:String(e.message).slice(0,40)}));return null;}
}
// Retry anything that failed earlier (called from the scheduler).
export async function retryGithub(env){if(!env.GITHUB_TOKEN)return;for(const n of await all(env,'SELECT id FROM notes WHERE exported_at IS NULL AND created_at<? LIMIT 10',new Date(Date.now()-5*60000).toISOString()))await pushToGithub(env,n.id);}
