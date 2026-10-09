// Questions answered by code (no model call): schedule, assignments and email. Schedule questions by voice and chat: "what's on my schedule tomorrow?", "do I have class Friday?", "what's coming up?",
// "what do I have on Oct 20?". Answered by code from the synced calendar (no model call). Dates outside the synced
// window (yesterday to 15 days out) are read live from Google Calendar, read-only, at most 31 days at a time.
import {all} from './service.js';
import {googleAccessToken,get,timed,eventRow} from './google.js';
import {eventCategory} from './core.js';
const TZ='America/Chicago',DAY=86400000,SYNC_DAYS=15,MAX_DAYS=31;
const WEEKDAYS=['sun','mon','tue','wed','thu','fri','sat'];
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const ACTION=/\b(?:add|put|move|reschedule|cancel|create|book|remove|delete|block\s+off|set\s+up)\b|\bschedule\s+(?:a|an|my|the|me|it|this|that)\b/i;
const DATEWORD=/\b(?:today|tonight|tomorrow|tmrw?|tmr|yesterday|week|weekend|(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2}|the\s+\d{1,2}(?:st|nd|rd|th)|in\s+\d+\s+days|next\s+\d+\s+days|this\s+(?:morning|afternoon|evening))\b/i;
const STRONG=/\b(?:schedule|calendar|class(?:es)?|lectures?|agenda|coming\s+up|upcoming|lined\s+up|on\s+my\s+plate|am\s+i\s+(?:free|busy))\b/i;
const WEAK=/\b(?:plans?|events?|meetings?|appointments?|going\s+on|happening|busy|free|what\s+(?:do|have)\s+i\s+(?:got|have)|what(?:'?s|\s+is)\s+on|looks?\s+like|how\s+(?:does|do|is)\s+.{0,20}look(?:ing)?)\b/i;
const ASK={test:t=>STRONG.test(t)||(WEAK.test(t)&&DATEWORD.test(t))};
const DAY_RE='(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|rsday|urday)?';
const MONTH_RE='(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

export const isScheduleQuery=text=>{const t=String(text).trim();return t.length<=200&&!ACTION.test(t)&&ASK.test(t);};

// Fast-path gate (M7, design "Routing: Gate"; applied only under AGENT_MODE). A code answer fires only for a short ask in
// one domain that names no specific item; anything else goes to the planner, which can call day_brief/mail_status for the
// same free answer. Must-pass hijack cases: "am I free before my econ pset is due?", "when is homework 3 due?",
// "what's due tomorrow and is anything in my email about it", "what's tomorrow look like and what's due".
const DOMAINS=[/\b(?:schedule|calendar|class(?:es)?|lectures?|agenda|meetings?|events?|appointments?)\b/i,
  /\b(?:tasks?|to-?dos?|psets?|problem\s+sets?|homework|hw|assignments?|due|deadlines?|quiz(?:zes)?|exams?|midterms?|finals?|coursework)\b/i,
  /\b(?:e-?mails?|inbox(?:es)?|gmail|mail)\b/i];
// Words no fast path handles (free gaps, cross-references, Club, weather) and course or numbered-item names.
const OTHER=/\b(?:club|groupme|weather|rain|umbrella|jacket|snow|forecast|free|busy|before|after|between)\b/i;
const ITEM=/\b(?:homework|hw|psets?|problem\s+sets?|assignments?|quiz|exam|essay|paper|reading|chapter)\s*#?\d+\b|\b(?:econ|stats|persian|russian|art\s+games|history)\b|\b(?:with|about|regarding)\s+\S|\bfrom\s+(?!today|yesterday|this|the\s+last|now)\w/i;
const CALENDAR_WORD=/^(?:I|Beacon|(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs?)?|Fri|Sat(?:ur)?|Sun)(?:day)?|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Today|Tomorrow|Tonight)$/;
// A capitalised word after the first is a name ("Dana", "CIBC"), unless it is a weekday or month.
const named=t=>t.split(/\s+/).slice(1).some(w=>/^[A-Z][\w'-]*$/.test(w.replace(/[?.!,;:]+$/,''))&&!CALENDAR_WORD.test(w.replace(/[?.!,;:]+$/,'')));
export const fastPathGate=text=>{const t=String(text).trim();return t.split(/\s+/).length<=10&&!/\b(?:and|then|also)\b/i.test(t)&&DOMAINS.filter(d=>d.test(t)).length<=1&&!OTHER.test(t)&&!ITEM.test(t)&&!named(t);};

// Local (Chicago) calendar dates as {y,m,d}; arithmetic in UTC days, so DST never shifts a date.
const today=now=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now).map(x=>[x.type,x.value]));return {y:+p.year,m:+p.month,d:+p.day};};
const addDays=(a,n)=>{const t=new Date(Date.UTC(a.y,a.m-1,a.d+n));return {y:t.getUTCFullYear(),m:t.getUTCMonth()+1,d:t.getUTCDate()};};
const weekday=a=>new Date(Date.UTC(a.y,a.m-1,a.d)).getUTCDay();
const serial=a=>Date.UTC(a.y,a.m-1,a.d)/DAY;
// Midnight at the start of a Chicago date, as an instant (checked twice so DST days come out right).
const offsetMin=ms=>{const s=new Intl.DateTimeFormat('en-US',{timeZone:TZ,timeZoneName:'shortOffset'}).format(new Date(ms)).split('GMT')[1]||'0';const [h,m='0']=s.split(':');return (+h)*60+Math.sign(+h||1)*(+m);};
export const startOf=a=>{let ms=Date.UTC(a.y,a.m-1,a.d);ms-=offsetMin(ms)*60000;return Date.UTC(a.y,a.m-1,a.d)-offsetMin(ms)*60000;};
// A Chicago clock time (minutes after midnight) on a local date, as an instant; same double offset check.
const atLocal=(a,mins)=>{const g=Date.UTC(a.y,a.m-1,a.d)+mins*60000;return g-offsetMin(g-offsetMin(g)*60000)*60000;};
// ISO with the Chicago offset ("2026-10-07T09:30-05:00") so the planner never converts from UTC.
export const localIso=ms=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}${p.timeZoneName.replace('GMT','')||'Z'}`;};

// Returns {from,to,label,days} (from/to are local dates, to inclusive) or {error}.
export function parseRange(text,now=new Date()){
  const t=String(text).toLowerCase().replace(/[’']/g,"'"),base=today(now),one=(a,label)=>({from:a,to:a,label});
  let m;
  if(/\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/.test(t))return {...one(base,'Today'),today:true};
  if(/\bday\s+after\s+tomorrow\b/.test(t))return one(addDays(base,2),'The day after tomorrow');
  if(/\b(?:tomorrow|tmrw?|tmr)\b/.test(t))return one(addDays(base,1),'Tomorrow');
  if(/\byesterday\b/.test(t))return one(addDays(base,-1),'Yesterday');
  if((m=/\bin\s+(\d{1,2})\s+days?\b/.exec(t)))return one(addDays(base,+m[1]),`In ${m[1]} days`);
  if((m=/\b(?:next|coming)\s+(\d{1,2})\s+days\b/.exec(t)))return {from:base,to:addDays(base,Math.min(+m[1],MAX_DAYS)-1),label:`The next ${m[1]} days`};
  if(/\bthis\s+weekend\b|\bthe\s+weekend\b/.test(t)){const s=addDays(base,(6-weekday(base)+7)%7);return {from:weekday(base)===0?base:s,to:weekday(base)===0?base:addDays(s,1),label:'This weekend'};}
  if(/\bnext\s+weekend\b/.test(t)){const s=addDays(base,(6-weekday(base)+7)%7+7);return {from:s,to:addDays(s,1),label:'Next weekend'};}
  if(/\bnext\s+week\b/.test(t)){const s=addDays(base,(8-weekday(base))%7||7);return {from:s,to:addDays(s,6),label:'Next week'};}
  if(/\b(?:this|the)\s+week\b|\brest\s+of\s+(?:the|this)\s+week\b/.test(t))return {from:base,to:addDays(base,(7-weekday(base))%7),label:'This week'};
  if((m=new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(t))||(m=new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`).exec(t))){
    const numFirst=/^\d/.test(m[1]),mon=MONTHS.indexOf((numFirst?m[2]:m[1]).slice(0,3))+1,d=+(numFirst?m[1]:m[2]);
    return dated(base,mon,d,m[3]?+m[3]:null);
  }
  if((m=/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t)))return dated(base,+m[1],+m[2],m[3]?(m[3].length===2?2000+ +m[3]:+m[3]):null);
  if((m=/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(t))){let mon=base.m,y=base.y;if(+m[1]<base.d){mon++;if(mon>12){mon=1;y++;}}return dated(base,mon,+m[1],y);}
  if((m=new RegExp(`\\b(?:(next|this|on)\\s+)?${DAY_RE}\\b`).exec(t))){
    const target=WEEKDAYS.indexOf(m[2].slice(0,3));let n=(target-weekday(base)+7)%7;if(m[1]==='next'&&n===0)n=7;
    const a=addDays(base,n);return one(a,n===0?'Today':n===1?'Tomorrow':null);
  }
  if(/\b(?:coming\s+up|upcoming|lined\s+up|ahead|soon|week)\b/.test(t))return {from:base,to:addDays(base,6),label:'The next 7 days'};
  return {...one(base,'Today'),today:true,unspecified:true};
}
function dated(base,mon,d,y){
  if(!(mon>=1&&mon<=12&&d>=1&&d<=31))return {error:'I couldn’t read that date. Try “October 20” or “10/20”.'};
  let a={y:y??base.y,m:mon,d};
  const check=addDays(a,0);if(check.m!==mon)return {error:'That date doesn’t exist.'};
  if(y==null&&serial(a)<serial(base)-60)a={...a,y:a.y+1};
  return {from:a,to:a,label:null};
}

