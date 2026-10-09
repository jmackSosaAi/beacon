// Finance alerts (M4). Verified Bank of America / American Express alert emails → charges (merchant, amount, date), parsed by code.
// No model ever sees these emails. Card and account digits never get stored or sent (DATA.md C4); only derived fields are kept.
import {clip,scrub,domainOf,verified} from './mail.js';
import {run,all,notify,isPaused,preferences,nowIso} from './service.js';
import {localParts,cleanText} from './core.js';

const ISSUERS={'Bank of America':['bankofamerica.com','ealerts.bankofamerica.com','bofa.com'],'American Express':['americanexpress.com','welcome.americanexpress.com','aexp.com']};
const under=(domain,base)=>domain===base||domain.endsWith('.'+base);
const CHARGE=/transaction|purchase|charge|card (was )?used|debit card|credit card/i;
// Payments to the card, statements, refunds, balances and declined attempts are not charges (declines fall back to normal triage).
const NOT_CHARGE=/declined|not approved|statement|payment (is )?(due|received|posted|scheduled)|thank you for your payment|autopay|minimum payment|balance|deposit|refund|credit (posted|issued)|reward/i;
// Any run of 4+ digits (spaces/dashes allowed) can be a card or account number: removed, never masked into storage.
export const stripDigits=value=>String(value??'').replace(/(?:\d[\s-]?){3,}\d/g,' ');
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const pad=n=>String(n).padStart(2,'0');
export const money=cents=>'$'+(cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
// Normalized merchant text: letters-only words, no alphanumeric reference codes or processor prefixes (SQ *, TST*, PAYPAL *).
const words=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(w=>w.length>=2&&!/\d/.test(w));
export const normalize=value=>{const w=words(value);while(w.length>1&&['sq','tst','sp','pp','paypal'].includes(w[0]))w.shift();return w.join(' ');};
export const merchantKey=value=>normalize(value).split(' ').slice(0,2).join(' ');
export const matchesPattern=(merchant,pattern)=>{const m=normalize(merchant);if(!m||!pattern)return false;return (' '+m+' ').includes(' '+pattern+' ')||(m.split(' ')[0].length>=4&&m.split(' ')[0]===pattern.split(' ')[0]);};

function chargeDate(text,fallback){
  let m=/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text),y,mo,d;
  if(m)[y,mo,d]=[+m[3],MONTHS.indexOf(m[1].toLowerCase())+1,+m[2]];
  else if((m=/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(text)))[y,mo,d]=[m[3].length===2?2000+ +m[3]:+m[3],+m[1],+m[2]];
  // Out-of-range or far-off dates fall back to the email's own date.
  if(!m||mo<1||mo>12||d<1||d>31||Math.abs(y-Number(fallback.slice(0,4)))>1)return fallback;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
function cleanMerchant(raw){
  const m=clip(scrub(stripDigits(String(raw??'').replace(/\bcard (ending|number)( in)?\b.*$/i,'')).replace(/[*#]+/g,' ')).replace(/\[(link|address|number)\]/g,' '),60).replace(/\s+/g,' ').trim().slice(0,40).trim();
  return /[a-z]{2}/i.test(m)&&normalize(m)?m:null;
}

// Returns {issuer, merchant, amount_cents, charged_on} for a verified card alert from a real issuer domain, else null.
export function chargeAlert(headers,snippet,receivedAt=nowIso()){
  const domain=domainOf(headers.from),issuer=Object.entries(ISSUERS).find(([,d])=>d.some(b=>under(domain,b)))?.[0];
  if(!issuer||!verified(headers,domain))return null;
  // Domain-looking merchants (AMAZON.COM) lose the TLD so nothing link-like reaches Telegram.
  const text=`${clip(headers.subject,300)}\n${clip(snippet,1000)}`.replace(/\b([a-z0-9-]+)\.(com|net|org|io|co|us)\b/gi,'$1');
  if(!CHARGE.test(text)||NOT_CHARGE.test(text))return null;
  const amount=/amount\s*:?\s*\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/i.exec(text)||/\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/.exec(text);
  const cents=amount?Math.round(Number(amount[1].replace(/,/g,''))*100):0;
  if(!(cents>0&&cents<10000000))return null;
  const labeled=/\b(?:merchant(?: name)?|where|description)\s*:\s*(.+?)(?=\s+(?:transaction date|date|amount|card(?: ending)?|account|time|on)\b|\s*[|;\n]|$)/i.exec(text);
  const at=/\bat\s+([a-z0-9][^,;.\n]*?)(?=\s+on\s+(?:[a-z]{3,9}\.?\s+\d|\d)|\s+(?:was|has been|for|with|using|from)\b|[,;.\n]|$)/i.exec(text);
  const merchant=cleanMerchant(labeled?.[1])||(at&&!/^\d{1,2}(:\d{2})?\s*(am|pm)?$|^least\b/i.test(at[1].trim())?cleanMerchant(at[1]):null);
  if(!merchant)return null;
  return {issuer,merchant,amount_cents:cents,charged_on:chargeDate(text,localParts(new Date(receivedAt)).date)};
}

// Stores a charge (once per email) and alerts only for a new merchant, an amount over preferences.chargeAlertMin (default $100),
// or a known subscription billed >5% off its imported amount. Paused: stored, no alert.
export async function recordCharge(env,id,c){
  const key=merchantKey(c.merchant),prefs=await preferences(env),min=Number.isFinite(prefs.chargeAlertMin)?prefs.chargeAlertMin:100;
  const seen=await env.DB.prepare('SELECT 1 x FROM charges WHERE merchant_key=? LIMIT 1').bind(key).first();
  const sub=(await all(env,'SELECT * FROM known_subscriptions')).find(s=>matchesPattern(c.merchant,s.pattern));
  const reasons=[];
  if(!seen&&!sub)reasons.push('New merchant.');
  if(c.amount_cents>min*100)reasons.push(`Over your ${money(min*100)} alert threshold.`);
  if(sub&&Math.abs(c.amount_cents-sub.amount_cents)>sub.amount_cents*0.05)reasons.push(`Price change: ${sub.name} was ${money(sub.amount_cents)}, now ${money(c.amount_cents)} (${c.amount_cents>sub.amount_cents?'+':''}${Math.round((c.amount_cents-sub.amount_cents)/sub.amount_cents*100)}%).`);
  const inserted=await run(env,'INSERT OR IGNORE INTO charges(id,issuer,merchant,merchant_key,amount_cents,charged_on,subscription,alert,created_at) VALUES(?,?,?,?,?,?,?,?,?)','gmail:'+id,c.issuer,c.merchant,key,c.amount_cents,c.charged_on,sub?.pattern||null,reasons.join(' ')||null,nowIso());
  if(!inserted.meta.changes)return {duplicate:true};
  // An annual subscription's charge sets next year's renewal date.
  if(sub?.cadence==='annual'&&(!sub.next_due||Date.parse(c.charged_on)>=Date.parse(sub.next_due)-30*86400000))await run(env,'UPDATE known_subscriptions SET next_due=?,updated_at=? WHERE pattern=?',`${Number(c.charged_on.slice(0,4))+1}${c.charged_on.slice(4)}`,nowIso(),sub.pattern);
  if(!reasons.length||await isPaused(env))return {alerted:false,reasons};
  await notify(env,{id:`charge:${id}`,kind:'finance',pointer:'💳 A card charge needs a look',title:`💳 ${money(c.amount_cents)} at ${c.merchant}`,body:`${reasons.join(' ')} ${c.charged_on}, ${c.issuer} alert (verified sender ✓).`});
  return {alerted:true,reasons};
}

// POST /api/import/subscriptions (admin key). {subscriptions:[{name,amount,cadence?,billing_day?,next_due?,pattern?}],replace?}
export async function importSubscriptions(env,input){
  const list=input?.subscriptions;if(!Array.isArray(list)||!list.length||list.length>100)throw new Error('1 to 100 subscriptions per import');
  const rows=new Map(),now=nowIso();
  for(const s of list){
    const name=clip(stripDigits(cleanText(s?.name,200)).replace(/[*_`#|]/g,' '),60),pattern=normalize(typeof s.pattern==='string'?stripDigits(s.pattern):name),amount=Number(s.amount),cadence=s.cadence??'monthly';
    if(!name||pattern.length<3||!(amount>0&&amount<100000)||!['monthly','annual'].includes(cadence))throw new Error('Each subscription needs a name, an amount and a monthly/annual cadence');
    const day=s.billing_day==null?null:Number(s.billing_day);if(day!==null&&!(Number.isInteger(day)&&day>=1&&day<=31))throw new Error('billing_day must be 1-31');
    if(s.next_due!=null&&!(/^\d{4}-\d{2}-\d{2}$/.test(s.next_due)&&Number.isFinite(Date.parse(s.next_due))))throw new Error('next_due must be YYYY-MM-DD');
    rows.set(pattern,[pattern,name,Math.round(amount*100),cadence,day,s.next_due??null,now]);
  }
  const statements=[...rows.values()].map(r=>env.DB.prepare('INSERT INTO known_subscriptions(pattern,name,amount_cents,cadence,billing_day,next_due,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(pattern) DO UPDATE SET name=excluded.name,amount_cents=excluded.amount_cents,cadence=excluded.cadence,billing_day=excluded.billing_day,next_due=COALESCE(excluded.next_due,known_subscriptions.next_due),updated_at=excluded.updated_at').bind(...r));
  // replace drops rows missing from the import, but only of the cadences it contains: a monthly import keeps annual entries.
  const cadences=[...new Set([...rows.values()].map(r=>r[3]))];
  if(input.replace===true)statements.push(env.DB.prepare(`DELETE FROM known_subscriptions WHERE cadence IN (${cadences.map(()=>'?').join(',')}) AND pattern NOT IN (${[...rows.keys()].map(()=>'?').join(',')})`).bind(...cadences,...rows.keys()));
  const results=await env.DB.batch(statements);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'subscriptions:imported',String(rows.size),now);
  return {imported:rows.size,removed:input.replace===true?results.at(-1).meta.changes:0};
}

const days=(from,to)=>Math.round((Date.parse(to)-Date.parse(from))/86400000);
// Scheduler: an annual renewal reminder up to 3 days ahead (once per renewal) and a total on the 1st of each month.
export async function financeNotices(env,at=new Date()){
  if(await isPaused(env))return;
  await coachNotices(env,at).catch(()=>console.error(JSON.stringify({event:'coach_failed'})));
  const subs=await all(env,'SELECT * FROM known_subscriptions ORDER BY name');if(!subs.length)return;
  const local=localParts(at),today=local.date;
  for(const s of subs.filter(s=>s.cadence==='annual'&&s.next_due)){
    let due=s.next_due;
    // A renewal date that passed without a matching charge rolls forward a year, so next year's reminder still fires.
    while(days(today,due)<0)due=`${Number(due.slice(0,4))+1}${due.slice(4)}`;
    if(due!==s.next_due)await run(env,'UPDATE known_subscriptions SET next_due=?,updated_at=? WHERE pattern=?',due,nowIso(),s.pattern);
    const left=days(today,due);
    if(left>=1&&left<=3)await notify(env,{id:`renewal:${s.pattern}:${due}`,kind:'finance',pointer:`🔁 A subscription renews ${left===1?'tomorrow':`in ${left} days`}`,title:`🔁 ${s.name} renews ${left===1?'tomorrow':`in ${left} days`}`,body:`Annual renewal on ${due}, about ${money(s.amount_cents)}. Cancel before then if you don't want it.`});
  }
  if(local.day==='01'){
    const monthly=subs.filter(s=>s.cadence==='monthly').reduce((a,s)=>a+s.amount_cents,0),annual=subs.filter(s=>s.cadence==='annual'),month=today.slice(0,7);
    const dueNow=annual.filter(s=>s.next_due?.startsWith(month)).map(s=>s.name);
    await notify(env,{id:`subscriptions:${month}`,kind:'finance',pointer:'🔁 Your monthly subscriptions summary is ready',title:'🔁 Subscriptions this month',body:`${subs.length} active, about ${money(monthly+Math.round(annual.reduce((a,s)=>a+s.amount_cents,0)/12))} a month (${money(monthly)} monthly${annual.length?` + annual ones spread over 12 months`:''}).${dueNow.length?` Annual renewals this month: ${dueNow.join(', ')}.`:''}`});
  }
}

// Spending coach (M4, Jackson's request). Code only: categories by merchant pattern, compared with his own history.
// Telegram/push get a pointer only (DATA.md C3); totals and comparisons stay in the web inbox. Dormant until charges arrive.
export const CATEGORIES=[
  ['Food delivery',/\b(uber ?eats|doordash|grubhub|postmates|caviar|instacart|seamless|gopuff)\b/],
  ['Gear',/\b(eberlestock|gbrs|opticsplanet|glockstore|gunbroker|tnvc|ferro|invader|trex|geissele|safariland|stone glacier|howitzer|grey ghost|cleared hot|paladin|micro ?center|javelin|tactical)\b/],
  ['Travel',/\b(southwest|united|delta|american air|jetblue|alaska air|spirit|frontier|hertz|avis|enterprise|expedia|booking|airbnb|marriott|hilton|hyatt|amtrak|clear)\b/],
  ['Rides',/\b(uber|lyft|bolt|divvy|parkmobile|ventra)\b/],
  ['Dining',/\b(restaurant|cafe|coffee|starbucks|chipotle|sweetgreen|pizza|grill|kitchen|bar|tavern|diner|taco|sushi|bakery)\b/],
  ['Groceries',/\b(whole foods|trader joe|jewel|mariano|target|walmart|costco|aldi|kroger)\b/],
  ['Shopping',/\b(amazon|amzn|apple|best buy|nike|lululemon|grailed|dhgate)\b/],
];
export const categoryOf=(merchant,isSub)=>{if(isSub)return 'Subscriptions';const m=' '+normalize(merchant)+' ';for(const [name,re] of CATEGORIES)if(re.test(m))return name;return 'Other';};
// Weeks run Monday–Sunday, so the Sunday-evening summary covers the week that's ending.
const weekStart=date=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);};
// {current:{cat:cents}, avg:{cat:cents}, weeks} for the week containing `today`, against the previous 8 weeks.
export async function weeklySpend(env,today){
  const start=weekStart(today),from=new Date(Date.parse(start+'T12:00:00Z')-56*86400000).toISOString().slice(0,10);
  const rows=await all(env,'SELECT merchant,amount_cents,charged_on,subscription FROM charges WHERE charged_on>=? AND charged_on<=?',from,today);
  const current={},past={},weeks=new Set();
  for(const r of rows){const cat=categoryOf(r.merchant,!!r.subscription),w=weekStart(r.charged_on);if(w===start)current[cat]=(current[cat]||0)+r.amount_cents;else{past[cat]=(past[cat]||0)+r.amount_cents;weeks.add(w);}}
  const n=Math.max(weeks.size,1),avg=Object.fromEntries(Object.entries(past).map(([k,v])=>[k,Math.round(v/n)]));
  return {start,current,avg,weeks:weeks.size};
}
export async function coachNotices(env,at=new Date()){
  if(await isPaused(env))return;
  const local=localParts(at),today=local.date,{start,current,avg,weeks}=await weeklySpend(env,today);
  // Hot category: needs 3+ weeks of history, at least 1.5x the usual and $40 over it. Once per category per week.
  if(weeks>=3)for(const [cat,cents] of Object.entries(current)){
    const usual=avg[cat]||0;if(cents>=Math.max(usual*1.5,usual+4000)){
      await notify(env,{id:`coach:hot:${cat}:${start}`,kind:'finance',pointer:`🔥 ${cat} is running hot this week`,title:`🔥 ${cat}: ${money(cents)} this week`,body:`Your usual week is about ${money(usual)} (last ${weeks} weeks). Week started ${start}.`});
    }
  }
  // Sunday evening: the week by category against his usual week.
  if(local.weekday==='Sun'&&Number(local.hour)>=18&&Object.keys(current).length){
    const cats=[...new Set([...Object.keys(current),...Object.keys(avg)])].sort((a,b)=>(current[b]||0)-(current[a]||0));
    const total=Object.values(current).reduce((a,b)=>a+b,0),usual=Object.values(avg).reduce((a,b)=>a+b,0);
    await notify(env,{id:`coach:week:${start}`,kind:'finance',pointer:'💳 Your weekly spending summary is ready',title:`💳 This week: ${money(total)}${weeks?` (usual ${money(usual)})`:''}`,
      body:cats.map(c=>`${c}: ${money(current[c]||0)}${weeks?` vs ${money(avg[c]||0)} usual`:''}`).join('; ')+'.'});
  }
  // 1st of the month: last month by category against the 3 months before it.
  if(local.day==='01'){
    const m=today.slice(0,7),d=new Date(m+'-01T12:00:00Z'),ago=k=>{const x=new Date(d);x.setUTCMonth(x.getUTCMonth()-k);return x.toISOString().slice(0,7);};
    const rows=await all(env,'SELECT merchant,amount_cents,charged_on,subscription FROM charges WHERE charged_on>=? AND charged_on<?',ago(4)+'-01',m+'-01');
    const last={},prior={};for(const r of rows){const c=categoryOf(r.merchant,!!r.subscription),bucket=r.charged_on.slice(0,7)===ago(1)?last:prior;bucket[c]=(bucket[c]||0)+r.amount_cents;}
    if(Object.keys(last).length)await notify(env,{id:`coach:month:${ago(1)}`,kind:'finance',pointer:'📈 Your monthly spending trend is ready',title:`📈 ${ago(1)}: ${money(Object.values(last).reduce((a,b)=>a+b,0))}`,
      body:Object.keys(last).sort((a,b)=>last[b]-last[a]).map(c=>`${c}: ${money(last[c])} (3-month avg ${money(Math.round((prior[c]||0)/3))})`).join('; ')+'.'});
  }
}
