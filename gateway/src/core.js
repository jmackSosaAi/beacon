export const TIMEZONE = 'America/Chicago';
export const STATES = ['started', 'partial', 'done', 'stuck', 'skipped'];
export function localParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {...parts, date:`${parts.year}-${parts.month}-${parts.day}`, time:`${parts.hour}:${parts.minute}`};
}
export function isQuiet(now, prefs) {
  const hour = Number(localParts(now).hour);
  return prefs.quietStart > prefs.quietEnd ? hour >= prefs.quietStart || hour < prefs.quietEnd : hour >= prefs.quietStart && hour < prefs.quietEnd;
}
export function scheduleNotices(block, now = new Date()) {
  if (!block.active || ['done','skipped'].includes(block.status)) return [];
  const time = now.getTime(), start = Date.parse(block.start_at), end = Date.parse(block.end_at);
  const notices = [];
  if (time >= start - 10*60000 && time < start && block.status === 'unknown') notices.push({kind:'start',title:'Starting soon',body:block.title});
  if (time >= end && time < end + 10*60000 && ['unknown','started'].includes(block.status)) notices.push({kind:'finish',title:'How did it go?',body:`${block.title}: done, partly done, skipped, or stuck?`});
  if (time >= end + 30*60000 && time < end + 40*60000 && ['unknown','started'].includes(block.status)) notices.push({kind:'followup',title:'One quick check-in',body:`Still need your update on ${block.title}. No reply means unknown; your calendar stays unchanged.`});
  return notices.map(n=>({...n,id:`${n.kind}:${block.id}:${block.start_at}`,block_id:block.id}));
}
export function classifyMail({subject='',sender='',body='',isReply=false}={}) {
  const text = `${subject}\n${body}`;
  // Important automated updates take precedence over bulk/no-reply heuristics.
  if (/interview|assessment|application (status|received|update)|offer letter|deadline|due date|assignment.{0,30}(changed|updated)|trek.{0,30}application/i.test(text)) return 'notify';
  if (isReply || /@uchicago\.edu\b/i.test(sender)) return 'notify';
  if (/unsubscribe|newsletter|marketing/i.test(text)) return 'ignore';
  return 'digest';
}
export function cleanText(value, max=4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text');
  return value.trim();
}
export function validInstant(value) {
  return typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}
export function blockCategory(title) { return /Persian/i.test(title)?'persian':/^Career/.test(title)?'career':'school'; }
// Full-calendar categories (events table, M7): course titles → class, Career blocks → work, everything else personal.
const COURSE=/^Class work — |\b[A-Z]{4} \d{5}\b|\b(?:class|lecture|seminar|section|lab|office hours|discussion|recitation|exam|midterm|quiz|pset|problem set|homework)\b/i;
export function eventCategory(title) { const t=String(title||''); return /^Career — /.test(t)?'work':COURSE.test(t)?'class':'personal'; }
// Midnight at the start of a Chicago calendar date ("2026-10-07") as an ISO instant; the offset is checked twice so DST days come out right.
const offsetMin=ms=>{const s=new Intl.DateTimeFormat('en-US',{timeZone:TIMEZONE,timeZoneName:'shortOffset'}).format(new Date(ms)).split('GMT')[1]||'0';const [h,m='0']=s.split(':');return (+h)*60+Math.sign(+h||1)*(+m);};
export function dayStart(ymd) { const [y,m,d]=String(ymd).split('-').map(Number); const g=Date.UTC(y,m-1,d); return new Date(g-offsetMin(g-offsetMin(g)*60000)*60000).toISOString(); }
// A planner-written time as epoch ms: with a Z/±hh:mm offset it is taken as is; a date-only or offset-less value is Chicago
// local (Date.parse would read it as UTC, 5–6 hours early). NaN when unreadable.
const LOCAL=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
export function localInstant(value) {
  const s=String(value??'').trim(),m=LOCAL.exec(s);
  if(!m)return /(?:Z|[+-]\d\d:?\d\d)$/.test(s)?Date.parse(s):NaN;
  const g=Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0));
  return Number.isFinite(g)?g-offsetMin(g-offsetMin(g)*60000)*60000:NaN;
}
export function safeUrl(value) { if (!value) return null; const u = new URL(value); if (!['https:','http:'].includes(u.protocol)) throw new Error('Invalid link'); return u.href; }
export function validateSubscription(sub) {
  if (!sub || !sub.keys || typeof sub.keys.auth !== 'string' || typeof sub.keys.p256dh !== 'string') return false;
  try { const u = new URL(sub.endpoint); return u.protocol==='https:' && !u.username && !u.password && (!u.port || u.port==='443') && ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].some(h=>u.hostname===h || u.hostname.endsWith('.'+h)); } catch { return false; }
}