const fmt=(ms,o)=>new Date(ms).toLocaleString('en-US',{timeZone:TZ,...o});
const clock=ms=>fmt(ms,{hour:'numeric',minute:'2-digit'});
const dayName=a=>fmt(startOf(a)+12*3600000,{weekday:'long',month:'short',day:'numeric'});
const line=e=>`${clock(e.start)}–${clock(e.end)} ${String(e.title||'(no title)').replace(/\s+/g,' ').slice(0,80)}`;

const synced=(fromMs,toMs)=>fromMs>=Date.now()-DAY&&toMs<=Date.now()+SYNC_DAYS*DAY;
// Live, read-only read of his primary calendar for dates outside the synced window. Ids are tagged live: so no action can
// target them; only title, times, category and ownership come back (never description, location, attendees or links).
export async function liveEvents(env,fromMs,toMs){
  const token=await googleAccessToken(env,'personal'),url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  for(const [k,v] of Object.entries({timeMin:new Date(fromMs).toISOString(),timeMax:new Date(toMs).toISOString(),singleEvents:'true',maxResults:'250',orderBy:'startTime'}))url.searchParams.set(k,v);
  return ((await get(url,token)).items||[]).filter(timed).map(e=>{const r=eventRow(e);return {id:'live:'+r.id,title:r.summary,start:Date.parse(r.start),end:Date.parse(r.end),all_day:r.all_day,owned:r.owned,category:eventCategory(r.summary),live:true};});
}
// Full calendar for the agent's tools (M7): the synced events table inside the window, a live read outside it.
export async function calendarEvents(env,fromMs,toMs){
  if(!synced(fromMs,toMs))return liveEvents(env,fromMs,toMs);
  return (await all(env,'SELECT id,title,start_at,end_at,all_day,owned,category FROM events WHERE start_at<? AND end_at>? ORDER BY start_at LIMIT 200',new Date(toMs).toISOString(),new Date(fromMs).toISOString())).map(e=>({id:e.id,title:e.title,start:Date.parse(e.start_at),end:Date.parse(e.end_at),all_day:!!e.all_day,owned:!!e.owned,category:e.category,live:false}));
}
// Work blocks (the fast path's view): synced blocks inside the window, timed live events outside it.
async function events(env,fromMs,toMs){
  if(synced(fromMs,toMs))return (await all(env,"SELECT title,start_at,end_at FROM blocks WHERE active=1 AND start_at<? AND end_at>? ORDER BY start_at LIMIT 200",new Date(toMs).toISOString(),new Date(fromMs).toISOString())).map(b=>({title:b.title,start:Date.parse(b.start_at),end:Date.parse(b.end_at)}));
  return (await liveEvents(env,fromMs,toMs)).filter(e=>!e.all_day);
}
const hm=(s,d)=>{const m=/^(\d{1,2}):(\d{2})$/.exec(String(s||''));return m&&+m[1]<24&&+m[2]<60?+m[1]*60+ +m[2]:d;};
// Free gaps of at least minMinutes within waking hours (preferences wakingStart/wakingEnd "HH:MM", default 08:00–23:00)
// on each Chicago day of [fromMs,toMs). Timed events block; all-day events don't. Pure: the caller fetches the events.
export function freeGaps(list,fromMs,toMs,prefs={},minMinutes=30){
  const wake=hm(prefs.wakingStart,8*60),sleep=hm(prefs.wakingEnd,23*60),min=Math.max(5,Math.min(720,Number.isInteger(minMinutes)?minMinutes:30))*60000;
  const busy=list.filter(e=>!e.all_day&&e.end>e.start).map(e=>[e.start,e.end]).sort((a,b)=>a[0]-b[0]),out=[];
  for(let d=today(new Date(fromMs)),i=0;i<=MAX_DAYS&&startOf(d)<toMs&&out.length<20;d=addDays(d,1),i++){
    const we=Math.min(toMs,atLocal(d,sleep));let cur=Math.max(fromMs,atLocal(d,wake));
    for(const [s,e] of busy){if(e<=cur||s>=we)continue;if(s-cur>=min)out.push([cur,s]);cur=Math.max(cur,e);}
    if(we-cur>=min)out.push([cur,we]);
  }
  return out.slice(0,20).map(([s,e])=>({start:localIso(s),end:localIso(e),minutes:Math.round((e-s)/60000)}));
}

