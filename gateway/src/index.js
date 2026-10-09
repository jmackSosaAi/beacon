import {beginGoogle,finishGoogle,syncGoogle} from './google.js';
import {syncCanvas} from './canvas.js';
import legacy from './legacy.js';
import {authenticate,hash,randomToken,sessionToken,sessionCookie,deviceLabel,rateLimited,SESSION_DAYS,validateTwilio} from './auth.js';
import {validateSubscription,cleanText,validInstant} from './core.js';
import {run,snapshot,capture,checkin,syncCalendar,subscribe,preferences,source,tick,nowIso,notify,setPaused} from './service.js';
import {converse,executeProposal,describeAction} from './conversation.js';
import {provenance} from './actions.js';
import {bridgeTwiml,contactList,saveContact,deleteContact} from './contacts.js';
import {incomingVoice,voiceSocket} from './voice.js';
import {telegramWebhook} from './telegram.js';
import {briefTwiml,deliverBrief,briefSocket} from './brief.js';
import {mealsCsv} from './meals.js';
import {unexported,markExported} from './notes.js';
import {checkGroupMe} from './groupme.js';
import {importSubscriptions} from './finance.js';
import {importOutreach} from './outreach.js';
import {claimJob,heartbeat,finishJob,uploadFile,nodeAlert} from './node.js';
import {scanPage,scanReport} from './mailscan.js';
import {kbSync} from './kb.js';
import {unsubscribe,quarantine} from './mailclean.js';
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function body(request){if(Number(request.headers.get('content-length')||0)>1000000)throw new Error('Request too large');const text=await request.text();if(text.length>1000000)throw new Error('Request too large');return JSON.parse(text);}
const tooMany=()=>json({error:'Too many attempts. Wait a while and try again.'},429);
// Clears both names so a browser still holding the pre-__Host- cookie drops it too.
const clearCookies=()=>{const h=new Headers({'content-type':'application/json','cache-control':'no-store'});h.append('set-cookie',sessionCookie('',0));h.append('set-cookie','jarvis_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');return h;};
async function route(request,env,ctx){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/oauth/google/callback'&&request.method==='GET'){if(await rateLimited(env,request,'oauth'))return tooMany();return finishGoogle(request,env);}
 if(path==='/healthz')return json({ok:true,service:'jarvis-gateway'});
 if(path==='/voice/incoming'&&request.method==='POST'){if(await rateLimited(env,request,'voice'))return tooMany();return incomingVoice(request,env);}
 if(path==='/voice/socket')return voiceSocket(request,env,ctx);
 if(path==='/voice/brief'&&request.method==='POST')return briefTwiml(request,env);
 if(path==='/voice/brief-socket')return briefSocket(request,env,ctx);
 if(path==='/voice/bridge'&&request.method==='POST')return bridgeTwiml(request,env);
 if(path==='/telegram/webhook'&&request.method==='POST')return telegramWebhook(request,env,ctx);
 // Twilio usage trigger (daily spend threshold): signed by Twilio, becomes a Telegram alert with a pause button.
 if(path==='/twilio/usage'&&request.method==='POST'){const form=Object.fromEntries(await request.formData());if(!await validateTwilio(request,env,form))return new Response('Forbidden',{status:403});
  const value=String(form.CurrentValue||'').replace(/[^\d.]/g,'').slice(0,12),limit=String(form.TriggerValue||'').replace(/[^\d.]/g,'').slice(0,12);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'twilio:usage-alert',value||null,nowIso());
  await notify(env,{id:`security:twilio:${String(form.IdempotencyToken||crypto.randomUUID()).slice(0,80)}`,title:'Twilio spending alert',body:`Twilio spend today passed $${limit||'?'} (now $${value||'?'}). If you didn’t expect calls, pause Beacon and check the Twilio console.`,kind:'security',urgent:true});
  return new Response('ok');}
 if(!path.startsWith('/api/')&&!['/call','/groupme/groups','/groupme/messages'].includes(path))return env.ASSETS.fetch(request);
 if(!['GET','HEAD'].includes(request.method)){const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return json({error:'Origin not allowed'},403);}
 if(path==='/api/login'&&request.method==='POST'){
  if(await rateLimited(env,request,'login'))return tooMany();
  const input=await body(request),token=cleanText(input.token,200),tokenHash=await hash(token),now=nowIso();
  const claimed=await run(env,'UPDATE login_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?',now,tokenHash,now);
  if(!claimed.meta.changes)return json({error:'Access link expired or already used. Generate a fresh link with the Beacon CLI.'},401);
  const session=randomToken(),device=deviceLabel(request.headers.get('User-Agent'));
  await run(env,'INSERT INTO sessions(token_hash,expires_at,created_at,last_seen_at,device) VALUES(?,?,?,?,?)',await hash(session),new Date(Date.now()+SESSION_DAYS*86400000).toISOString(),now,now,device);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'session:signed-in',device,now);
  await notify(env,{id:`security:signin:${crypto.randomUUID()}`,title:'New Beacon sign-in',body:`${device}. If this wasn’t you, tap Not me, then sign out all devices in Connections.`,kind:'security'});
  return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':sessionCookie(session,SESSION_DAYS*86400)}});
 }
 // Failed service/admin key attempts are capped per IP; once over, even a correct key waits out the window.
 const keyed=['X-Jarvis-Key','X-Jarvis-Admin-Key','X-Jarvis-Node-Key'].some(h=>request.headers.has(h));
 if(keyed&&await rateLimited(env,request,'key',false))return tooMany();
 const auth=await authenticate(request,env);
 if(keyed&&!['admin','service','node'].includes(auth))await rateLimited(env,request,'key');
 if(!auth)return json({error:'Sign in with your private access link.'},401);
 // The node key reaches only /api/node/*, and /api/node/* accepts only the node key.
 if(path.startsWith('/api/node/')!==(auth==='node'))return json({error:'Not allowed with this credential'},403);
 if(auth==='node'){
  if(request.method!=='POST')return json({error:'Not found'},404);
  if(path==='/api/node/claim')return json(await claimJob(env));
  if(path==='/api/node/heartbeat')return json(await heartbeat(env,await body(request)));
  if(path==='/api/node/result')return json(await finishJob(env,await body(request)));
  if(path==='/api/node/kb')return json(await kbSync(env,await body(request)));
  if(path==='/api/node/alert')return json(await nodeAlert(env,await body(request)));
  if(path==='/api/node/file')return json(await uploadFile(env,request,url.searchParams.get('id')));
  // Bytes of a running save_photo job's image, fetched from Telegram by the Worker (the node never holds the bot token).
  if(path==='/api/node/photo'){const {photoForJob}=await import('./photo.js');const p=await photoForJob(env,url.searchParams.get('id'));return new Response(p.bytes,{headers:{'content-type':p.mime}});}
  return json({error:'Not found'},404);
 }
 if(['/call','/groupme/groups','/groupme/messages'].includes(path)){
  if(auth!=='service')return json({error:'Service authentication required'},403);
  if(path==='/call'&&env.VOICE_ENABLED!=='true')return json({error:'Twilio number not activated'},503);
  return legacy.fetch(request,env,ctx);
 }
 // The laptop-only admin key: mint login links, read status, run the scheduler.
 if(auth==='admin'){
  if(path==='/api/access-link'&&request.method==='POST'){
   const token=randomToken();await run(env,'INSERT INTO login_tokens(token_hash,expires_at) VALUES(?,?)',await hash(token),new Date(Date.now()+15*60000).toISOString());
   await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'access-link:minted',null,nowIso());
   await notify(env,{id:`security:link:${crypto.randomUUID()}`,title:'New Beacon sign-in link created',body:'If this wasn’t you, open Beacon and sign out, then rotate the admin key.',kind:'security'});
   return json({url:`${url.origin}/#access=${token}`,expires_in_minutes:15});
  }
  if(path==='/api/snapshot'&&request.method==='GET')return json(await snapshot(env));
  // Step-up link (beacon.mjs step-up): single use, 15 minutes, claimed by an already signed-in web session.
  if(path==='/api/step-up'&&request.method==='POST'){
   const token=randomToken();await run(env,'INSERT INTO step_up_tokens(token_hash,expires_at) VALUES(?,?)',await hash(token),new Date(Date.now()+15*60000).toISOString());
   await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'step-up:minted',null,nowIso());
   await notify(env,{id:`security:stepup:${crypto.randomUUID()}`,title:'Beacon step-up link created',body:'Used to unpause, reconnect Google or edit contacts. If this wasn’t you, rotate the admin key.',kind:'security'});
   return json({url:`${url.origin}/#stepup=${token}`,expires_in_minutes:15});
  }
  if(path==='/api/notes/export'&&request.method==='GET')return json({notes:await unexported(env)});
  if(path==='/api/notes/mark-exported'&&request.method==='POST')return json(await markExported(env,(await body(request)).ids));
  if(path==='/api/tick'&&request.method==='POST'){await tick(env);return json({ok:true});}
  if(path==='/api/sync/canvas'&&request.method==='POST')return json(await syncCanvas(env));
  // Inbox scout (scripts/mail-scout.mjs): one page of bulk-sender tallies per call, then the report. Read-only.
  if(path==='/api/mail/jobs'&&request.method==='POST'){const input=await body(request);try{const {jobMailPage}=await import('./mailscan.js');return json(await jobMailPage(env,input));}catch(e){return json({error:String(e?.message||'search failed').slice(0,120)},502);}}
  if(path==='/api/mail/scan'&&request.method==='POST'){const input=await body(request);try{return json(await scanPage(env,input));}catch(e){return json({error:String(e?.message||'scan failed').slice(0,120)},502);}}
  // Knowledge base refresh from the laptop (scripts/kb-index.mjs): repo markdown chunks, never finance/.
  if(path==='/api/kb/sync'&&request.method==='POST')return json(await kbSync(env,await body(request)));
  // Agent eval replay (scripts/agent-eval.mjs): counts, failing ask ids and code-built failure notes; never model replies.
  if(path==='/api/eval/result'&&request.method==='POST')return json(await (await import('./evals.js')).recordEval(env,await body(request)));
  // Credential expiry dates (names and dates only), updated by laptop scripts after a renewal.
  if(path==='/api/credentials'&&request.method==='POST'){const input=await body(request),id=cleanText(input.id,40),at=input.expires_at;if(!validInstant(at))throw new Error('Invalid date');const r=await run(env,'UPDATE credential_expiry SET expires_at=? WHERE id=?',new Date(at).toISOString(),id);return json({updated:r.meta.changes});}
  if(path==='/api/mail/unsubscribe'&&request.method==='POST')return json(await unsubscribe(env,await body(request)));
  if(path==='/api/mail/quarantine'&&request.method==='POST')return json(await quarantine(env,await body(request)));
  if(path==='/api/mail/scan-report'&&request.method==='GET')return json({senders:await scanReport(env,url.searchParams.get('account'))});
  // Derived subscription list (name, amount, cadence, billing day) from the local import script; never statements.
  if(path==='/api/import/subscriptions'&&request.method==='POST')return json(await importSubscriptions(env,await body(request)));
  // Outreach rows from the local tracker/outreach.md (scripts/import-outreach.mjs): names, orgs, dates and status only.
  if(path==='/api/import/outreach'&&request.method==='POST')return json(await importOutreach(env,await body(request)));
  if(path==='/api/brief'&&request.method==='POST'){const kind=(await body(request)).kind==='evening'?'evening':'morning';return json(await deliverBrief(env,kind));}
  return json({error:'Not found'},404);
 }
 // The service key reaches only import/scheduler routes, never user data or actions.
 if(auth==='service'){
  if(path==='/api/sync/calendar'&&request.method==='POST')return json(await syncCalendar(env,await body(request)));
  if(path==='/api/sync/tasks'&&request.method==='POST'){
   const input=await body(request);if(!Array.isArray(input.tasks)||input.tasks.length>100)throw new Error('Up to 100 tasks per import');
   const results=[];for(const task of input.tasks)results.push(await capture(env,task,cleanText(input.source,100)));return json({imported:results.length});
  }
  if(path==='/api/source'&&request.method==='POST'){const input=await body(request);if(!['ok','blocked','not_connected','error','snapshot'].includes(input.status))throw new Error('Unknown source status');await source(env,cleanText(input.id,60),input.status,cleanText(input.detail,1000),input.coverage_end||null);return json({ok:true});}
  if(path==='/api/tick'&&request.method==='POST'){await tick(env);return json({ok:true});}
  return json({error:'Service key cannot use this route'},403);
 }
 // Everything below requires a signed-in user session.
 if(auth!=='user')return json({error:'Sign in with your private access link.'},401);
 // Step-up: a fresh laptop-minted link, claimed by this signed-in session, unlocks the sensitive routes below for 15 minutes.
 // Telegram approvals are unchanged (owner ID + webhook secret is a separate factor); only web routes are gated, so nothing locks him out of capture or approvals.
 if(path==='/api/step-up/claim'&&request.method==='POST'){
  const now=nowIso(),claimed=await run(env,'UPDATE step_up_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?',now,await hash(cleanText((await body(request)).token,200)),now);
  if(!claimed.meta.changes)return json({error:'Step-up link expired or already used. Run: node gateway/scripts/beacon.mjs step-up'},401);
  await run(env,'UPDATE sessions SET stepup_until=? WHERE token_hash=?',new Date(Date.now()+15*60000).toISOString(),await hash(sessionToken(request)));
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'step-up:claimed',null,now);
  return json({ok:true,minutes:15});
 }
 const STEP_UP=['/api/resume','/api/breaker/reset','/api/google/connect','/api/contacts/save','/api/contacts/delete'];
 if(STEP_UP.includes(path)&&request.method==='POST'){
  const s=await env.DB.prepare('SELECT stepup_until FROM sessions WHERE token_hash=?').bind(await hash(sessionToken(request))).first();
  if(!s?.stepup_until||s.stepup_until<=nowIso()){await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'step-up:required',path.slice(5),nowIso());return json({error:'This needs a step-up. On your laptop run: node gateway/scripts/beacon.mjs step-up',stepup:true},403);}
 }
 if(path==='/api/google/connect'&&request.method==='POST')return json(await beginGoogle(env,url.origin));
 // Contacts: full details in the web app; saving and deleting need step-up. No other code path edits contacts.
 if(path==='/api/contacts'&&request.method==='GET')return json({contacts:await contactList(env)});
 if(path==='/api/contacts/save'&&request.method==='POST')return json(await saveContact(env,await body(request)));
 if(path==='/api/contacts/delete'&&request.method==='POST')return json(await deleteContact(env,cleanText((await body(request)).id,40)));
 // Application tracker (markdown in the repo is the source of truth).
 if(path==='/api/tracker'&&request.method==='GET')return json({rows:await (await import('./tracker.js')).trackerRows(env),statuses:(await import('./tracker.js')).STATUSES});
 if(path==='/api/tracker/status'&&request.method==='POST')return json(await (await import('./tracker.js')).setStatus(env,await body(request)));
 if(path==='/api/snapshot'&&request.method==='GET')return json(await snapshot(env));
 if(path==='/api/logout'&&request.method==='POST'){
  const token=sessionToken(request);if(token)await run(env,'DELETE FROM sessions WHERE token_hash=?',await hash(token));
  return new Response('{}',{headers:clearCookies()});
 }
 if(path==='/api/logout-all'&&request.method==='POST'){
  const removed=await run(env,'DELETE FROM sessions');
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'session:revoked-all',String(removed.meta.changes),nowIso());
  return new Response(JSON.stringify({ok:true,signedOut:removed.meta.changes}),{headers:clearCookies()});
 }
 if(path==='/api/capture'&&request.method==='POST')return json(await capture(env,await body(request)),201);
 const update=path.match(/^\/api\/(blocks|tasks)\/([^/]+)\/checkin$/);
 if(update&&request.method==='POST')return json(await checkin(env,update[1],decodeURIComponent(update[2]),await body(request)));
 if(path==='/api/chat'&&request.method==='POST'){const r=await converse(env,(await body(request)).text,'web',{deadline:Date.now()+25000});return json({...r,readback:describeAction(r.action),provenance:r.action?provenance(r.action,'web'):''});}
 // Log page (M7): newest 100 interaction rows with outcome and signals; filters by kind, route, channel, since, words and trouble. Labels are one-tap corrections.
 if(path==='/api/interactions'&&request.method==='GET'){const q=url.searchParams,{listInteractions}=await import('./interactions.js');return json({interactions:await listInteractions(env,{kind:q.get('kind'),route:q.get('route'),channel:q.get('channel'),since:q.get('since'),q:q.get('q'),trouble:q.get('trouble')==='1',limit:q.get('limit')})});}
 if(path==='/api/interactions/label'&&request.method==='POST'){const input=await body(request);return json(await (await import('./interactions.js')).labelInteraction(env,cleanText(input.id,64),input.label));}
 // Actions view: the newest 50 audit rows (what, target id, when). Audit has no message bodies.
 if(path==='/api/actions'&&request.method==='GET')return json({actions:(await env.DB.prepare('SELECT action,target_id,created_at FROM audit ORDER BY created_at DESC LIMIT 50').all()).results});
 if(path==='/api/meals.csv'&&request.method==='GET')return new Response(await mealsCsv(env),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="beacon-food-log.csv"','cache-control':'no-store'}});
 if(path==='/api/pause'&&request.method==='POST'){await setPaused(env,true,'web');return json({paused:true});}
 if(path==='/api/resume'&&request.method==='POST'){await setPaused(env,false,'web');return json({paused:false});}
 // Circuit breaker: a paused action type resumes only from the signed-in web app.
 if(path==='/api/breaker/reset'&&request.method==='POST'){const type=cleanText((await body(request)).type,30);return json(await (await import('./breaker.js')).resetBreaker(env,type));}
 if(path==='/api/confirm'&&request.method==='POST')return json(await executeProposal(env,(await body(request)).proposal_id,'web'));
 if(path==='/api/subscribe'&&request.method==='POST'){const sub=await body(request);if(!validateSubscription(sub))return json({error:'Unsupported push subscription'},400);return json(await subscribe(env,sub));}
 if(path==='/api/push-test'&&request.method==='POST'){await notify(env,{id:`test:${crypto.randomUUID()}`,title:'Beacon is connected',body:'Your device can receive check-ins. Tap to open Beacon.',kind:'test'});return json({ok:true});}
 if(path==='/api/read'&&request.method==='POST'){const {id}=await body(request);await run(env,'UPDATE notifications SET read_at=? WHERE id=?',nowIso(),cleanText(id,300));return json({ok:true});}
 if(path==='/api/preferences'&&request.method==='POST'){
  const input=await body(request),prefs=await preferences(env);
  for(const k of ['morning','evening','weekly'])if(input[k]!==undefined){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input[k]))throw new Error('Invalid time');prefs[k]=input[k];}
  if(typeof input.notifications==='boolean')prefs.notifications=input.notifications;
  if(typeof input.briefCall==='boolean')prefs.briefCall=input.briefCall;
  if(input.chargeAlertMin!==undefined){if(typeof input.chargeAlertMin!=='number'||!(input.chargeAlertMin>=0&&input.chargeAlertMin<=100000))throw new Error('Invalid charge alert threshold');prefs.chargeAlertMin=input.chargeAlertMin;}
  if(input.llmDailyTokenCap!==undefined){if(!Number.isInteger(input.llmDailyTokenCap)||input.llmDailyTokenCap<10000||input.llmDailyTokenCap>5000000)throw new Error('Invalid token cap');prefs.llmDailyTokenCap=input.llmDailyTokenCap;}
  prefs.automaticRescheduling=false;prefs.persianTargetMinutes=360;
  await run(env,"UPDATE settings SET value=? WHERE id='preferences'",JSON.stringify(prefs));return json(prefs);
 }
 return json({error:'Not found'},404);
}
export default {
 async fetch(request,env,ctx){try{return await route(request,env,ctx);}catch(error){console.error(JSON.stringify({event:'request_failed',path:new URL(request.url).pathname,type:error?.constructor?.name}));return json({error:'Request could not be completed. Check the fields and try again.'},400);}},
 async scheduled(event,env,ctx){ctx.waitUntil((async()=>{if(new Date(event.scheduledTime).getUTCMinutes()%15===0){await syncGoogle(env);await syncCanvas(env).catch(()=>null);await checkGroupMe(env,new Date(event.scheduledTime)).catch(()=>console.error(JSON.stringify({event:'groupme_failed'})));}await tick(env,new Date(event.scheduledTime));await (await import('./photo.js')).autoSortPhotos(env,event.scheduledTime).catch(()=>console.error(JSON.stringify({event:'photo_sort_failed'})));})().catch(async()=>{await source(env,'scheduler','error','Scheduled check failed. Inspect deployment logs.');console.error(JSON.stringify({event:'scheduler_failed'}));}));}
};
