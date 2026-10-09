import {all,run,nowIso,health} from './service.js';
import {localParts} from './core.js';
import {hash,randomToken,validateTwilio} from './auth.js';
import {sendTelegram} from './tgapi.js';
import {gatherNews,newsDigest} from './news.js';
import {dayTotals,targets,totalsLine} from './meals.js';
import {chicagoWeather} from './weather.js';
import {createState,onInterrupt,onSpeech} from './briefcall.js';
import {saveNote} from './notes.js';
import {checkPin,pinPad,voiceTurns} from './voice.js';
import {smallTalk,CHAT_CAP} from './voicechat.js';
import {storedDomain,scrub,clip} from './mail.js';

const TZ='America/Chicago';
const clock=iso=>new Date(iso).toLocaleTimeString('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'});
const dayName=iso=>new Date(iso).toLocaleDateString('en-US',{timeZone:TZ,weekday:'long',month:'long',day:'numeric'});
const strip=title=>String(title).replace(/^(Class work|Career) — /,'');
// Brief text is built by code from stored data only; no model, no email bodies.
export async function buildBrief(env,kind,at=new Date()){
  const local=localParts(at),dayStart=new Date(at.getTime()-36*3600000).toISOString(),dayEnd=new Date(at.getTime()+36*3600000).toISOString();
  const blocks=(await all(env,'SELECT * FROM blocks WHERE active=1 AND start_at>? AND start_at<? ORDER BY start_at',dayStart,dayEnd));
  const today=blocks.filter(b=>localParts(new Date(b.start_at)).date===local.date);
  const tomorrowDate=localParts(new Date(at.getTime()+86400000)).date,tomorrow=blocks.filter(b=>localParts(new Date(b.start_at)).date===tomorrowDate);
  const due=await all(env,"SELECT title,due_at FROM tasks WHERE status NOT IN ('done','skipped') AND due_at IS NOT NULL AND confidence!='unconfirmed' AND due_at>? AND due_at<? ORDER BY due_at LIMIT 5",at.toISOString(),new Date(at.getTime()+7*86400000).toISOString());
  const open=(await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done','skipped')").first()).n;
  const gaps=(await health(env)).filter(s=>['calendar','gmail'].includes(s.id)&&s.status!=='ok');
  const lines=[];
  if(kind==='morning'){
    lines.push(`Good morning Jackson. It's ${dayName(at.toISOString())}.`);
    const weather=await chicagoWeather();if(weather)lines.push(weather.line);
    lines.push(today.length?`You have ${today.length} work block${today.length>1?'s':''} today: ${today.map(b=>`${strip(b.title)} at ${clock(b.start_at)}`).join('; ')}.`:'No work blocks are scheduled today.');
    lines.push(due.length?`Coming up: ${due.map(t=>`${t.title}, due ${dayName(t.due_at)} at ${clock(t.due_at)}`).join('; ')}.`:'No confirmed deadlines in the next 7 days.');
    lines.push(`You have ${open} open tasks.`);
    if(today[0])lines.push(`First up: ${strip(today[0].title)}.`);
  }else{
    const done=today.filter(b=>b.status==='done').length,unresolved=today.filter(b=>!['done','skipped'].includes(b.status)&&Date.parse(b.end_at)<at.getTime());
    lines.push(`Evening check, Jackson. ${done} of ${today.length} blocks marked done today.`);
    if(unresolved.length)lines.push(`Still needing an update: ${unresolved.map(b=>strip(b.title)).join('; ')}. Nothing will be moved.`);
    lines.push(tomorrow[0]?`Tomorrow starts with ${strip(tomorrow[0].title)} at ${clock(tomorrow[0].start_at)}.`:'Nothing scheduled tomorrow yet.');
    if(due.length)lines.push(`Next deadline: ${due[0].title}, ${dayName(due[0].due_at)} at ${clock(due[0].due_at)}.`);
  }
  const goal=await targets(env),food=await dayTotals(env,kind==='morning'?localParts(new Date(at.getTime()-86400000)).date:local.date);
  if(food.meals.length)lines.push(`${kind==='morning'?'Yesterday you logged':'Food today:'} ${totalsLine(food,goal)}.`);
  if(kind==='morning'){
    const since=new Date(at.getTime()-24*3600000).toISOString();
    const c=await env.DB.prepare("SELECT SUM(level='notify') n, SUM(level='digest') d, SUM(level='phishing') p FROM mail_items WHERE received_at>?").bind(since).first();
    if(c?.n||c?.d||c?.p)lines.push(`Email since yesterday: ${c.n||0} needed attention, ${c.d||0} in your digest${c.p?`, and ${c.p} likely phishing, which I flagged`:''}.`);
  }
  if(gaps.length)lines.push(`Heads up: ${gaps.map(s=>s.id).join(' and ')} ${gaps.length>1?'are':'is'} not syncing.`);
  return lines.join(' ');
}

// Short script for the phone call: one line per topic, no lists.
export async function buildSpoken(env,kind,at=new Date()){
  const local=localParts(at),blocks=await all(env,'SELECT * FROM blocks WHERE active=1 AND start_at>? AND start_at<? ORDER BY start_at',new Date(at.getTime()-36*3600000).toISOString(),new Date(at.getTime()+36*3600000).toISOString());
  const today=blocks.filter(b=>localParts(new Date(b.start_at)).date===local.date);
  const next=await env.DB.prepare("SELECT title,due_at FROM tasks WHERE status NOT IN ('done','skipped') AND due_at IS NOT NULL AND confidence!='unconfirmed' AND due_at>? ORDER BY due_at LIMIT 1").bind(at.toISOString()).first();
  const goal=await targets(env),out=[];
  if(kind==='morning'){
    const w=await chicagoWeather();out.push(`Morning, Jackson.${w?` ${w.short}`:''}`);
    out.push(today.length?`${today.length} block${today.length>1?'s':''} today. First is ${strip(today[0].title)} at ${clock(today[0].start_at)}.`:'Nothing scheduled today.');
    if(next)out.push(`Next deadline: ${next.title}, ${new Date(next.due_at).toLocaleDateString('en-US',{timeZone:TZ,weekday:'long'})}.`);
    const food=await dayTotals(env,localParts(new Date(at.getTime()-86400000)).date);
    if(food.meals.length)out.push(`Yesterday: ${food.calories} calories${goal.calories?` of ${goal.calories}`:''}, ${food.protein_g} grams protein.`);
    const c=await env.DB.prepare("SELECT SUM(level='notify') n FROM mail_items WHERE received_at>?").bind(new Date(at.getTime()-24*3600000).toISOString()).first();
    if(c?.n)out.push(`${c.n} email${c.n>1?'s':''} need${c.n>1?'':'s'} you. Details are in Telegram.`);
  }else{
    const done=today.filter(b=>b.status==='done').length;
    out.push(`Evening, Jackson. ${done} of ${today.length} blocks done.`);
    const food=await dayTotals(env,local.date);
    if(food.meals.length)out.push(`${food.calories} calories today${goal.calories?`, ${goal.calories-food.calories>=0?`${goal.calories-food.calories} left`:`${food.calories-goal.calories} over`}`:''}.`);
    const tomorrowDate=localParts(new Date(at.getTime()+86400000)).date,t=blocks.find(b=>localParts(new Date(b.start_at)).date===tomorrowDate);
    if(t)out.push(`Tomorrow starts with ${strip(t.title)} at ${clock(t.start_at)}.`);
  }
  return out;
}

// Credential expiry: Telegram 7 days out; a call (plus Telegram) 3 days out and on the day. Each stage once per expiry date.
export async function credentialNotices(env,at=new Date()){
  const rows=await all(env,'SELECT * FROM credential_expiry ORDER BY expires_at');
  const prefs=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first()).value),out=[];
  for(const c of rows){
    const days=Math.ceil((Date.parse(c.expires_at)-at.getTime())/86400000),stage=days<=0?'expired':days<=3?'3':days<=7?'7':null;
    if(!stage)continue;
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`cred:${c.id}:${stage}:${c.expires_at}`,nowIso());if(!first.meta.changes)continue;
    const when=days<=0?'has expired':days===1?'expires tomorrow':`expires in ${days} days, on ${dayName(c.expires_at)}`;
    await sendTelegram(env,`🔑 ${c.name} ${when}.\nTo renew: ${c.renew}`);out.push({id:c.id,stage});
    const callOn=['3','expired'].includes(stage)&&prefs.briefCall!==false&&env.VOICE_ENABLED==='true'&&env.TWILIO_SID&&env.TWILIO_TOKEN&&env.OWNER_NUMBER&&env.TWILIO_NUMBER;
    if(callOn){const code=verificationCode();await sendTelegram(env,`📞 Calling you about it now. Verification code: ${code}`);await placeCall(env,'credential',[`Heads up. Your ${c.name} ${when}.`,'If it lapses, that part of Beacon stops working.','The renewal steps are in Telegram.'],code,at);}
  }
  return out;
}
// Sunday quarantine review: summary and nudges in Telegram, and the same summary spoken on a call (notes/feedback only).
export async function deliverQuarantineCall(env,at=new Date()){
  const prefs=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first()).value);
  const callOn=prefs.quarantineCallOn!==false&&env.VOICE_ENABLED==='true'&&env.TWILIO_SID&&env.TWILIO_TOKEN&&env.OWNER_NUMBER&&env.TWILIO_NUMBER;
  return (await import('./quarantine.js')).deliverQuarantine(env,at,callOn?async spoken=>{const code=verificationCode();await sendTelegram(env,`📞 Calling you now for the quarantine review. Verification code: ${code}`);return placeCall(env,'quarantine',[...spoken,'Details are in Telegram.'],code,at);}:null);
}
// Twice-weekly career update: scout finds (full list with links in Telegram), follow-ups due, career deadlines this week.
export async function deliverCareer(env,at=new Date()){
  const prefs=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first()).value);
  const roles=await (await import('./scout.js')).scoutDigest(env,at,undefined,{fromCareer:true}).catch(()=>null)||{count:0,top:[]};
  const due=(await (await import('./outreach.js')).waiting(env)).filter(o=>{const d=Math.round((at.getTime()-Date.parse(o.sent_at))/86400000);return d>=7&&d<21;});
  const deadlines=await all(env,"SELECT title,due_at FROM tasks WHERE category='career' AND status NOT IN ('done','skipped') AND due_at IS NOT NULL AND due_at>? AND due_at<? ORDER BY due_at LIMIT 5",at.toISOString(),new Date(at.getTime()+7*86400000).toISOString());
  const spoken=['Career update.'];
  spoken.push(roles.count?`${roles.count} new role${roles.count>1?'s':''} at your bar. ${roles.top.slice(0,3).map(r=>`${r.title} at ${r.company}`).join('. ')}.`:'No new roles at your bar since last time.');
  if(due.length)spoken.push(`${due.length} follow-up${due.length>1?'s':''} due: ${due.slice(0,3).map(o=>`${o.name} at ${o.org}`).join(', ')}.`);
  if(deadlines.length)spoken.push(`Career deadlines this week: ${deadlines.slice(0,3).map(t=>`${t.title}, ${dayName(t.due_at)}`).join('; ')}.`);
  spoken.push('Links are in Telegram.');
  const callOn=prefs.careerCall!==false&&env.VOICE_ENABLED==='true'&&env.TWILIO_SID&&env.TWILIO_TOKEN&&env.OWNER_NUMBER&&env.TWILIO_NUMBER,code=verificationCode();
  await sendTelegram(env,`💼 Career update\n${spoken.slice(1,-1).join('\n')||'Nothing new.'}${due.length?`\n\nFollow-ups due:\n${due.map(o=>`• ${o.name} (${o.org})`).join('\n')}`:''}${callOn?`\n\n📞 Calling you now. Verification code: ${code}`:''}`);
  if(!callOn)return {called:false};
  return placeCall(env,'career',spoken,code,at);
}