export async function scheduleAnswer(env,text,now=new Date()){
  const r=parseRange(text,now);if(r.error)return r.error;
  const days=serial(r.to)-serial(r.from)+1;if(days>MAX_DAYS)return `That’s more than ${MAX_DAYS} days. Ask about a shorter stretch.`;
  const fromMs=r.today?now.getTime():startOf(r.from),toMs=startOf(addDays(r.to,1));
  let list;try{list=await events(env,fromMs,toMs);}catch{return 'I can’t read your calendar for that date right now. Reconnect Google in the web app (Connections).';}
  const label=r.label||dayName(r.from);
  if(days===1){
    const head=r.today?'Rest of today':r.label?`${label} (${dayName(r.from)})`:label;
    if(!list.length){
      if(!r.today)return `${head}: nothing on your calendar.`;
      const next=(await events(env,toMs,toMs+7*DAY).catch(()=>[]))[0];
      return `Nothing else on your calendar today.${next?` Next: ${line(next)} on ${fmt(next.start,{weekday:'long'})}.`:''}`;
    }
    return `${head}: ${list.slice(0,15).map(line).join('; ')}${list.length>15?`; plus ${list.length-15} more`:''}.`;
  }
  if(!list.length)return `${label}: nothing on your calendar.`;
  const byDay=new Map();for(const e of list){const k=fmt(e.start,{weekday:'short',month:'short',day:'numeric'});if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(e);}
  const parts=[...byDay].slice(0,10).map(([k,es])=>`${k}: ${es.slice(0,8).map(line).join('; ')}${es.length>8?` (+${es.length-8} more)`:''}`);
  return `${label}: ${parts.join('. ')}${byDay.size>10?'. More after that.':'.'}`;
}

