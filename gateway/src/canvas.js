// Canvas calendar feed (CANVAS_ICS_URL secret, read-only .ics): assignments and exams become school tasks with due dates.
// Titles come from course staff, so they're stored as task data (untrusted in model context), never as instructions.
import {capture,source} from './service.js';

const unfold=text=>String(text).replace(/\r?\n[ \t]/g,'');
const unescape=v=>String(v||'').replace(/\\n/gi,' ').replace(/\\([,;\\])/g,'$1').trim();
// Date-only due dates mean end of that day in Chicago (11:59pm, CDT or CST).
function chicagoEndOfDay(ymd){
  const [y,m,d]=[ymd.slice(0,4),ymd.slice(4,6),ymd.slice(6,8)].map(Number);
  for(const off of [5,6]){const t=new Date(Date.UTC(y,m-1,d,23+off,59));const hour=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',hourCycle:'h23'}).format(t);if(Number(hour)===23)return t.toISOString();}
  return new Date(Date.UTC(y,m-1,d,23+5,59)).toISOString();
}
export function parseIcs(text){
  const events=[];
  for(const block of unfold(text).split('BEGIN:VEVENT').slice(1)){
    const body=block.split('END:VEVENT')[0],field=name=>{const m=new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`,'m').exec(body);return m?m[1].trim():'';};
    const start=field('DTSTART'),uid=field('UID'),summary=unescape(field('SUMMARY'));
    if(!uid||!summary||!/^\d{8}/.test(start))continue;
    const due=/^\d{8}$/.test(start)?chicagoEndOfDay(start):/^\d{8}T\d{6}Z$/.test(start)?`${start.slice(0,4)}-${start.slice(4,6)}-${start.slice(6,8)}T${start.slice(9,11)}:${start.slice(11,13)}:${start.slice(13,15)}Z`:null;
    const course=/\[([^\]]+)\]\s*$/.exec(summary)?.[1]||'',title=summary.replace(/\s*\[[^\]]+\]\s*$/,'');
    events.push({uid,title,course,due,assignment:/^event-assignment-/.test(uid)});
  }
  return events;
}
// Assignments always; other calendar events only when they look like an exam or a deadline. Class meetings are skipped.
const KEEP=/\b(exam|midterm|final|quiz|test|due|deadline|presentation)\b/i;
export async function syncCanvas(env,now=new Date()){
  if(!env.CANVAS_ICS_URL)return {skipped:true};
  try{
    const r=await fetch(env.CANVAS_ICS_URL,{headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) jarvis-calendar/1.0','Accept':'text/calendar,*/*'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`canvas-${r.status}`);
    const text=await r.text();if(text.length>3000000)throw new Error('canvas-too-large');
    const cutoff=now.getTime()-14*86400000;let n=0;
    for(const e of parseIcs(text)){
      if(!e.due||Date.parse(e.due)<cutoff||!(e.assignment||KEEP.test(e.title)))continue;
      await capture(env,{id:'canvas:'+e.uid.slice(0,140),title:`${e.title}${e.course?` (${e.course.slice(0,60)})`:''}`.slice(0,500),notes:e.course?`Canvas: ${e.course}`:'Canvas',category:/persian|pers\b/i.test(e.course)?'persian':'school',due_at:e.due,confidence:'verified'},'canvas');n++;
    }
    await source(env,'canvas','ok',`Canvas calendar feed: ${n} assignments and exams synced.`);
    return {synced:n};
  }catch(e){await source(env,'canvas','error','Canvas feed check failed; last synced assignments kept.');return {error:String(e.message).slice(0,60)};}
}
