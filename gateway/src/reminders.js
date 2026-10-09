// Reminder calls (Jackson, 2026-10-08): "call me at 2pm tomorrow about X". A Confirm-tier action (actions.js
// reminder_call) stores one row; tick() calls dueReminders every 5 minutes, which rings his OWN number once per row
// through the brief-call path (verification code in Telegram first, voicemail gets a hang-up). No third party is ever
// called. Late rows are not caught up: anything more than 30 minutes past due is marked missed and noted in Telegram.
import {all,run,nowIso,isPaused} from './service.js';
import {cleanText,validInstant} from './core.js';
import {sendTelegram} from './tgapi.js';

export const MAX_AHEAD_MS=30*86400000,LATE_MS=30*60000;
// sendTelegram can return null when Telegram isn't configured; never let a notice break the loop.
const tg=(env,text)=>Promise.resolve().then(()=>sendTelegram(env,text)).catch(()=>null);
const when=iso=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

// The call time must be a real instant at least a minute out and within 30 days; the message is his reminder in plain text.
export function validateReminder(a,now=Date.now()){
  if(!a||!validInstant(a.start))return null;
  const t=Date.parse(a.start);if(t<now+60000||t>now+MAX_AHEAD_MS)return null;
  let text='';try{text=cleanText(a.title,300).replace(/\s+/g,' ').trim();}catch{return null;}if(!text)return null;
  return {type:'reminder_call',start:new Date(t).toISOString(),title:text};
}
export const renderReminder=a=>`Call you at ${when(a.start)} (Chicago) to remind you: “${a.title}”.`;

export async function scheduleReminder(env,a,p={}){
  const id=crypto.randomUUID();
  await run(env,'INSERT INTO reminder_calls(id,text,call_at,status,origin,proposal_id,created_at) VALUES(?,?,?,?,?,?,?)',id,a.title,a.start,'pending',p.origin||'telegram',p.id||null,nowIso());
  return {reply:`Set. I’ll call you ${when(a.start)} about: ${a.title}`,reminder_id:id};
}

// Runs from tick(). Respects /stop (pause) but not quiet hours: he chose the time himself.
export async function dueReminders(env,at=new Date(),{call}={}){
  if(await isPaused(env))return [];
  const now=at.getTime(),out=[];
  const rows=await all(env,"SELECT * FROM reminder_calls WHERE status='pending' AND call_at<=? ORDER BY call_at LIMIT 5",new Date(now).toISOString());
  for(const r of rows){
    // Claim the row first so two overlapping ticks can't both ring.
    const late=now-Date.parse(r.call_at)>LATE_MS;
    const claim=await run(env,"UPDATE reminder_calls SET status=? WHERE id=? AND status='pending'",late?'missed':'calling',r.id);
    if(!claim.meta.changes)continue;
    if(late){await tg(env,`⏰ Missed reminder call (Beacon was down at ${when(r.call_at)}): ${r.text}`);out.push({id:r.id,status:'missed'});continue;}
    let res={called:false};
    try{res=await (call||defaultCall)(env,r,at);}catch{res={called:false};}
    await run(env,'UPDATE reminder_calls SET status=?,called_at=? WHERE id=?',res.called?'called':'failed',nowIso(),r.id);
    if(!res.called)await tg(env,`⏰ Reminder (the call didn’t go through): ${r.text}`);
    out.push({id:r.id,status:res.called?'called':'failed'});
  }
  return out;
}

async function defaultCall(env,r,at){
  const callOn=env.VOICE_ENABLED==='true'&&env.TWILIO_SID&&env.TWILIO_TOKEN&&env.OWNER_NUMBER&&env.TWILIO_NUMBER;
  if(!callOn)return {called:false};
  const {placeCall,verificationCode}=await import('./brief.js');
  const code=verificationCode();
  await sendTelegram(env,`⏰ Reminder: ${r.text}\n📞 Calling you now. Verification code: ${code}`);
  return placeCall(env,'reminder',['Hey Jackson, it’s Beacon with the reminder you asked for.',r.text],code,at);
}

export async function cancelReminder(env,id){const r=await run(env,"UPDATE reminder_calls SET status='cancelled' WHERE id=? AND status='pending'",id);return r.meta.changes>0;}
