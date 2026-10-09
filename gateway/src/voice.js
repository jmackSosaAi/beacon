import {validateTwilio,hash,randomToken} from './auth.js';
import {run,nowIso,notify} from './service.js';
import {converse,executeProposal,describeAction} from './conversation.js';
import {proposalCard} from './telegram.js';
import {ACTIONS} from './actions.js';
import {saveNote} from './notes.js';
import {createPause,spoke,interrupted,onSpeech,unsaved} from './voicepause.js';
import {markOutcome,markVoice,startCall,endCall} from './interactions.js';
import {smallTalk,CHAT_CAP} from './voicechat.js';
const xml=s=>String(s).replace(/[<>&'\"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
export async function incomingVoice(request,env){
  const form=Object.fromEntries(await request.formData());
  if(!await validateTwilio(request,env,form)||!env.OWNER_NUMBER||form.From!==env.OWNER_NUMBER)return new Response('Forbidden',{status:403});
  // Fails closed: voice needs both the flag and a keypad PIN (caller ID can be spoofed).
  const lockout=await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='voice:pin-failed' AND created_at>?").bind(new Date(Date.now()-86400000).toISOString()).first();
  if(env.VOICE_ENABLED==='true'&&env.VOICE_PIN_HASH&&lockout.n>=5)return new Response('<Response><Say>Voice access is locked for today. Use your Beacon page.</Say></Response>',{headers:{'content-type':'text/xml'}});
  if(env.VOICE_ENABLED!=='true'||!env.VOICE_PIN_HASH)return new Response('<Response><Say>Beacon calling is not activated yet. Please use your Beacon capture page.</Say></Response>',{headers:{'content-type':'text/xml'}});
  const token=randomToken();await run(env,'INSERT INTO voice_sessions(token_hash,expires_at) VALUES(?,?)',await hash(token),new Date(Date.now()+60000).toISOString());
  const url=new URL('/voice/socket',request.url);url.protocol='wss:';url.searchParams.set('token',token);
  return new Response(`<Response><Connect><ConversationRelay url="${xml(url.href)}" welcomeGreeting="Beacon here. Talk to me, or type your PIN and press pound to unlock everything." dtmfDetection="true" ttsProvider="Google" voice="en-US-Chirp3-HD-Charon" interruptible="speech" language="en-US" /></Connect></Response>`,{headers:{'content-type':'text/xml'}});
}
// Keypad PIN, shared by the voice line and calls Beacon places (caller ID can be spoofed). Five misses in a day locks it.
export async function checkPin(env,attempt){
  if(env.VOICE_ENABLED!=='true'||!env.VOICE_PIN_HASH)return 'off';
  const lockout=await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='voice:pin-failed' AND created_at>?").bind(new Date(Date.now()-86400000).toISOString()).first();
  if(lockout.n>=5)return 'locked';
  if(attempt.length>=6&&await hash('jarvis-voice-pin:v1:'+attempt)===env.VOICE_PIN_HASH){await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'voice:pin-ok',null,nowIso());return 'ok';}
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'voice:pin-failed',null,nowIso());
  await notify(env,{id:`security:pin:${crypto.randomUUID()}`,title:'Wrong Beacon voice PIN entered',body:'Someone on a Beacon call entered a wrong PIN. If this wasn’t you, pause Beacon.',kind:'security'});
  return 'bad';
}
// Collects keypad digits; returns the attempt when # is pressed, otherwise null.
export function pinPad(){let digits='';return digit=>{if(typeof digit!=='string')return null;if(digit!=='#'){if(digits.length<12)digits+=digit.replace(/[^0-9]/g,'');return null;}const a=digits;digits='';return a;};}

// PIN-verified conversation turns (tools, read-backs, confirm), shared by the voice line and unlocked brief calls.
// io: {say(text), end(reason)}.
export function voiceTurns(env,ctx,io){
  let pending=null,revision=0,chain=Promise.resolve();const pause=createPause(),t={turns:0,pause};
  const PENDING_MS=60000,say=io.say;
  // Every conversational reply is remembered so "OK Beacon, resume" after a note can pick it up mid-way.
  const send=t.send=reply=>{spoke(pause,reply);say(reply);};
  // A barge-in marks the last voice turn `interrupted` with the sentence index it was cut at (never the other party's words).
  t.interrupt=heard=>{revision++;interrupted(pause,heard);ctx.waitUntil(markVoice(env,'interrupted',String(pause.at)).catch(()=>{}));};
  t.prompt=raw=>{
    const text=raw.slice(0,3000),turnRevision=++revision;
    if(++t.turns>40){send('Let’s stop here for now. You can continue in your Beacon page.');io.end('turn_cap');return;}
    // Note/feedback/hold on/resume are handled in code first, never by the model.
    const effects=onSpeech(pause,text);
    if(effects){
      chain=chain.then(async()=>{
        for(const e of effects){
          if(e.save)await saveNote(env,e.save.kind,e.save.text,'voice',{during:pause.last.join(' ').slice(0,400)||'conversation call'});
          // A resumed read-back gets a fresh confirm window.
          if(e.replay)await markVoice(env,'voice_what',text.slice(0,60)).catch(()=>{});
          if(e.say){if(e.resumed&&pending)pending.at=Date.now();say(e.say);}
        }
      }).catch(()=>say('I couldn’t save that. Try again in Telegram.'));
      ctx.waitUntil(chain);return;
    }
    chain=chain.then(async()=>{
      if(turnRevision!==revision)return;
      // Only the exact word "confirm", within 60 seconds of the code-generated read-back.
      if(pending&&/^confirm[.! ]*$/i.test(text.trim())){
        const p=pending;pending=null;
        if(Date.now()-p.at>PENDING_MS){send('That expired. Tell me again if you still want it.');return;}
        const r=await executeProposal(env,p.id,'voice');send(r?.reply||'Saved. Your calendar has not been moved.');return;
      }
      if(/^(cancel|never mind|no)[.! ]*$/i.test(text.trim())){if(pending){await run(env,'UPDATE proposals SET used_at=? WHERE id=? AND used_at IS NULL',nowIso(),pending.id);await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'proposal:cancelled:voice',pending.id,nowIso());await markOutcome(env,{proposal_id:pending.id},'cancelled','voice').catch(()=>{});}pending=null;send('Okay, cancelled.');return;}
      // Voice gets a 10 s deadline; "Let me check." is spoken once before the first lookup (say, not send: it must not replace the replayable reply).
      pending=null;const result=await converse(env,text,'voice',{deadline:Date.now()+10000,onTools:()=>{if(turnRevision===revision)say('Let me check.');}});if(turnRevision!==revision)return;
      // Contacts and calls are approved in the channel, not by voice: send the card to Telegram instead.
      if(result.proposal_id&&ACTIONS[result.action?.type]?.channelApproval){await proposalCard(env,result.action,result.proposal_id,'voice');send(`${describeAction(result.action)} I sent that to Telegram. Approve it there.`);return;}
      pending=result.proposal_id?{id:result.proposal_id,at:Date.now()}:null;
      send(pending?`${describeAction(result.action)} Say confirm to save that, or cancel.`:result.reply);
    }).catch(()=>send('Something went wrong. Please use the Beacon page to check whether your update saved.'));
    ctx.waitUntil(chain);
  };
  return t;
}

