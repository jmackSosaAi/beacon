import {equalSecret} from './auth.js';
import {run,nowIso,setPaused,isPaused,health} from './service.js';
import {converse,executeProposal,describeAction} from './conversation.js';
import {tg,sendTelegram} from './tgapi.js';
import {gatherNews,newsDigest} from './news.js';
import {undoNote,recentNotes} from './notes.js';
import {undoMeal,dayTotals,targets,totalsLine} from './meals.js';
import {localParts} from './core.js';
import {recordFeedback,rulesText,removeRule} from './mail.js';
import {usageToday,usageLine} from './budget.js';
import {contactNames} from './contacts.js';
import {provenance} from './actions.js';
import {jobsText,nodeText,cancelJobs} from './node.js';
import {logTurn,markOutcome,logText} from './interactions.js';

const audit=(env,action,target=null)=>run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),action,target,nowIso());

// Webhook: secret header, one delivery per update_id, owner's private chat only. Everyone else is logged and ignored.
export async function telegramWebhook(request,env,ctx){
  if(!env.TELEGRAM_WEBHOOK_SECRET||!await equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET))return new Response('Forbidden',{status:403});
  const update=await request.json().catch(()=>null);
  if(!update||!Number.isInteger(update.update_id))return new Response('ok');
  const fresh=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`tg:${update.update_id}`,nowIso());
  if(!fresh.meta.changes)return new Response('ok');
  const msg=update.message,cb=update.callback_query;
  const from=String((msg||cb)?.from?.id||''),chatType=(msg?.chat||cb?.message?.chat)?.type;
  if(!env.TELEGRAM_OWNER_ID||from!==String(env.TELEGRAM_OWNER_ID)||chatType!=='private'){await audit(env,'telegram:ignored',from.slice(0,20)||null);return new Response('ok');}
  ctx.waitUntil(handle(env,msg,cb).catch(error=>{
    console.error(JSON.stringify({event:'telegram_handler_failed',type:error?.constructor?.name}));
    return sendTelegram(env,'Something went wrong. Nothing was changed unless I said so.');
  }));
  return new Response('ok');
}

