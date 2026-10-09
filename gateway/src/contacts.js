import {all,run,nowIso,isPaused} from './service.js';
import {hash,randomToken,validateTwilio} from './auth.js';
import {sendTelegram} from './tgapi.js';
import {saveGmailDraft} from './gmaildraft.js';
// Contacts are the only source of call and draft recipients (SAFETY.md "Contacts"). Model output never supplies a number or address.
// US numbers only (Twilio geo permissions are US-only); stored as E.164.
export function normalizePhone(value){if(value==null||value==='')return null;const d=String(value).replace(/[^\d]/g,'');const n=d.length===10?'1'+d:d;return /^1[2-9]\d{2}[2-9]\d{6}$/.test(n)&&!/[^\d\s().+-]/.test(String(value))?'+'+n:undefined;}
export function normalizeEmail(value){if(value==null||value==='')return null;const e=String(value).trim().toLowerCase();return e.length<=120&&/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)?e:undefined;}
export const maskPhone=phone=>phone?`(•••) •••-${phone.slice(-4)}`:'no number';
export const TRUSTED_ORIGINS=['web','telegram','voice'];
export const contactList=env=>all(env,'SELECT id,name,phone,email FROM contacts ORDER BY name LIMIT 200');
export async function addContact(env,c,origin){
  if(!TRUSTED_ORIGINS.includes(origin))throw new Error('Contacts can only be added from your own messages');
  if(await env.DB.prepare('SELECT id FROM contacts WHERE name=?').bind(c.name).first())throw new Error('A contact with that name already exists');
  const id='c'+crypto.randomUUID().replaceAll('-','').slice(0,10);
  await run(env,'INSERT INTO contacts(id,name,phone,email,notes,created_at,origin) VALUES(?,?,?,?,?,?,?)',id,c.name,c.phone,c.email,c.notes,nowIso(),origin);
  return {id,name:c.name};
}
// Web app only, behind step-up (index.js). Edits are audited by contact id; numbers stay out of the audit.
export async function saveContact(env,input){
  const name=String(input?.name||'').trim().replace(/\s+/g,' ').slice(0,80),phone=normalizePhone(input?.phone),email=normalizeEmail(input?.email);
  if(!name||phone===undefined||email===undefined||(!phone&&!email))throw new Error('Name plus a valid US phone or email required');
  const notes=String(input?.notes||'').slice(0,300);
  if(input?.id){const r=await run(env,'UPDATE contacts SET name=?,phone=?,email=?,notes=? WHERE id=?',name,phone,email,notes,String(input.id).slice(0,40));if(!r.meta.changes)throw new Error('missing');await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'contact:edited:web',String(input.id).slice(0,40),nowIso());return {id:input.id,name};}
  const c=await addContact(env,{name,phone,email,notes},'web');await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'contact:added:web',c.id,nowIso());return c;
}
export async function deleteContact(env,id){
  const r=await run(env,'DELETE FROM contacts WHERE id=?',id);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'contact:deleted:web',id,nowIso());return {deleted:r.meta.changes};
}
export async function contactNames(env){const rows=await all(env,'SELECT name FROM contacts ORDER BY name LIMIT 200');return rows.length?`📇 Contacts (${rows.length})\n${rows.map(r=>`• ${r.name}`).join('\n')}`:'No contacts saved yet. Tell me "add a contact: <name>, <number or email>" and approve the card.';}
// Draft tier: Beacon writes the email into Jackson's Gmail Drafts; he reviews and presses Send himself.
// Recipient comes from the contacts table only. Falls back to paste-ready Telegram text if Gmail drafts aren't authorized.
export const DRAFTS_PER_DAY=10,EDITS_PER_DAY=40,EDIT_WINDOW_MS=3*3600000;
const line=c=>c.email?`${c.name} <${c.email}>`:`${c.name} (no email saved)`;
const draftText=(r,d)=>`To: ${line(r.to)}${r.cc.length?`\nCc: ${r.cc.map(line).join(', ')}`:''}${r.bcc.length?`\nBcc: ${r.bcc.map(line).join(', ')}`:''}\nSubject: ${d.subject}\n\n${d.body}`;
async function countToday(env,action){return (await env.DB.prepare('SELECT COUNT(*) n FROM audit WHERE action=? AND created_at>?').bind(action,new Date(Date.now()-86400000).toISOString()).first()).n;}
export const draftsCapped=async env=>await countToday(env,'draft:created')>=DRAFTS_PER_DAY;
// cc/bcc are stored as JSON arrays of contact ids (migration 0029); addresses are read from the contacts rows at write time.
const ids=v=>{try{const a=typeof v==='string'?JSON.parse(v||'[]'):v;return Array.isArray(a)?a.map(String).slice(0,5):[];}catch{return [];}};
async function recipients(env,d){
  const want=[d.contact_id,...ids(d.cc),...ids(d.bcc)],rows=await all(env,`SELECT id,name,email FROM contacts WHERE id IN (${want.map(()=>'?').join(',')})`,...want),by=Object.fromEntries(rows.map(c=>[c.id,c]));
  return {to:by[d.contact_id]||null,cc:ids(d.cc).map(id=>by[id]).filter(c=>c?.email),bcc:ids(d.bcc).map(id=>by[id]).filter(c=>c?.email)};
}
const addr=c=>({name:c.name,address:c.email});
async function writeGmail(env,r,d,gmailDraftId,account='personal'){
  if(!r.to?.email)return {gmail:false,reason:'no-email'};
  try{return {gmail:true,id:await saveGmailDraft(env,{gmailDraftId,to:[addr(r.to)],cc:r.cc.map(addr),bcc:r.bcc.map(addr),subject:d.subject,body:d.body,inReplyTo:d.in_reply_to||null,references:d.refs||'',threadId:d.thread_id||null,account})};}
  catch(e){return {gmail:false,reason:['scope','school-scope'].includes(e.message)?e.message:'error'};}
}
// draft: {contact_id,subject,body,account,cc?,bcc?,thread_id?,in_reply_to?,refs?} from the registry; thread fields only on replies.
export async function sendDraft(env,draft){
  if(await isPaused(env))throw new Error('paused');
  if(await draftsCapped(env))throw new Error('cap');
  const r=await recipients(env,draft),c=r.to;if(!c)throw new Error('missing');
  const account=draft.account==='school'?'school':'personal',g=await writeGmail(env,r,draft,null,account),id=crypto.randomUUID(),now=nowIso();
  await run(env,'INSERT INTO drafts(id,gmail_draft_id,contact_id,subject,body,created_at,updated_at,account,cc,bcc,thread_id,in_reply_to,refs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,g.gmail?g.id:null,c.id,draft.subject,draft.body,now,now,account,JSON.stringify(r.cc.map(x=>x.id)),JSON.stringify(r.bcc.map(x=>x.id)),draft.thread_id||null,draft.in_reply_to||null,draft.refs||null);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'draft:created',c.id,now);
  if(!g.gmail)await sendTelegram(env,`✉️ Draft (copy and send it yourself${g.reason==='school-scope'?'; connect your UChicago Google account in Beacon to get school drafts into it':g.reason==='scope'?'; reconnect Google in Beacon to get drafts straight into Gmail':''})\n${draftText(r,draft)}`)?.catch?.(()=>null);
  return {name:c.name,gmail:g.gmail,reason:g.reason,subject:draft.subject,body:draft.body,account,cc:r.cc.map(x=>x.name),bcc:r.bcc.map(x=>x.name),in_thread:!!draft.in_reply_to};
}
// The draft Jackson is currently working on: the most recent one, if touched in the last few hours.
export async function currentDraft(env){return env.DB.prepare('SELECT d.*,c.name,c.email FROM drafts d JOIN contacts c ON c.id=d.contact_id WHERE d.updated_at>? ORDER BY d.updated_at DESC LIMIT 1').bind(new Date(Date.now()-EDIT_WINDOW_MS).toISOString()).first();}
export async function editDraft(env,edit){
  if(await isPaused(env))throw new Error('paused');
  if(await countToday(env,'draft:edited')>=EDITS_PER_DAY)throw new Error('cap');
  const d=await currentDraft(env);if(!d||d.id!==edit.draft_id)throw new Error('missing');
  // A PUT replaces the whole message, so cc/bcc and the thread headers are re-sent with the edit.
  const next={subject:edit.subject||d.subject,body:edit.body,thread_id:d.thread_id,in_reply_to:d.in_reply_to,refs:d.refs},r={...await recipients(env,d),to:{name:d.name,email:d.email}};
  const g=await writeGmail(env,r,next,d.gmail_draft_id,d.account||'personal');
  await run(env,'UPDATE drafts SET subject=?,body=?,gmail_draft_id=COALESCE(?,gmail_draft_id),updated_at=? WHERE id=?',next.subject,next.body,g.gmail?g.id:null,nowIso(),d.id);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'draft:edited',d.contact_id,nowIso());
  if(!g.gmail)await sendTelegram(env,`✉️ Updated draft (copy and send it yourself)\n${draftText(r,next)}`)?.catch?.(()=>null);
  return {name:d.name,gmail:g.gmail,subject:next.subject,body:next.body,account:d.account||'personal'};
}
// Confirm tier: Twilio rings Jackson's own phone; the TwiML then dials the contact's number from the table. Never recorded.
export const CALLS_PER_HOUR=5;
const BASE='https://your-worker.example.workers.dev';
export async function placeBridgeCall(env,contactId,proposalId){
  if(!(env.TWILIO_SID&&env.TWILIO_TOKEN&&env.OWNER_NUMBER&&env.TWILIO_NUMBER))throw new Error('Call bridging is not set up (Twilio secrets missing)');
  if(await isPaused(env))throw new Error('Beacon is paused. Resume in the web app first');
  const c=await env.DB.prepare('SELECT id,phone FROM contacts WHERE id=?').bind(contactId).first();if(!c?.phone)throw new Error('That contact has no saved number');
  const recent=await env.DB.prepare('SELECT COUNT(*) n FROM bridge_calls WHERE created_at>?').bind(new Date(Date.now()-3600000).toISOString()).first();
  if(recent.n>=CALLS_PER_HOUR){await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'call:bridge:capped',c.id,nowIso());throw new Error(`Limit of ${CALLS_PER_HOUR} bridged calls an hour reached`);}
  const token=randomToken(),now=nowIso();
  await run(env,'INSERT INTO bridge_calls(token_hash,contact_id,proposal_id,created_at,expires_at) VALUES(?,?,?,?,?)',await hash(token),c.id,proposalId,now,new Date(Date.now()+10*60000).toISOString());
  const url=new URL('/voice/bridge',env.PUBLIC_URL||BASE);url.searchParams.set('t',token);
  const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Calls.json`,{method:'POST',headers:{Authorization:'Basic '+btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)},
    body:new URLSearchParams({To:env.OWNER_NUMBER,From:env.TWILIO_NUMBER,Url:url.href,Method:'POST',MachineDetection:'Enable',Timeout:'25'}),signal:AbortSignal.timeout(15000)});
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`call:bridge:${r.ok?'placed':'failed'}`,c.id,nowIso());
  if(!r.ok){console.error(JSON.stringify({event:'bridge_call_failed',status:r.status}));throw new Error('Twilio did not place the call');}
  return {called:true};
}
const xml=s=>String(s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
const twiml=body=>new Response(`<Response>${body}</Response>`,{headers:{'content-type':'text/xml'}});
// Twilio fetches this once, on Jackson's answered leg. Voicemail, a reused token or a paused Beacon gets a hang-up and nothing is dialed.
export async function bridgeTwiml(request,env){
  const form=Object.fromEntries(await request.formData());
  if(!await validateTwilio(request,env,form))return new Response('Forbidden',{status:403});
  if(String(form.AnsweredBy||'').startsWith('machine')||form.AnsweredBy==='fax')return twiml('<Hangup/>');
  const token=new URL(request.url).searchParams.get('t')||'',now=nowIso(),th=await hash(token);
  const claim=await run(env,'UPDATE bridge_calls SET used_at=?,call_sid=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?',now,String(form.CallSid||'').slice(0,64),th,now);
  if(!claim.meta.changes)return twiml('<Hangup/>');
  if(await isPaused(env))return twiml('<Say>Beacon is paused. Nothing was dialed.</Say><Hangup/>');
  const c=await env.DB.prepare('SELECT c.name,c.phone FROM bridge_calls b JOIN contacts c ON c.id=b.contact_id WHERE b.token_hash=?').bind(th).first();
  if(!c?.phone||!env.TWILIO_NUMBER)return twiml('<Hangup/>');
  return twiml(`<Say>Connecting you to ${xml(c.name)}.</Say><Dial timeLimit="3600" callerId="${xml(env.TWILIO_NUMBER)}" record="do-not-record"><Number>${xml(c.phone)}</Number></Dial>`);
}