// Assignments: "what assignments are coming up?", "what's due this week?", "anything due Friday?". School tasks with
// a due date, from the tasks table (course trackers and captures). Default: overdue plus the next 7 days.
const DONE_TALK=/\b(?:add|finished|done\s+with|completed?|submitted|turned\s+in|mark|bump|prioriti[sz]e|deprioriti[sz]e|remind\s+me)\b/i;
const HOMEWORK=/\b(?:assignments?|homework|hw|psets?|problem\s+sets?|due|deadlines?|quiz(?:zes)?|exams?|midterms?|coursework|school\s*work)\b/i,SCHOOL=/\b(?:assignments?|homework|hw|psets?|problem\s+sets?|quiz(?:zes)?|exams?|midterms?|coursework|school|class(?:es)?)\b/i;
export const isAssignmentQuery=text=>{const t=String(text).trim();return t.length<=200&&!DONE_TALK.test(t)&&HOMEWORK.test(t)&&/\b(?:what|which|any|anything|do\s+i|have\s+i|list|show|tell|coming|upcoming|next|when)\b/i.test(t);};
const dueWhen=iso=>fmt(Date.parse(iso),{weekday:'short',month:'short',day:'numeric'})+' '+clock(Date.parse(iso));
export async function assignmentsAnswer(env,text,now=new Date()){
  const r=parseRange(text,now);if(r.error)return r.error;
  const wide=r.unspecified||r.label==='The next 7 days',from=wide?startOf(today(now)):startOf(r.from),to=wide?startOf(addDays(today(now),7)):startOf(addDays(r.to,1));
  const label=wide?'Due in the next 7 days':r.label?`Due ${r.label.toLowerCase()}`:`Due ${dayName(r.from)}`;
  // School words ("assignments", "homework") → school tasks only; "what's due" / "deadlines" → every task with a due date.
  const open=`status NOT IN ('done','skipped') AND due_at IS NOT NULL${SCHOOL.test(text)?" AND category='school'":''}`;
  const rows=await all(env,`SELECT title,due_at FROM tasks WHERE ${open} AND due_at>=? AND due_at<? ORDER BY due_at LIMIT 20`,new Date(from).toISOString(),new Date(to).toISOString());
  const late=wide?await all(env,`SELECT title,due_at FROM tasks WHERE ${open} AND due_at<? AND due_at>? ORDER BY due_at LIMIT 5`,now.toISOString(),new Date(now.getTime()-14*DAY).toISOString()):[];
  const lateList=late.filter(t=>Date.parse(t.due_at)<now.getTime());
  const parts=[];
  if(lateList.length)parts.push(`Past due and still open: ${lateList.map(t=>`${t.title} (${dueWhen(t.due_at)})`).join('; ')}.`);
  const upcoming=rows.filter(t=>Date.parse(t.due_at)>=now.getTime()||!wide);
  parts.push(upcoming.length?`${label}: ${upcoming.map(t=>`${t.title} — ${dueWhen(t.due_at)}`).join('; ')}.`:`${label}: nothing open.`);
  return parts.join(' ');
}

