// Calendar writes (ROADMAP M3, Confirm tier, approved in Telegram or the web app, never by voice).
// Only Jackson's own primary calendar, scope calendar.events.owned. Create, move, or cancel (cancel is an update to
// status "cancelled", never a delete). Time math is code: America/Chicago, conflicts against synced blocks, a
// from→to diff with weekday/date/timezone, and flags for DST crossings and moves of more than 7 days.
// Every write keeps a before-image for a 24-hour Undo.
import {all,run,nowIso} from './service.js';
import {googleAccessToken} from './google.js';
import {gfetch} from './gapi.js';
import {cleanText,validInstant} from './core.js';
const TZ='America/Chicago',BASE='https://www.googleapis.com/calendar/v3/calendars/primary/events';
const fmt=(iso,opts)=>new Date(iso).toLocaleString('en-US',{timeZone:TZ,...opts});
export const when=iso=>fmt(iso,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
const time=iso=>fmt(iso,{hour:'numeric',minute:'2-digit'});
export const span=(s,e)=>`${fmt(s,{weekday:'short',month:'short',day:'numeric'})}, ${time(s)}–${time(e)} ${fmt(e,{timeZoneName:'short'}).split(' ').pop()}`;
const offset=iso=>fmt(iso,{timeZoneName:'shortOffset'}).split(' ').pop();
// DST: the zone offset differs between two instants (e.g. CDT→CST on Nov 1, 2026).
export const crossesDst=(a,b)=>offset(a)!==offset(b);
const MAX_MS=12*3600000;
// Shared validation: real instants, end after start, at most 12 hours, from yesterday to a year out.
function times(a){
  if(!validInstant(a.start))return null;
  const start=new Date(a.start).toISOString(),end=a.end&&validInstant(a.end)?new Date(a.end).toISOString():new Date(Date.parse(start)+3600000).toISOString();
  const s=Date.parse(start),e=Date.parse(end);
  if(!(e>s)||e-s>MAX_MS||s<Date.now()-86400000||s>Date.now()+365*86400000)return null;
  return {start,end};
}
export function conflicts(blocks,start,end,skipId){
  return (blocks||[]).filter(b=>b.id!==skipId&&Date.parse(b.start_at)<Date.parse(end)&&Date.parse(b.end_at)>Date.parse(start)).slice(0,3).map(b=>`${b.title} (${time(b.start_at)}–${time(b.end_at)})`);
}
const flags=a=>[a.conflicts?.length?`Conflicts with: ${a.conflicts.join('; ')}.`:'',a.dst?'Crosses the daylight saving change, so check the time.':'',a.far?'This moves it more than 7 days.':''].filter(Boolean).join(' ');
// Move/cancel targets: the full synced calendar (M7 `events`, his own events only; live: ids never match) when the context
// carries it (agent turns, approvals), else the work blocks the single-shot model was shown. Both tables share one id space.
const target=(a,c)=>(c.events||[]).find(x=>x.id===a.event_id&&x.owned!==0)||(c.blocks||[]).find(x=>x.id===a.event_id)||null;
export const ownedEvents=(env,at=new Date())=>all(env,'SELECT id,title,start_at,end_at,owned FROM events WHERE owned=1 AND end_at>? ORDER BY start_at LIMIT 300',new Date(at.getTime()-86400000).toISOString());
export const CALENDAR_ACTIONS={
  cal_create:{tier:'confirm',perDay:15,channelApproval:true,exact:true,changed:'Your calendar changed since this was proposed',
    validate:(a,c)=>{const t=times(a);if(!t)return null;const title=cleanText(a.title,200).replace(/\s+/g,' ');return {type:'cal_create',title,...t,conflicts:conflicts(c.blocks,t.start,t.end),dst:crossesDst(t.start,t.end)};},
    render:a=>`Add to your calendar: “${a.title}”, ${span(a.start,a.end)}. ${flags(a)}`.trim(),
    destination:()=>'your Google Calendar (personal)',
    execute:(env,a,p)=>createEvent(env,a,p.id)},
  cal_move:{tier:'confirm',perDay:15,channelApproval:true,exact:true,changed:'Your calendar changed since this was proposed',
    validate:(a,c)=>{const b=target(a,c);if(!b)return null;const dur=Date.parse(b.end_at)-Date.parse(b.start_at),t=times({start:a.start,end:a.end||(validInstant(a.start)?new Date(Date.parse(a.start)+dur).toISOString():null)});if(!t)return null;
      return {type:'cal_move',event_id:b.id,title:b.title,from_start:b.start_at,from_end:b.end_at,...t,conflicts:conflicts(c.blocks,t.start,t.end,b.id),dst:crossesDst(b.start_at,t.start)||crossesDst(t.start,t.end),far:Math.abs(Date.parse(t.start)-Date.parse(b.start_at))>7*86400000};},
    render:a=>`Move “${a.title}”: from ${span(a.from_start,a.from_end)} → to ${span(a.start,a.end)}. ${flags(a)}`.trim(),
    destination:()=>'your Google Calendar (personal)',
    execute:(env,a,p)=>moveEvent(env,a,p.id)},
  cal_cancel:{tier:'confirm',perDay:15,channelApproval:true,exact:true,changed:'Your calendar changed since this was proposed',
    validate:(a,c)=>{const b=target(a,c);return b?{type:'cal_cancel',event_id:b.id,title:b.title,start:b.start_at,end:b.end_at}:null;},
    render:a=>`Cancel “${a.title}” on ${span(a.start,a.end)}. You can undo this for 24 hours.`,
    destination:()=>'your Google Calendar (personal)',
    execute:(env,a,p)=>cancelEvent(env,a,p.id)}
};
async function call(env,method,url,body){
  const r=await gfetch(method,url,await googleAccessToken(env,'personal'),body);
  if(r.status===401||r.status===403)throw new Error('Reconnect Google in the web app (Connections) to allow calendar changes');
  if(!r.ok)throw new Error(`Google Calendar error ${r.status}`);
  return r.json();
}
const at=iso=>({dateTime:iso,timeZone:TZ});
async function remember(env,type,target,before){const id=crypto.randomUUID().slice(0,8);await run(env,'INSERT INTO action_undo(id,type,target,before,created_at) VALUES(?,?,?,?,?)',id,type,target,before==null?null:JSON.stringify(before),nowIso());return id;}
// No attendees are ever set, so creating an event never emails anyone.
export async function createEvent(env,a){
  const ev=await call(env,'POST',`${BASE}?sendUpdates=none`,{summary:a.title,start:at(a.start),end:at(a.end),source:{title:'Beacon',url:'https://your-worker.example.workers.dev/'}});
  return {event_id:ev.id,reply:`Added “${a.title}”, ${span(a.start,a.end)}.`,undo_id:await remember(env,'calendar_create',ev.id,null)};
}
export async function moveEvent(env,a){
  await call(env,'PATCH',`${BASE}/${encodeURIComponent(a.event_id)}?sendUpdates=none`,{start:at(a.start),end:at(a.end)});
  await run(env,'UPDATE blocks SET start_at=?,end_at=? WHERE id=?',a.start,a.end,a.event_id);await run(env,'UPDATE events SET start_at=?,end_at=? WHERE id=?',a.start,a.end,a.event_id);
  return {reply:`Moved “${a.title}” to ${span(a.start,a.end)}.`,undo_id:await remember(env,'calendar_move',a.event_id,{start:a.from_start,end:a.from_end})};
}
// A cancelled event leaves `events` at once (the next 15-minute sync restores it after an undo).
export async function cancelEvent(env,a){
  await call(env,'PATCH',`${BASE}/${encodeURIComponent(a.event_id)}?sendUpdates=none`,{status:'cancelled'});
  await run(env,'UPDATE blocks SET active=0 WHERE id=?',a.event_id);await run(env,'DELETE FROM events WHERE id=?',a.event_id);
  return {reply:`Cancelled “${a.title}”.`,undo_id:await remember(env,'calendar_cancel',a.event_id,{start:a.start,end:a.end})};
}
// Undo: a created event is cancelled; a move goes back; a cancel is restored. Returns an error text, or null on success.
export async function undoCalendar(env,u,before){
  const url=`${BASE}/${encodeURIComponent(u.target)}?sendUpdates=none`;
  try{
    if(u.type==='calendar_create')await call(env,'PATCH',url,{status:'cancelled'});
    else if(u.type==='calendar_move'){await call(env,'PATCH',url,{start:at(before.start),end:at(before.end)});await run(env,'UPDATE blocks SET start_at=?,end_at=? WHERE id=?',before.start,before.end,u.target);await run(env,'UPDATE events SET start_at=?,end_at=? WHERE id=?',before.start,before.end,u.target);}
    else if(u.type==='calendar_cancel'){await call(env,'PATCH',url,{status:'confirmed'});await run(env,'UPDATE blocks SET active=1 WHERE id=?',u.target);}
    else return 'That can’t be undone here.';
  }catch(e){return `Couldn’t undo: ${String(e.message).slice(0,100)}`;}
  return null;
}