const WORDS=['maple','harbor','falcon','cedar','copper','summit','river','orchid','granite','willow','ember','atlas','juniper','meadow','onyx','pilot'];
export const verificationCode=()=>{const b=crypto.getRandomValues(new Uint8Array(2));return `${WORDS[b[0]%WORDS.length]}-${10+b[1]%90}`;};

// Telegram gets the brief and the code first; the call then says the same code so a spoofed call is detectable.
export async function deliverBrief(env,kind,at=new Date()){
  const prefs=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first()).value);
  let text=await buildBrief(env,kind,at),digest=null;const spoken=await buildSpoken(env,kind,at);
  // Morning only: a short news section (one spoken line per topic; full list with links in Telegram).
  if(kind==='morning'&&prefs.news!==false){digest=await newsDigest(env,await gatherNews(at.getTime())).catch(()=>null);if(digest)text+=` ${digest.spoken}`;if(digest?.headlines)spoken.push(digest.headlines);}
  const callOn=prefs.briefCall!==false&&env.VOICE_ENABLED==='true'&&env.TWILIO_SID&&env.TWILIO_TOKEN&&env.OWNER_NUMBER&&env.TWILIO_NUMBER;
  const code=verificationCode();
  // Morning: the notes files most related to today's blocks (paths and headings only).
  if(kind==='morning'){const today=await all(env,'SELECT title FROM blocks WHERE active=1 AND start_at>? AND start_at<? ORDER BY start_at LIMIT 4',at.toISOString(),new Date(at.getTime()+16*3600000).toISOString());
    const hits=today.length?await (await import('./kb.js')).kbSearch(env,today.map(b=>b.title).join(' '),3).catch(()=>[]):[];
    if(hits.length)text+=`\n\n📚 Related notes: ${[...new Set(hits.map(h=>h.path+(h.title?` › ${h.title}`:'')))].join('; ')}`;}
  await sendTelegram(env,`${kind==='morning'?'☀️ Morning brief':'🌙 Evening check'}\n${text}${callOn?`\n\n📞 Calling you now. Verification code: ${code}`:''}`);
  if(digest)await sendTelegram(env,digest.text);
  if(kind==='morning'){
    const items=await all(env,"SELECT id,sender,subject,reason,domain FROM mail_items WHERE level='digest' AND briefed_at IS NULL AND received_at>? ORDER BY received_at DESC LIMIT 12",new Date(at.getTime()-48*3600000).toISOString());
    if(items.length){
      // Display names and subjects are sender-written: links, addresses and numbers are removed (a bare From address is kept as is).
      // Senders Beacon has never heard about from Jackson (no rule, no earlier vote) get numbered 👍/👎 buttons.
      const known=new Set((await all(env,"SELECT domain FROM sender_rules UNION SELECT domain FROM mail_items WHERE feedback IS NOT NULL AND domain IS NOT NULL")).map(r=>r.domain));
      const fresh=items.filter(i=>{const d=i.domain||storedDomain(i.sender);return d&&!known.has(d)&&/^[A-Za-z0-9_-]{1,40}$/.test(i.id);}).slice(0,6);
      const keyboard=fresh.map(i=>{const k=items.indexOf(i)+1;return [{text:`👍 ${k} matters`,callback_data:`f:${i.id}:m`},{text:`👎 ${k} ignore`,callback_data:`f:${i.id}:i`}];});
      await sendTelegram(env,`📬 Email digest\n${items.map((i,k)=>{const d=i.domain||storedDomain(i.sender),raw=clip(i.sender.replace(/<.*>/,'').replace(/"/g,''),80),n=/^[^\s@]+@[^\s@]+$/.test(raw)?raw:scrub(raw);return `${k+1}. ${d&&n.includes(d)?n:`${n||'Unknown'} (${d||'unknown domain'})`}: ${scrub(clip(i.subject,160))}`;}).join('\n')}${keyboard.length?'\n\nNew senders: tap 👍 or 👎 so I learn them.':''}`,keyboard.length?{reply_markup:{inline_keyboard:keyboard}}:{});
      await run(env,`UPDATE mail_items SET briefed_at=? WHERE id IN (${items.map(()=>'?').join(',')})`,nowIso(),...items.map(i=>i.id));
    }
  }
  if(!callOn)return {called:false};
  return placeCall(env,kind,spoken,code,at);
}