async function handle(env,msg,cb){
  if(cb)return handleButton(env,cb);
  // Photos and image files: sorted into his life folder (photo.js). A caption sorts it now; otherwise bucket buttons, his
  // next message, or Beacon after 5 minutes. A forwarded photo's caption is someone else's words, so it is dropped.
  if(msg&&(msg.photo||msg.document)&&typeof msg.text!=='string'){
    const t0=Date.now(),{receivePhoto,logPhoto}=await import('./photo.js');
    if(msg.caption)await tg(env,'sendChatAction',{chat_id:msg.chat.id,action:'typing'});
    const r=await receivePhoto(env,msg),said=msg.forward_origin||msg.forward_from||msg.forward_date?null:msg.caption||null;
    await logPhoto(env,said,r.reply).catch(()=>null);
    if(env.AGENT_MODE==='true')await logTurn(env,{channel:'telegram',route:'photo',text:`[photo]${said?` ${String(said).slice(0,500)}`:''}`,reply:r.reply,action_type:r.cards?.[0]?.action.type||null,proposal_id:r.cards?.[0]?.id||null,latency_ms:Date.now()-t0}).catch(()=>null);
    await sendTelegram(env,r.reply,r.markup?{reply_markup:r.markup}:{});
    for(const c of r.cards||[])await proposalCard(env,c.action,c.id,'Telegram');
    return;
  }
  if(!msg||typeof msg.text!=='string')return sendTelegram(env,'I can read text and photos. Send it as a message or a photo.');
  // Forwarded content came from someone else: information, never instructions.
  if(msg.forward_origin||msg.forward_from||msg.forward_date)return sendTelegram(env,'Forwarded messages are treated as information, not instructions, so I won’t act on them.');
  const text=msg.text.trim();
  // His next message right after a photo (10 minutes, nothing said in between) says what it is and where it goes.
  if(!text.startsWith('/')){
    const {pendingFollowup,sortPhoto,logPhoto}=await import('./photo.js'),p=await pendingFollowup(env);
    if(p){
      await tg(env,'sendChatAction',{chat_id:msg.chat.id,action:'typing'});const t0=Date.now(),r=await sortPhoto(env,p.id,{text});
      await logPhoto(env,text,r.reply).catch(()=>null);
      if(env.AGENT_MODE==='true')await logTurn(env,{channel:'telegram',route:'photo',text,reply:r.reply,action_type:r.cards[0]?.action.type||null,proposal_id:r.cards[0]?.id||null,latency_ms:Date.now()-t0}).catch(()=>null);
      await sendTelegram(env,r.reply);for(const c of r.cards)await proposalCard(env,c.action,c.id,'Telegram');return;
    }
  }
  // Slash commands are logged too (route 'slash'): a command right after a natural ask about the same thing is a correction.
  const t0=Date.now(),r=await command(env,text);
  if(r===undefined)return chat(env,text);
  if(env.AGENT_MODE==='true')await logTurn(env,{channel:'telegram',route:'slash',text,reply:r,latency_ms:Date.now()-t0}).catch(()=>null);
  return r?sendTelegram(env,r):null;
}
// Commands are answered by code before any model call. Returns the reply text ('' when it already went out), or undefined for a chat turn.
async function command(env,text){
  if(/^\/stop\b/i.test(text)){await setPaused(env,true,'telegram');return ('⏸ Paused. No action will run until you resume in the Beacon web app.');}
  if(/^\/resume\b/i.test(text))return ('For safety, resuming only works in the Beacon web app.');
  if(/^\/status\b/i.test(text)){
    const sources=(await health(env)).map(s=>`${s.id}: ${s.status}`).join('\n');
    return (`${await isPaused(env)?'⏸ Paused':'▶ Running'}\n${sources}\n${usageLine(await usageToday(env))}`);
  }
  if(/^\/food\b/i.test(text)){
    const today=await dayTotals(env,localParts().date),goal=await targets(env);
    const list=today.meals.map(m=>`• ${localParts(new Date(m.eaten_at)).time} ${m.description} (${m.calories} cal, ${m.protein_g}g P)`).join('\n');
    return (`🍽 Today: ${totalsLine(today,goal)}${list?`\n${list}`:''}\nFull log (spreadsheet): Beacon web app → Food → Download CSV.`);
  }
  const target=/^\/target\s+(\d{3,4})(?:\s+(\d{2,3}))?\b/i.exec(text);
  if(target){
    const row=await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first(),prefs=JSON.parse(row.value);
    prefs.calorieTarget=Number(target[1]);if(target[2])prefs.proteinTarget=Number(target[2]);
    await run(env,"UPDATE settings SET value=? WHERE id='preferences'",JSON.stringify(prefs));
    return (`🎯 Daily target: ${prefs.calorieTarget} calories${prefs.proteinTarget?`, ${prefs.proteinTarget}g protein`:''}.`);
  }
  const unrule=/^\/rules\s+remove\s+([a-z0-9.-]{1,120})\s*$/i.exec(text);
  if(unrule)return (await removeRule(env,unrule[1].toLowerCase())?`Removed. Mail from ${unrule[1].toLowerCase()} is sorted normally again.`:'No rule for that domain. /rules lists them.');
  if(/^\/rules\b/i.test(text))return (await rulesText(env));
  // Names only: numbers and addresses stay in D1 and the web app.
  if(/^\/contacts\b/i.test(text))return (await contactNames(env));
  const list=/^\/(notes|feedback)\b/i.exec(text);
  if(list){const kind=list[1].toLowerCase()==='notes'?'note':'feedback',rows=await recentNotes(env,kind);return (rows.length?`${kind==='note'?'🗒 Notes':'🛠 Feedback'} (latest ${rows.length})\n${rows.map(r=>`• ${r.text.slice(0,200)}${r.exported_at?'':' (not exported yet)'}`).join('\n')}`:`No ${kind==='note'?'notes':'feedback'} yet. Say "note: …" or "feedback: …" by call or here.`);}
  // /search <words>: the knowledge base (repo markdown), answered by code.
  const search=/^\/search\s+(.{2,200})$/i.exec(text);
  if(search)return (await (await import('./kb.js')).kbText(env,search[1]));
  if(/^\/tracker\b/i.test(text))return (await (await import('./tracker.js')).trackerText(env).catch(()=>'Couldn’t read the tracker from GitHub right now.'));
  if(/^\/jobs\b/i.test(text))return (await jobsText(env));
  if(/^\/node\b/i.test(text))return (await nodeText(env));
  if(/^\/cancel\b/i.test(text)){const n=await cancelJobs(env);return (n?`✖ Cancelled ${n} Mac job${n===1?'':'s'}. A running task is stopped at its next check-in.`:'No Mac jobs to cancel.');}
  if(/^\/news\b/i.test(text)){const d=await newsDigest(env,await gatherNews());return (d?d.text:'No fresh headlines right now.');}
  const floor=/^\/prestige(?:\s+([1-5]))?\b/i.exec(text);
  if(floor){
    const row=await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first(),prefs=JSON.parse(row.value);
    if(floor[1]){prefs.prestigeMin=Number(floor[1]);await run(env,"UPDATE settings SET value=? WHERE id='preferences'",JSON.stringify(prefs));}
    return (`🎯 Job scout sends roles at prestige ${prefs.prestigeMin||4}+ (5 elite, 4 strong, 3 solid). Change with /prestige 3, 4 or 5.`);
  }
  const career=/^\/career(?:\s+(on|off|now))?\b/i.exec(text);
  if(career){
    if(career[1]?.toLowerCase()==='now'){const r=await (await import('./brief.js')).deliverCareer(env);return r?.called?'':'Career update sent above.';}
    const row=await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first(),prefs=JSON.parse(row.value);
    if(career[1]){prefs.careerCall=career[1].toLowerCase()==='on';await run(env,"UPDATE settings SET value=? WHERE id='preferences'",JSON.stringify(prefs));}
    return (`💼 Career update: Mon 11:30 and Thu 11:00, ${prefs.careerCall===false?'Telegram only':'call + Telegram'}. /career off, /career on, /career now.`);
  }
  const calls=/^\/calls\s+(on|off)\b/i.exec(text);
  if(calls){
    const row=await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first(),prefs=JSON.parse(row.value);
    prefs.briefCall=calls[1].toLowerCase()==='on';await run(env,"UPDATE settings SET value=? WHERE id='preferences'",JSON.stringify(prefs));
    return (prefs.briefCall?'📞 Briefs will also come as a phone call.':'Briefs will come here only, no calls.');
  }
  if(/^\/log\b/i.test(text))return logText(env,/^\/log\s+trouble\b/i.test(text));
  if(/^\/(start|help)\b/i.test(text))return ('Beacon is connected. Tell me something to capture, report progress, or ask what’s next.\n/status shows source health and today’s AI use.\nSay "note: …" or "feedback: …" anytime (/notes, /feedback). Tell me what you ate to log it. /food shows today, /target 2200 180 sets calories and protein.\n/news gets the latest headlines.\n/rules lists email sender rules from your 👎 votes.\n/contacts lists saved contacts. Ask me to add one, call one, or draft an email to one.\nStart with "prompt the server:" (or "on my Mac:", "deep work:") to send a task to your Mac on your Claude subscription; you approve it first. Ask me to send you a file. /jobs, /node, /cancel.\n/calls on|off toggles brief phone calls.\n/log shows the last 20 turns, /log trouble this week’s worst.\n/stop pauses all actions immediately.');
}
async function chat(env,text){
  // Agent turns run under the 18 s Telegram deadline (waitUntil is cut ~30 s after the response) and show "typing…" before each planner call.
  const result=await converse(env,text,'telegram',{deadline:Date.now()+18000,onPlanner:()=>tg(env,'sendChatAction',{chat_id:Number(env.TELEGRAM_OWNER_ID),action:'typing'})});
  if(result.note_id)return sendTelegram(env,result.reply,{reply_markup:{inline_keyboard:[[{text:'Undo',callback_data:`n:${result.note_id}:u`}]]}});
  if(result.undo_id)return sendTelegram(env,result.reply,{reply_markup:{inline_keyboard:[[{text:'Undo',callback_data:`u:${result.undo_id}`}]]}});
  if(result.meal_ids?.length)return sendTelegram(env,result.reply,{reply_markup:{inline_keyboard:[result.meal_ids.map((id,i)=>({text:result.meal_ids.length>1?`Undo ${i+1}`:'Undo',callback_data:`m:${id}:u`}))]}});
  await sendTelegram(env,result.reply);
  if(!result.proposal_id)return;
  return proposalCard(env,result.action,result.proposal_id,'Telegram');
}
// The card text is generated by code from the validated action, not by the model.
// Provenance (SAFETY rule 3): who asked, where it goes, the exact content and the tier, all from code.
export function proposalCard(env,action,id,via){
  return sendTelegram(env,`Proposed:\n${provenance(action,String(via).toLowerCase())}\nExpires in 10 minutes.`,
    {reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:`p:${id}:a`},{text:'Cancel',callback_data:`p:${id}:c`}]]}});
}

