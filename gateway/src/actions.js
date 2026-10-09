// The action chokepoint (SAFETY.md "Enforcement in code"): every action type Beacon knows, with its tier,
// strict validation, the code-generated read-back, a per-day limit, and (for proposals) how it executes.
// conversation.js validates, proposes and executes only through this registry; the model never writes read-backs.
import {capture,checkin,nowIso} from './service.js';
import {validateMeal,logMeal} from './meals.js';
import {cleanText,STATES,validInstant} from './core.js';
import {normalizePhone,normalizeEmail,maskPhone,addContact,placeBridgeCall,sendDraft,draftsCapped,TRUSTED_ORIGINS,DRAFTS_PER_DAY} from './contacts.js';
import {queueJob,queuedReply} from './node.js';
import {CALENDAR_ACTIONS} from './calendar.js';
import {MESSAGE_ID,THREAD_ID} from './gmaildraft.js';
import {validateReminder,renderReminder,scheduleReminder} from './reminders.js';

const when=iso=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'});
const contactOf=(action,context)=>typeof action.contact_id==='string'?(context.contacts||[]).find(c=>c.id===action.contact_id):null;
const CONTACT_ID=/^c[0-9a-f]{10}$/,GMAIL_ID=/^[A-Za-z0-9_-]{1,64}$/,acct=a=>a.account==='school'?'UChicago':'personal';
// cc/bcc (M7 draft_email): every id must be a saved contact with an email; the To contact and duplicates are dropped; any unknown id → null.
const ccList=(list,c,skip)=>{if(list==null)return [];if(!Array.isArray(list)||list.length>5)return null;const out=[];for(const id of list){if(typeof id!=='string'||!CONTACT_ID.test(id)||!(c.contacts||[]).find(x=>x.id===id)?.email)return null;if(!skip.includes(id)&&!out.includes(id))out.push(id);}return out;};
const namesOf=(ids,c)=>ids.map(id=>(c.contacts||[]).find(x=>x.id===id).name);
// In-thread replies: ids are code-set from the stored message (agent.js draft_email) and reach validate only through
// vetAction({thread:true}); the single-shot model's draft has them stripped first. Absent → a fresh thread.
const thread=a=>a.in_reply_to==null?{thread_id:null,in_reply_to:null,refs:null}:typeof a.in_reply_to==='string'&&MESSAGE_ID.test(a.in_reply_to)&&(a.thread_id==null||THREAD_ID.test(String(a.thread_id)))?{thread_id:a.thread_id||null,in_reply_to:a.in_reply_to,refs:String(a.refs||'').split(/\s+/).filter(x=>MESSAGE_ID.test(x)).slice(-20).join(' ')||null}:null;
// Shared by draft, draft_confirm and contact_and_draft: ≤4 cc+bcc, all saved contacts, thread fields validated, text cleaned.
function draftFields(a,c,skip){const cc=ccList(a.cc,c,skip),bcc=ccList(a.bcc,c,[...skip,...(cc||[])]),t=thread(a);if(!cc||!bcc||!t||cc.length+bcc.length>4)return null;return {account:a.account==='school'?'school':'personal',subject:cleanText(a.subject,200).replace(/\s+/g,' '),body:cleanText(a.body,4000),cc,cc_names:namesOf(cc,c),bcc,bcc_names:namesOf(bcc,c),...t};}
const draftLines=a=>`${a.cc.length?`\nCc: ${a.cc_names.join(', ')}`:''}${a.bcc.length?`\nBcc: ${a.bcc_names.join(', ')}`:''}${a.in_reply_to?'\nIn reply to their email (same thread)':''}\nSubject: ${a.subject}\n\n${a.body}`;
const draftReply=d=>d.gmail?`It’s in your ${d.account==='school'?'UChicago':'personal'} Gmail Drafts; review it and press Send yourself.`:'It’s in Telegram to copy and send yourself.';
// tier: auto (runs and is logged), confirm (stored proposal, explicit approval), draft (prepared; Jackson sends it himself).
// trusted: only Jackson's own channels may originate it. channelApproval: approved in Telegram/web, never by voice.
// exact: the approved action must equal the stored proposal field for field (names, numbers, prompts come from code).
export const ACTIONS={
  capture:{tier:'confirm',perDay:50,
    validate:a=>({type:'capture',title:cleanText(a.title,500),notes:String(a.notes||'').slice(0,3000),category:['personal','school','persian','career'].includes(a.category)?a.category:'personal',due_at:a.due_at&&validInstant(a.due_at)?new Date(a.due_at).toISOString():null,confidence:'confirmed'}),
    render:a=>`Capture task: ${a.title}. Deadline: ${a.due_at?when(a.due_at):'none'}.`,
    destination:()=>'your Beacon task list',
    execute:(env,a)=>capture(env,a,'user-confirmed conversation')},
  checkin:{tier:'confirm',perDay:100,
    validate:(a,c)=>['blocks','tasks'].includes(a.kind)&&STATES.includes(a.status)&&(c[a.kind]||[]).some(x=>x.id===a.id)?{type:'checkin',kind:a.kind,id:a.id,status:a.status,note:String(a.note||'').slice(0,3000),actual_minutes:Number.isInteger(a.actual_minutes)&&a.actual_minutes>=0&&a.actual_minutes<=1440?a.actual_minutes:null}:null,
    render:a=>`Mark ${a.kind==='blocks'?'work block':'task'} as ${a.status}${a.actual_minutes!=null?`, ${a.actual_minutes} minutes`:''}.`,
    destination:()=>'your Beacon check-ins',
    execute:(env,a)=>checkin(env,a.kind,a.id,a)},
  note:{tier:'auto',validate:()=>({type:'note'}),render:()=>'Save a note in your words.'},
  feedback:{tier:'auto',validate:()=>({type:'feedback'}),render:()=>'Save feedback about Beacon in your words.'},
  meal:{tier:'auto',validate:a=>validateMeal(a),render:a=>`Log meal: ${a.description}.`,destination:()=>'your food log',execute:(env,a)=>logMeal(env,a,'proposal'),unaudited:true},
  meals:{tier:'auto',validate:a=>{if(!Array.isArray(a.meals)||!a.meals.length||a.meals.length>8)return null;const meals=a.meals.map(validateMeal);return meals.every(Boolean)?{type:'meals',meals}:null;},render:a=>`Log ${a.meals.length} meals.`},
  // Telegram isn't end-to-end encrypted (DATA.md C2): the card shows only the last 4 digits; he typed the full number himself.
  contact:{tier:'confirm',perDay:10,trusted:true,channelApproval:true,exact:true,
    validate:a=>{const name=cleanText(a.name,80).replace(/\s+/g,' '),phone=normalizePhone(a.phone),email=normalizeEmail(a.email);return phone===undefined||email===undefined||(!phone&&!email)?null:{type:'contact',name,phone,email,notes:String(a.notes||'').slice(0,300)};},
    render:a=>`Add contact: ${a.name}. Phone: ${a.phone?maskPhone(a.phone):'none'}. Email: ${a.email||'none'}.`,
    destination:()=>'your contacts list',
    execute:(env,a,p)=>addContact(env,a,p.origin)},
  draft:{tier:'draft',neverProposed:true,
    validate:(a,c)=>{const contact=contactOf(a,c),f=contact&&draftFields(a,c,[contact.id]);return f?{type:'draft',contact_id:contact.id,name:contact.name,...f}:null;},
    render:a=>`Draft to ${a.name}${a.cc?.length?` (cc ${a.cc_names.join(', ')})`:''} from your ${acct(a)} account: ${a.subject}.`,
    destination:a=>`your ${acct(a)} Gmail Drafts (you send it)`},
  // A draft to saved contacts on a turn that read untrusted content (SAFETY rule 5): the card shows the full literal text.
  draft_confirm:{tier:'confirm',perDay:DRAFTS_PER_DAY,exact:true,changed:'The contact changed since this was proposed',
    validate:(a,c)=>{const contact=contactOf(a,c),f=contact&&draftFields(a,c,[contact.id]);return f?{type:'draft_confirm',contact_id:contact.id,name:contact.name,...f}:null;},
    render:a=>`Draft to ${a.name} from your ${acct(a)} account (from untrusted content, so check it):${draftLines(a)}`,
    destination:a=>`your ${acct(a)} Gmail Drafts (you send it)`,
    execute:async(env,a)=>{const d=await sendDraft(env,a);return {reply:`Draft to ${d.name} saved. ${draftReply(d)}`};}},
  // Sender candidate (SAFETY rule 5 exception, design "Sender candidates"): one card adds the contact from the verified From
  // header, then writes the draft. Approve = both, Cancel = neither; counted against contact_and_draft 5/day, contact 10/day
  // and DRAFTS_PER_DAY. The address was resolved by code at proposal time and is re-read from the message at approval.
  contact_and_draft:{tier:'confirm',perDay:5,pool:'contact',trusted:true,channelApproval:true,exact:true,changed:'The sender or a contact changed since this was proposed',
    validate:(a,c)=>{const name=String(a.name||'').replace(/[^A-Za-z0-9 .,'-]/g,'').replace(/\s+/g,' ').trim().slice(0,80),address=normalizeEmail(a.address);
      if(!name||!address||!GMAIL_ID.test(String(a.message_id||''))||!['personal','school'].includes(a.msg_account))return null;
      if((c.contacts||[]).some(k=>k.email===address||k.name.toLowerCase()===name.toLowerCase()))return null;
      const f=draftFields(a,c,[]);return f?{type:'contact_and_draft',name,address,message_id:a.message_id,msg_account:a.msg_account,messages_with:Number.isInteger(a.messages_with)&&a.messages_with>=0?a.messages_with:0,...f}:null;},
    render:a=>`Add contact: ${a.name} (name unverified) · ${a.address} · sender verified ✓ · you have ${a.messages_with} message${a.messages_with===1?'':'s'} with this address.\nThen draft from your ${acct(a)} account:${draftLines(a)}`,
    destination:a=>`your contacts list, then your ${acct(a)} Gmail Drafts (you send it)`,
    execute:async(env,a,p)=>{
      const {senderStillIs}=await import('./email.js');
      // Approve = both or neither: the draft cap is checked before the contact is written.
      if(await draftsCapped(env))throw new Error('That’s the daily draft limit; nothing was saved. Try again tomorrow');
      if(!await senderStillIs(env,a.msg_account,a.message_id,a.address)){await auditRow(env,'proposal:voided:sender_changed',p.id);throw new Error('That email’s sender no longer matches; nothing was saved');}
      const c=await addContact(env,{name:a.name,phone:null,email:a.address,notes:'Added from a verified email sender'},p.origin);await auditRow(env,'contact:added',c.id);
      const d=await sendDraft(env,{...a,contact_id:c.id});return {reply:`Saved ${c.name} to contacts and drafted the email. ${draftReply(d)}`,contact_id:c.id};}},
  draft_edit:{tier:'draft',neverProposed:true,
    validate:(a,c)=>c.draft&&a.draft_id===c.draft.id&&typeof a.body==='string'&&a.body.trim()?{type:'draft_edit',draft_id:c.draft.id,subject:a.subject?cleanText(a.subject,200).replace(/\s+/g,' '):null,body:cleanText(a.body,4000)}:null,
    render:a=>`Update the current draft${a.subject?`: ${a.subject}`:''}.`},
  call:{tier:'confirm',perDay:10,channelApproval:true,exact:true,
    validate:(a,c)=>{const contact=contactOf(a,c);return contact?.phone?{type:'call',contact_id:contact.id,name:contact.name,number_mask:maskPhone(contact.phone)}:null;},
    render:a=>`Call ${a.name} at ${a.number_mask}. Beacon rings your phone first, then connects you. Not recorded; ends after 60 minutes.`,
    destination:a=>`a phone call to ${a.name} (${a.number_mask})`,
    execute:(env,a,p)=>placeBridgeCall(env,a.contact_id,p.id)},
  // Reminder calls (reminders.js): rings ONLY his own number at the time he chose. Confirm tier so a misheard time never rings him.
  reminder_call:{tier:'confirm',perDay:20,channelApproval:true,exact:true,
    validate:a=>validateReminder(a),render:a=>renderReminder(a),
    destination:()=>'a call to your own phone',
    execute:(env,a,p)=>scheduleReminder(env,a,p)},
  // Tasks by voice/chat (ROADMAP M3): Auto tier, applied at once with a 24-hour Undo (tasks.js).
  task_add:{tier:'auto',perDay:60,
    validate:a=>({type:'task_add',title:cleanText(a.title,500),notes:String(a.notes||'').slice(0,3000),category:['personal','school','persian','career'].includes(a.category)?a.category:'personal',due_at:a.due_at&&validInstant(a.due_at)?new Date(a.due_at).toISOString():null,priority:{high:1,normal:2,low:3}[a.priority]||2}),
    render:a=>`Add task: ${a.title}.`,destination:()=>'your Beacon task list'},
  task_done:{tier:'auto',perDay:100,validate:(a,c)=>(c.tasks||[]).find(t=>t.id===a.id&&!['done','skipped'].includes(t.status))?{type:'task_done',id:a.id}:null,render:()=>'Mark a task done.',destination:()=>'your Beacon task list'},
  // execute: only reached as an approval card, when the agent demotes it on a tainted turn (agent.js demote()); still undoable.
  task_priority:{tier:'auto',perDay:100,validate:(a,c)=>(c.tasks||[]).some(t=>t.id===a.id)&&{high:1,normal:2,low:3}[a.priority]?{type:'task_priority',id:a.id,priority:{high:1,normal:2,low:3}[a.priority]}:null,render:a=>`Set a task to ${['','high','normal','low'][a.priority]} priority.`,destination:()=>'your Beacon task list',
    execute:async(env,a)=>(await import('./tasks.js')).applyTask(env,a)},
  // Mac node: an agent task is Confirm tier; send_file is Auto (read-only, to Jackson only).
  agent_task:{tier:'confirm',perDay:10,trusted:true,exact:true,changed:'The task changed since it was proposed',
    validate:a=>({type:'agent_task',prompt:cleanText(a.prompt,2000).replace(/[\r\n]+/g,' ')}),
    render:a=>`Run on your Mac: ${a.prompt}. Claude Code works in the Beacon folder, commits and pushes, and never deploys.`,
    destination:()=>'Claude Code on your Mac (Beacon repo; result to Telegram)',
    execute:async(env,a,p)=>{const job=await queueJob(env,{kind:'task',prompt:a.prompt},p.origin,true,p.id);return {...job,reply:queuedReply('task',job.online)};}},
  ...CALENDAR_ACTIONS,
  send_file:{tier:'auto',trusted:true,validate:a=>({type:'send_file',query:cleanText(a.query,300).replace(/\s+/g,' ')}),render:a=>`Send you the file: ${a.query}.`,destination:()=>'your Telegram'}
};

export function validateAction(action,context){
  if(!action||typeof action!=='object'||!Object.hasOwn(ACTIONS,action.type))return null;
  return ACTIONS[action.type].validate(action,context||{})||null;
}
// Read-back text is generated here from the validated fields, never by the model.
export function describeAction(action){return action&&Object.hasOwn(ACTIONS,action.type)?ACTIONS[action.type].render(action):'';}

// Provenance for approval cards: who asked, through what, where it goes, and the tier.
export function originLabel(origin){
  const o=String(origin||'');
  if(o==='telegram')return 'you, via Telegram';if(o==='voice')return 'you, on a call';if(o==='web')return 'you, in the web app';
  if(o.startsWith('email:'))return `an email from ${o.slice(6).replace(/[^a-z0-9.-]/gi,'').slice(0,80)||'an unknown sender'}`;
  if(o.startsWith('routine'))return 'a Beacon routine';
  return 'an unknown source';
}
const TIER_LABEL={confirm:'Confirm tier: runs only if you approve',auto:'Auto tier',draft:'Draft tier: you send it yourself'};
export function provenance(action,origin){
  const def=ACTIONS[action?.type];if(!def)return '';
  return `From: ${originLabel(origin)}\nTo: ${def.destination?def.destination(action):'Beacon'}\nDoes: ${def.render(action)}\n${TIER_LABEL[def.tier]}.`;
}
// Proposal gate: type known, proposable, origin allowed, under its daily limit. Throws with a user-facing reason.
export async function checkProposal(env,action,origin){
  const def=ACTIONS[action?.type];
  if(!def)throw new Error('Unknown action');
  if(def.neverProposed)throw new Error('Drafts are never executed');
  // SAFETY rule 5: contacts and agent tasks only from Jackson's own channels.
  if(def.trusted&&!TRUSTED_ORIGINS.includes(origin))throw new Error(action.type.startsWith('contact')?'Contacts can only be added from your own messages':'Agent tasks can only come from your own messages');
  if(def.perDay&&await createdToday(env,[action.type])>=def.perDay)throw new Error(`Daily limit reached for ${action.type}`);
  // A pooled type (contact_and_draft → contact) also counts against the pool's limit, and the pool's own proposals count its members.
  const pool=def.pool||(Object.values(ACTIONS).some(d=>d.pool===action.type)?action.type:null);
  if(pool){const members=Object.entries(ACTIONS).filter(([t,d])=>t===pool||d.pool===pool).map(([t])=>t);if(await createdToday(env,members)>=ACTIONS[pool].perDay)throw new Error(`Daily limit reached for ${pool}`);}
  return def;
}
async function createdToday(env,types){let n=0;const since=new Date(Date.now()-86400000).toISOString();for(const t of types)n+=(await env.DB.prepare('SELECT COUNT(*) AS n FROM audit WHERE action LIKE ? AND created_at>?').bind(`proposal:created:${t}:%`,since).first()).n;return n;}
export const auditRow=(env,action,target)=>env.DB.prepare('INSERT INTO audit VALUES(?,?,?,?)').bind(crypto.randomUUID(),String(action).slice(0,120),target==null?null:String(target).slice(0,200),nowIso()).run();
