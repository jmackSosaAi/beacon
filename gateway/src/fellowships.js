// Fellowship + DC trek watch (M5). Wednesdays from 9:00 Chicago, one page per scheduler tick. A page "changes" when its
// deadline/application sentences change; the first check is a silent baseline. Page text is untrusted: no model reads it,
// Telegram gets the name, dates found by regex and a defanged link.
import {run,all,nowIso,isPaused} from './service.js';
import {sendTelegram} from './tgapi.js';
import {localParts} from './core.js';
import {hash} from './auth.js';
import {plainLink} from './scout.js';
import {clip,scrub,INJECTION} from './mail.js';

export const PAGES=[
  // ccrf.uchicago.edu sits behind a Cloudflare bot challenge (403 to any script), so CCRF is watched through the events calendar below.
  {id:'truman',name:'Truman Scholarship',url:'https://www.truman.gov/apply'},
  {id:'rhodes',name:'Rhodes Scholarship',url:'https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/'},
  {id:'marshall',name:'Marshall Scholarship',url:'https://www.marshallscholarship.org/'},
  {id:'fulbright',name:'Fulbright US Student Program',url:'https://us.fulbrightonline.org/'},
  {id:'boren',name:'Boren Scholarship',url:'https://www.borenawards.org/'},
  {id:'cls',name:'Critical Language Scholarship',url:'https://clscholarship.org/'},
  {id:'smart',name:'DoD SMART Scholarship',url:'https://www.smartscholarship.org/smart'},
  {id:'treks',name:'UChicago Career Advancement treks',url:'https://careeradvancement.uchicago.edu/student-opportunities/experiential-programs/treks/',trek:true},
];
const MONTH='(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE=new RegExp(`\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{4}\\b`,'gi');
export const pageText=html=>String(html).slice(0,400000).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,'\n').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').trim();
// Only the sentences that matter (deadlines, applications, eligibility) are compared, so menus and news widgets don't trigger alerts.
export function keySentences(text){return text.split(/\n+|(?<=[.!?])\s+/).filter(s=>/deadline|appl(y|ication)|due|eligib|open|clos|nominat|campus/i.test(s)&&s.length<400).slice(0,80);}
export const datesIn=text=>[...new Set((text.match(DATE)||[]).map(d=>d.replace(/\s+/g,' ')))].slice(0,6);
export const dcTrekOpen=raw=>{const text=String(raw).replace(/\bD\.\s?C\./g,'DC');return /\b(?:D\.?C\.?|Washington)\b[^.]{0,120}\b(?:applications?|apply)\b[^.]{0,60}\b(?:open|now|due|deadline)\b|\b(?:applications?|apply)\b[^.]{0,60}\bopen\b[^.]{0,120}\b(?:D\.?C\.?|Washington)\b/i.test(text);};

export async function checkPage(env,page,html,status){
  const prev=await env.DB.prepare('SELECT * FROM watch_pages WHERE id=?').bind(page.id).first(),now=nowIso();
  if(!html){await run(env,'INSERT INTO watch_pages(id,status,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at',page.id,String(status),now);return {id:page.id,status};}
  const text=pageText(html),keys=keySentences(text),h=await hash(keys.join('\n')),dates=datesIn(keys.join(' '));
  const changed=!!prev?.hash&&prev.hash!==h;
  await run(env,'INSERT INTO watch_pages(id,hash,dates,status,checked_at,changed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,dates=excluded.dates,status=excluded.status,checked_at=excluded.checked_at,changed_at=CASE WHEN watch_pages.hash IS NOT NULL AND watch_pages.hash<>excluded.hash THEN excluded.changed_at ELSE watch_pages.changed_at END',page.id,h,JSON.stringify(dates),'ok',now,changed?now:null);
  if(changed)await sendTelegram(env,`📜 ${page.name}: the application/deadline info changed.${dates.length?` Dates on the page: ${dates.join(', ')}.`:''}\n${plainLink(page.url)}\n(Page text is unverified; check the site.)`)?.catch?.(()=>null);
  if(page.trek&&dcTrekOpen(text)&&!prev?.flagged){await run(env,"UPDATE watch_pages SET flagged='dc-trek' WHERE id=?",page.id);await sendTelegram(env,`🏛 The DC trek application looks open on Career Advancement.\n${plainLink(page.url)}\nCheck the page and apply yourself.`)?.catch?.(()=>null);}
  return {id:page.id,changed,dates};
}
// Called each scheduler tick: Wednesdays from 9:00, the next page not checked in 6 days (one fetch per tick).
export async function watchTick(env,at=new Date()){
  const local=localParts(at);if(local.weekday!=='Wed'||Number(local.hour)<9||await isPaused(env))return null;
  const seen=Object.fromEntries((await all(env,'SELECT id,checked_at FROM watch_pages')).map(r=>[r.id,r.checked_at]));
  const page=PAGES.find(p=>!seen[p.id]||Date.parse(seen[p.id])<at.getTime()-6*86400000);if(!page)return null;
  let html=null,status='error';
  try{const r=await fetch(page.url,{headers:{'User-Agent':'Mozilla/5.0 (Beacon personal page watch)'},redirect:'follow',signal:AbortSignal.timeout(15000)});status=r.status;if(r.ok&&/text\/html/i.test(r.headers.get('content-type')||'text/html'))html=await r.text();}catch{}
  return checkPage(env,page,html,status);
}

// UChicago events calendar (LiveWhale public JSON): CCRF and fellowship sessions and deadlines. Daily from 9:00, one search per tick.
// New events (by id) go to Telegram as one digest; the first run for a search is a silent baseline. Titles are untrusted (scrubbed).
export const EVENT_SEARCHES=['CCRF','fellowship','scholarship'];
const EVENTS='https://events.uchicago.edu/live/json/events/search/';
export function newEvents(data){return (data?.data||[]).filter(e=>Number.isInteger(e.id)&&typeof e.title==='string'&&!INJECTION.test(e.title)).map(e=>({id:e.id,title:clip(scrub(clip(e.title,200)),100),when:clip(String(e.date||e.date_utc||''),40),url:/^https:\/\/events\.uchicago\.edu\/event\/[\w-]+$/.test(e.url||'')?e.url:null}));}
export async function eventsTick(env,at=new Date()){
  const local=localParts(at);if(Number(local.hour)<9||await isPaused(env))return null;
  for(const term of EVENT_SEARCHES){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`events:${term}:${local.date}`,nowIso());if(!first.meta.changes)continue;
    let data=null;try{const r=await fetch(EVENTS+encodeURIComponent(term)+'/',{headers:{'User-Agent':'Mozilla/5.0 (Beacon personal calendar watch)'},signal:AbortSignal.timeout(15000)});if(r.ok)data=await r.json();}catch{}
    if(!data)return {term,ok:false};
    const baseline=!(await env.DB.prepare('SELECT 1 FROM dedupe WHERE id=?').bind(`events-base:${term}`).first()),fresh=[];
    for(const e of newEvents(data)){const n=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`evt:${e.id}`,nowIso());if(n.meta.changes&&!baseline)fresh.push(e);}
    if(baseline)await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`events-base:${term}`,nowIso());
    if(fresh.length)await sendTelegram(env,`🎓 New UChicago ${term} events\n${fresh.slice(0,10).map(e=>`• ${e.title} — ${e.when}${e.url?`\n  ${plainLink(e.url)}`:''}`).join('\n')}\n(From the public events calendar; full links in the calendar itself.)`)?.catch?.(()=>null);
    return {term,baseline,fresh:fresh.length};
  }
  return null;
}