async function handleButton(env,cb){
  await tg(env,'answerCallbackQuery',{callback_query_id:cb.id});
  if(cb.data==='s:pause'&&cb.message){await setPaused(env,true,'telegram-alert');return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n⏸ Beacon paused. Resume in the web app once you've checked things.`});}
  const note=/^n:([0-9a-f-]{36}):u$/.exec(cb.data||'');
  if(note&&cb.message){const ok=await undoNote(env,note[1]);return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${ok?'↩️ Removed.':'Could not undo (already exported).'}`});}
  const meal=/^m:([0-9a-f-]{36}):u$/.exec(cb.data||'');
  if(meal&&cb.message){const ok=await undoMeal(env,meal[1]);return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${ok?'↩️ Removed from your log.':'Could not undo (older than 24 hours or already removed).'}`});}
  // 👍/👎 on an email alert: recorded against the stored row; the buttons are removed by the edit.
  const vote=/^f:([A-Za-z0-9_-]{1,40}):(m|i)$/.exec(cb.data||'');
  // On a digest with several senders, only the voted row's buttons go away; the others stay tappable.
  if(vote&&cb.message){const note=await recordFeedback(env,vote[1],vote[2]==='m'?'matters':'ignore'),rows=(cb.message.reply_markup?.inline_keyboard||[]).filter(r=>!r.some(b=>String(b.callback_data).startsWith(`f:${vote[1]}:`)));return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${note||'That email is no longer on file.'}`,link_preview_options:{is_disabled:true},...(rows.length?{reply_markup:{inline_keyboard:rows}}:{})});}
  // Scout "Prep N": propose the application-package agent task; approval runs through the normal card.
  const sp=/^sp:(\d{1,12})$/.exec(cb.data||'');
  if(sp&&cb.message){
    const action=await (await import('./scout.js')).prepProposal(env,sp[1]);if(!action)return sendTelegram(env,'That posting is no longer on file.');
    const {validateAction,propose}=await import('./conversation.js'),v=validateAction(action,{});const id=await propose(env,v,'telegram');
    return proposalCard(env,v,id,'Telegram');
  }
  // Quarantine nudge: Unsubscribe (one-click) or Keep, decided once.
  const qn=/^qn:([0-9a-f]{8}):(u|k)$/.exec(cb.data||'');
  if(qn&&cb.message){const note=await (await import('./quarantine.js')).decideNudge(env,qn[1],qn[2]);return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${note}`,link_preview_options:{is_disabled:true}});}
  // Photo bucket buttons: sort that photo now (or let Beacon decide); the buttons go away.
  const ph=/^ph:([0-9a-f]{12}):(class|personal|career|reminder|other|auto)$/.exec(cb.data||'');
  if(ph&&cb.message){
    await tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${ph[2]==='auto'?'✨ Sorting it…':'Sorting it…'}`});
    const {sortPhoto}=await import('./photo.js'),r=await sortPhoto(env,ph[1],{bucket:ph[2]});
    await sendTelegram(env,r.reply);for(const c of r.cards)await proposalCard(env,c.action,c.id,'Telegram');return;
  }
  // Undo of an Auto action (tasks, calendar) within 24 hours, from its stored before-image.
  const undo=/^u:([0-9a-f]{8})$/.exec(cb.data||'');
  if(undo&&cb.message){const note=await (await import('./tasks.js')).undoAction(env,undo[1]);if(note.startsWith('↩️'))await markOutcome(env,{undo_id:undo[1]},'undone','button:telegram').catch(()=>null);return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${note}`});}
  const match=/^p:([0-9a-f-]{36}):(a|c)$/.exec(cb.data||'');
  if(!match||!cb.message)return;
  const [,id,choice]=match,edit=suffix=>tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n${suffix}`});
  if(choice==='c'){await run(env,'UPDATE proposals SET used_at=? WHERE id=? AND used_at IS NULL',nowIso(),id);await audit(env,'proposal:cancelled:telegram',id);await markOutcome(env,{proposal_id:id},'cancelled','button:telegram').catch(()=>null);return edit('✖ Cancelled.');}
  try{const r=await executeProposal(env,id,'telegram');if(r?.undo_id)return tg(env,'editMessageText',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,text:`${cb.message.text||''}\n\n✓ ${r.reply}`,reply_markup:{inline_keyboard:[[{text:'Undo',callback_data:`u:${r.undo_id}`}]]}});return edit(r?.reply?`✓ ${r.reply}`:'✓ Done.');}
  catch(error){return edit(`✖ Not done: ${String(error?.message||'error').slice(0,120)}`);}
}