// Shared by briefs and the career update: one-use token, verification code spoken first, voicemail hangs up.
export async function placeCall(env,kind,spoken,code,at){
  const token=randomToken();
  await run(env,'INSERT INTO brief_calls(token_hash,kind,text,code,created_at,expires_at) VALUES(?,?,?,?,?,?)',await hash(token),kind,JSON.stringify(spoken),code,nowIso(),new Date(at.getTime()+10*60000).toISOString());
  const url=new URL('/voice/brief',env.PUBLIC_URL||'https://your-worker.example.workers.dev');url.searchParams.set('t',token);
  const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Calls.json`,{method:'POST',headers:{Authorization:'Basic '+btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)},
    body:new URLSearchParams({To:env.OWNER_NUMBER,From:env.TWILIO_NUMBER,Url:url.href,Method:'POST',MachineDetection:'Enable',Timeout:'25'}),signal:AbortSignal.timeout(15000)});
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`brief:call:${kind}:${r.ok?'placed':'failed'}`,null,nowIso());
  if(!r.ok){const e=await r.json().catch(()=>({}));console.error(JSON.stringify({event:'brief_call_failed',status:r.status,code:e.code}));return {called:false,status:r.status,twilio_code:e.code??null,twilio_message:String(e.message||'').slice(0,200)};}
  return {called:true};
}

const xml=s=>String(s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
const twiml=body=>new Response(`<Response>${body}</Response>`,{headers:{'content-type':'text/xml'}});
// Twilio fetches the brief once. Voicemail gets a hang-up, never the schedule.
export async function briefTwiml(request,env){
  const form=Object.fromEntries(await request.formData());
  if(!await validateTwilio(request,env,form))return new Response('Forbidden',{status:403});
  if(String(form.AnsweredBy||'').startsWith('machine')||form.AnsweredBy==='fax')return twiml('<Hangup/>');
  const token=new URL(request.url).searchParams.get('t')||'',now=nowIso();
  const claim=await run(env,'UPDATE brief_calls SET used_at=?,call_sid=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?',now,String(form.CallSid||'').slice(0,64),await hash(token),now);
  if(!claim.meta.changes)return twiml('<Hangup/>');
  const row=await env.DB.prepare('SELECT text,code FROM brief_calls WHERE token_hash=?').bind(await hash(token)).first();
  // Two-way call: Jackson can say stop/pause/hold on/note/feedback at any point, then "OK Beacon, resume".
  const socket=randomToken();
  await run(env,'INSERT INTO voice_sessions(token_hash,expires_at) VALUES(?,?)',await hash(socket),new Date(Date.now()+60000).toISOString());
  const url=new URL('/voice/brief-socket',request.url);url.protocol='wss:';url.searchParams.set('token',socket);url.searchParams.set('b',await hash(token));
  return twiml(`<Connect><ConversationRelay url="${xml(url.href)}" welcomeGreeting="${xml(`Beacon here. Check code ${row.code.replace('-',' ')}.`)}" dtmfDetection="true" ttsProvider="Google" voice="${xml((env.BRIEF_VOICE||'Google.en-US-Chirp3-HD-Charon').replace(/^Google\./,''))}" interruptible="speech" /></Connect>`);
}

// WebSocket for brief/career calls. Before the keypad PIN: notes, feedback and tool-less small talk (voicechat.js), nothing
// else. Typing the PIN + # unlocks the same verified turns as the voice line (voice.js), for the rest of the call.
export async function briefSocket(request,env,ctx){
  if(request.headers.get('Upgrade')!=='websocket')return new Response('Upgrade required',{status:426});
  const u=new URL(request.url),now=nowIso();
  const claim=await run(env,'UPDATE voice_sessions SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?',now,await hash(u.searchParams.get('token')||''),now);
  if(!claim.meta.changes)return new Response('Forbidden',{status:403});
  const row=await env.DB.prepare('SELECT text,kind FROM brief_calls WHERE token_hash=? AND used_at>?').bind(String(u.searchParams.get('b')||'').slice(0,64),new Date(Date.now()-15*60000).toISOString()).first();
  if(!row)return new Response('Forbidden',{status:403});
  let parts;try{parts=JSON.parse(row.text);}catch{parts=[row.text];}
  const state=createState(parts),pair=new WebSocketPair(),[client,server]=Object.values(pair);server.accept();
  let idle=null,chain=Promise.resolve(),unlocked=false,failures=0,chats=0;const pad=pinPad(),history=[];
  const close=()=>{if(server.readyState===1){server.send(JSON.stringify({type:'end'}));server.close(1000,'done');}};
  // Hang up after the closing question if he says nothing; give longer while he's dictating a note or talking.
  const arm=ms=>{clearTimeout(idle);idle=setTimeout(()=>{chain=chain.then(async()=>{if(state.buffer.length){await saveNote(env,state.kind||'note',state.buffer.join(' '),'voice-brief',{call:row.kind,during:state.segments[state.at]});state.buffer=[];}close();});ctx.waitUntil(chain);},ms);};
  const speak=list=>{for(const t of list)if(server.readyState===1)server.send(JSON.stringify({type:'text',token:String(t).replace(/[.!?]?\s*$/,'…'),last:true}));arm(state.mode==='reading'&&!unlocked?Math.round(list.join(' ').length/14*1000)+15000:120000);};
  const turns=voiceTurns(env,ctx,{say:t=>speak([t]),end:()=>setTimeout(close,2500)});
  const reply=async text=>{
    if(++chats>CHAT_CAP)return speak(['Type your PIN and press pound to keep going.']);
    const r=await smallTalk(env,text,history,state.segments.slice(0,-1));history.push({role:'user',content:text},{role:'assistant',content:r});speak([r]);
  };
  const apply=async effects=>{for(const e of effects){if(e.save)await saveNote(env,e.save.kind,e.save.text,'voice-brief',{call:row.kind,during:state.segments[state.at]});if(e.say)speak(e.say);if(e.chat)await reply(e.chat);if(e.end)setTimeout(close,2500);}};
  const cap=setTimeout(close,15*60000);
  server.addEventListener('close',()=>{clearTimeout(idle);clearTimeout(cap);});
  server.addEventListener('message',event=>{
    if(typeof event.data!=='string'||event.data.length>16000)return;
    let msg;try{msg=JSON.parse(event.data);}catch{return;}
    chain=chain.then(async()=>{
      if(msg.type==='setup')return apply([{say:state.segments}]);
      if(msg.type==='dtmf'&&!unlocked){
        const attempt=pad(msg.digit);if(attempt===null||failures>=3)return;
        const r=await checkPin(env,attempt);
        if(r==='ok'){unlocked=true;if(state.buffer.length){await saveNote(env,state.kind||'note',state.buffer.join(' '),'voice-brief',{call:row.kind});state.buffer=[];}return turns.send('Unlocked. What do you need?');}
        if(r==='bad')failures++;
        if(r==='off')return speak(['Voice unlock isn’t set up. Use Telegram for that.']);
        if(r==='locked'||failures>=3){speak([r==='locked'?'Voice unlock is locked for today.':'That PIN is not correct. I’ll stick to the brief.']);failures=3;return;}
        return speak(['That PIN is not correct. Try again, then press pound.']);
      }
      if(msg.type==='interrupt')return unlocked?turns.interrupt(msg.utteranceUntilInterrupt):apply(onInterrupt(state,msg.utteranceUntilInterrupt));
      if(msg.type==='prompt'&&msg.last&&typeof msg.voicePrompt==='string'){
        if(unlocked){arm(120000);return turns.prompt(msg.voicePrompt);}
        return apply(onSpeech(state,msg.voicePrompt.slice(0,3000)));
      }
    }).catch(()=>{console.error(JSON.stringify({event:'brief_socket_failed'}));speak(['Sorry, I lost that. Say it again?']);});
    ctx.waitUntil(chain);
  });
  return new Response(null,{status:101,webSocket:client});
}