export async function voiceSocket(request,env,ctx){
  if(request.headers.get('Upgrade')!=='websocket')return new Response('Upgrade required',{status:426});
  const token=new URL(request.url).searchParams.get('token')||'';
  const claim=await run(env,'UPDATE voice_sessions SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?',nowIso(),await hash(token),nowIso());
  if(!claim.meta.changes)return new Response('Forbidden',{status:403});
  const pair=new WebSocketPair(),[client,server]=Object.values(pair);server.accept();
  // One `calls` row per call: opened here, closed on hang-up with duration, turns, PIN result and how it ended.
  const callId=crypto.randomUUID(),callT0=Date.now();let endedBy='hangup';ctx.waitUntil(startCall(env,callId).catch(()=>{}));
  let chain=Promise.resolve(),verified=false,failures=0,chats=0;const pad=pinPad(),history=[];
  const say=reply=>{if(server.readyState===1)server.send(JSON.stringify({type:'text',token:reply,last:true}));};
  const end=reason=>{endedBy=reason;if(server.readyState===1)server.send(JSON.stringify({type:'end'}));};
  const turns=voiceTurns(env,ctx,{say,end});
  const timer=setTimeout(()=>{if(server.readyState===1){endedBy='limit';server.send(JSON.stringify({type:'end',handoffData:'Call limit reached'}));server.close(1000,'Ten-minute call limit');}},600000);
  // Hanging up in the middle of a note still saves what he said.
  server.addEventListener('close',()=>{clearTimeout(timer);ctx.waitUntil(endCall(env,callId,{duration_ms:Date.now()-callT0,turns:Math.min(turns.turns,40),verified,pin_failures:failures,ended_by:endedBy}).catch(()=>{}));const left=unsaved(turns.pause);if(left){turns.pause.mode='talk';turns.pause.buffer=[];ctx.waitUntil(saveNote(env,left.kind,left.text,'voice',{during:'conversation call (hung up before resume)'}).catch(()=>{}));}});server.addEventListener('error',()=>clearTimeout(timer));
  server.addEventListener('message',event=>{
    if(typeof event.data!=='string'||event.data.length>16000)return;
    let msg;try{msg=JSON.parse(event.data);}catch{return;}
    if(msg.type==='interrupt'){if(verified)turns.interrupt(msg.utteranceUntilInterrupt);return;}
    if(msg.type==='dtmf'&&!verified){
      const attempt=pad(msg.digit);if(attempt===null)return;
      chain=chain.then(async()=>{
        const r=await checkPin(env,attempt);
        if(r==='ok'){verified=true;turns.send('Unlocked. What do you want to capture or work through?');return;}
        if(r==='bad')failures++;
        if(r==='locked'||failures>=3){endedBy='pin_lockout';say(r==='locked'?'Voice access is locked for today. Goodbye.':'That PIN is not correct. Goodbye.');end('pin_lockout');return;}
        say('That PIN is not correct. Try again, then press pound.');
      });ctx.waitUntil(chain);return;
    }
    if(msg.type!=='prompt'||!msg.last||typeof msg.voicePrompt!=='string')return;
    if(verified)return turns.prompt(msg.voicePrompt);
    // Before the PIN: chat like a person (no data, no tools), capped per call.
    const text=msg.voicePrompt.slice(0,600);
    if(++chats>CHAT_CAP){say('Type your PIN and press pound to keep going.');return;}
    chain=chain.then(async()=>{const reply=await smallTalk(env,text,history);history.push({role:'user',content:text},{role:'assistant',content:reply});say(reply);}).catch(()=>say('I’m here. Type your PIN and press pound to unlock everything.'));
    ctx.waitUntil(chain);
  });
  return new Response(null,{status:101,webSocket:client});
}