// Email: "what's new in my email?", "anything new in my school inbox?", "check my personal email". Both accounts
// unless he names one. From the triage log (sender, subject, level only; no bodies). Default: the last 24 hours.
const MAIL=/\b(?:e-?mails?|inbox(?:es)?|gmail|mail)\b/i;
const MAIL_ACTION=/\b(?:draft|send|write|reply|respond|forward|delete|trash|unsubscribe|archive|label|quarantine)\b/i;
export const isMailQuery=text=>{const t=String(text).trim();return t.length<=200&&MAIL.test(t)&&!MAIL_ACTION.test(t)&&!/\b(?:about|regarding|from\s+(?!today|yesterday|this|the\s+last))\b/i.test(t)&&/\b(?:new|any|anything|check|summar\w*|catch\s+me\s+up|updates?|latest|recent|what(?:'?s|\s+is)\s+in|what\s+came\s+in|what\s+did\s+i\s+get|go\s+through)\b/i.test(t);};
export const mailAccount=text=>/\b(?:school|uchicago|u\s*chicago|college|university|student|uchi)\b/i.test(text)?'school':/\b(?:personal|private|gmail|my\s+own)\b/i.test(text)?'personal':null;
const who=s=>String(s).replace(/<[^>]*>/g,'').replace(/"/g,'').trim().slice(0,40)||String(s).slice(0,40);
async function mailFor(env,account,since){
  const where=account?'AND account=?':'',args=account?[since,account]:[since];
  const rows=await all(env,`SELECT sender,subject,level FROM mail_items WHERE received_at>? ${where} AND level IN ('call','notify','digest') ORDER BY CASE level WHEN 'call' THEN 0 WHEN 'notify' THEN 1 ELSE 2 END,received_at DESC LIMIT 40`,...args);
  const c=await env.DB.prepare(`SELECT COUNT(*) n,SUM(level='phishing') p FROM mail_items WHERE received_at>? ${where}`).bind(...args).first();
  return {rows,total:c?.n||0,phishing:c?.p||0};
}
const ACCOUNT_NAME={personal:'Personal',school:'UChicago'};
function mailLine(name,{rows,total,phishing}){
  const important=rows.filter(r=>r.level!=='digest'),other=rows.filter(r=>r.level==='digest');
  if(!total)return `${name}: nothing new.`;
  const bits=[];
  if(important.length)bits.push(`needs you: ${important.slice(0,6).map(r=>`${who(r.sender)} — ${r.subject}`).join('; ')}`);
  if(other.length)bits.push(`worth a look: ${other.slice(0,5).map(r=>`${who(r.sender)} — ${r.subject}`).join('; ')}${other.length>5?` (+${other.length-5} more)`:''}`);
  const rest=total-rows.length;
  return `${name}: ${bits.length?bits.join('. '):'nothing important'}${rest>0?`. ${rest} other${rest===1?'':'s'} filtered as noise`:''}${phishing?`, including ${phishing} likely phishing`:''}.`;
}
export async function mailAnswer(env,text,now=new Date()){
  const r=parseRange(text,now),account=mailAccount(text);
  const since=r.unspecified||r.error?now.getTime()-DAY:startOf(r.from),span=r.unspecified||r.error?'last 24 hours':r.label?r.label.toLowerCase():`since ${dayName(r.from)}`;
  const accounts=account?[account]:['personal','school'];
  const health=await all(env,"SELECT id,status FROM sources WHERE id IN ('gmail','uchicago')"),stale=id=>{const s=health.find(h=>h.id===id);return !s||s.status!=='ok';};
  const lines=[],sinceIso=new Date(since).toISOString();
  for(const a of accounts){
    const name=ACCOUNT_NAME[a],data=await mailFor(env,a,sinceIso);
    lines.push(stale(a==='school'?'uchicago':'gmail')&&!data.total?`${name}: not connected or not syncing right now.`:mailLine(name,data));
  }
  return `Email (${span}). ${lines.join(' ')}`;
}
