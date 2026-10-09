import {randomToken,hash} from './auth.js';
import {gfetch} from './gapi.js';
import {run,source,syncCalendar,notify,nowIso} from './service.js';
import {dayStart} from './core.js';
import {ruleTriage,modelTriage,alertText,clip,storedDomain,senderRule,demote,verified,domainOf} from './mail.js';
import {chargeAlert,recordCharge} from './finance.js';
import {markReplied} from './outreach.js';
import {isQuarantined} from './mailclean.js';
import {recordQuarantined} from './quarantine.js';
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=text=>Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
// Google tokens use their own key (TOKEN_ENC_KEY), not GATEWAY_KEY, so rotating the gateway key never breaks Google.
const AAD=new TextEncoder().encode('google_refresh');
async function encryptionKey(env){if(!env.TOKEN_ENC_KEY)throw new Error('TOKEN_ENC_KEY is not configured');return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.TOKEN_ENC_KEY)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function seal(env,value){const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:AAD},await encryptionKey(env),new TextEncoder().encode(value));return 'v1.'+b64(iv)+'.'+b64(encrypted);}
export async function unseal(env,value){const [version,iv,data]=String(value).split('.');if(version!=='v1'||!iv||!data)throw new Error('Unsupported token format; reconnect Google');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:AAD},await encryptionKey(env),unb64(data)));}
export async function beginGoogle(env,origin){
 if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET)throw new Error('Google OAuth client is not configured');
 const state=randomToken(),verifier=randomToken();await run(env,'INSERT INTO oauth_states VALUES(?,?,?)',await hash(state),verifier,new Date(Date.now()+600000).toISOString());
 const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
 for(const [k,v] of Object.entries({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:origin+'/oauth/google/callback',response_type:'code',scope:'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/calendar.events.owned',access_type:'offline',include_granted_scopes:'true',prompt:'select_account consent',state,code_challenge:b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),code_challenge_method:'S256'}))url.searchParams.set(k,v);
 return {url:url.href};
}
export async function finishGoogle(request,env){
 const url=new URL(request.url),state=await hash(url.searchParams.get('state')||'');
 const row=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING verifier').bind(state,nowIso()).first();
 if(!row||!url.searchParams.get('code'))return new Response('Google connection was not completed. Return to Beacon and try again.',{status:400});
 const response=await gfetch('POST','https://oauth2.googleapis.com/token',null,new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code:url.searchParams.get('code'),code_verifier:row.verifier,grant_type:'authorization_code',redirect_uri:url.origin+'/oauth/google/callback'}));
 if(!response.ok)throw new Error('Google token exchange failed');
 const tokens=await response.json();if(!tokens.refresh_token)throw new Error('Offline consent required');
 // Two slots: personal Gmail (calendar, mail, drafts) and UChicago (mail only). The account decides the slot.
 const email=tokens.access_token?await profileEmail(tokens.access_token):null,slot=isSchool(email)?ACCOUNTS.school:ACCOUNTS.personal;
 await saveAccount(env,slot,await seal(env,tokens.refresh_token),email);
 if(slot.calendar)await source(env,'calendar','not_connected','Google authorized. Initial sync is pending.');
 await source(env,slot.source,'not_connected',`${slot.label} authorized. Initial sync is pending.`);
 return Response.redirect(url.origin+'/?connected=google',303);
}
export const ACCOUNTS={
 personal:{key:'google_refresh',emailKey:'google_email',source:'gmail',label:'Personal Gmail',calendar:true,tag:''},
 school:{key:'google_refresh_school',emailKey:'google_email_school',source:'uchicago',label:'UChicago mail',calendar:false,tag:'UChicago · '}
};
export const isSchool=email=>/@(?:[a-z0-9-]+\.)*uchicago\.edu$/i.test(String(email||''));
async function profileEmail(token){try{const p=await get('https://gmail.googleapis.com/gmail/v1/users/me/profile',token);return typeof p.emailAddress==='string'?p.emailAddress.toLowerCase():null;}catch{return null;}}
async function saveAccount(env,slot,sealed,email){
 await run(env,'INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',slot.key,sealed);
 if(email)await run(env,'INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',slot.emailKey,email);
}
const setting=async(env,id)=>(await env.DB.prepare('SELECT value FROM settings WHERE id=?').bind(id).first())?.value||null;
// Drafts go to the account he names (personal by default).
export async function googleAccessToken(env,account='personal'){const c=await setting(env,(ACCOUNTS[account]||ACCOUNTS.personal).key);if(!c)throw new Error(account==='school'?'school-scope':'scope');return accessToken(env,c);}
export async function connectedAccounts(env){const out={};for(const [k,a] of Object.entries(ACCOUNTS))out[k]=await setting(env,a.key)?(await setting(env,a.emailKey)||'connected'):null;return out;}
async function accessToken(env,encrypted){
 const response=await gfetch('POST','https://oauth2.googleapis.com/token',null,new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:await unseal(env,encrypted),grant_type:'refresh_token'}));
 if(!response.ok)throw new Error('Reconnect Google');return (await response.json()).access_token;
}
// Invites Jackson hasn't accepted are someone else's claim on his time, and their text is untrusted: skip them.
export const unaccepted=e=>{const status=(e.attendees||[]).find(a=>a.self)?.responseStatus;return ['needsAction','declined'].includes(status)||(!!e.organizer&&!e.organizer.self&&status!=='accepted');};
// A Google event as the sync and the agent's calendar tools see it: timed or all-day (Chicago midnight to midnight), and
// whether he owns it (no organizer, or himself). Never description, location, attendees or links beyond htmlLink.
export const timed=e=>e.status!=='cancelled'&&!!(e.start?.dateTime||e.start?.date)&&!unaccepted(e);
export const eventRow=e=>({id:e.id,summary:e.summary||'',start:e.start.dateTime||dayStart(e.start.date),end:e.end?.dateTime||dayStart(e.end?.date||e.start.date),all_day:!e.start.dateTime,owned:!e.organizer||e.organizer.self===true});
export async function get(url,token){const r=await gfetch('GET',url,token);if(!r.ok){const reason=(await r.json().catch(()=>null))?.error?.errors?.[0]?.reason;throw new Error(`Google read failed (${r.status}${reason?' '+String(reason).replace(/[^\w]/g,'').slice(0,40):''})`);}return r.json();}
export async function syncGoogle(env){
 await migrateLegacy(env);
 for(const slot of Object.values(ACCOUNTS))await syncAccount(env,slot);
}
// A UChicago token saved in the personal slot (before two accounts existed) moves to the school slot once.
export async function migrateLegacy(env){
 const legacy=await setting(env,ACCOUNTS.personal.key);
 if(legacy&&!await setting(env,ACCOUNTS.personal.emailKey)){
  let email=null;try{email=await profileEmail(await accessToken(env,legacy));}catch{}
  if(isSchool(email)){await saveAccount(env,ACCOUNTS.school,legacy,email);await run(env,'DELETE FROM settings WHERE id=?',ACCOUNTS.personal.key);await source(env,'gmail','not_connected','Personal Gmail is not connected. Connect it in Connections.');}
  else if(email)await run(env,'INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',ACCOUNTS.personal.emailKey,email);
 }
}
async function syncAccount(env,slot){
 const credential=await setting(env,slot.key);if(!credential)return;
 let token;try{token=await accessToken(env,credential);}catch{if(slot.calendar)await source(env,'calendar','error','Reconnect Google to resume calendar sync.');await source(env,slot.source,'error',`Reconnect ${slot.label} to resume inbox checks.`);return;}
 if(slot.calendar)try{
  const from=new Date(Date.now()-86400000).toISOString(),to=new Date(Date.now()+15*86400000).toISOString();const events=[];let page;
  do{const url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');for(const [k,v] of Object.entries({timeMin:from,timeMax:to,singleEvents:'true',maxResults:'250',orderBy:'startTime',...(page?{pageToken:page}:{})}))url.searchParams.set(k,v);const result=await get(url,token);events.push(...(result.items||[]).filter(timed).map(e=>({...eventRow(e),description:e.description||'',web_link:e.htmlLink})));page=result.nextPageToken;if(events.length>500)throw new Error('Calendar page limit');}while(page);
  await syncCalendar(env,{from,to,events,complete:true});await source(env,'calendar','ok','Google Calendar read-only sync runs every 15 minutes.',to);
 }catch(e){if(!/held/.test(e?.message||''))await source(env,'calendar','error','Calendar sync failed; last imported blocks retained.');}
 try{
  const prior=await env.DB.prepare('SELECT last_success FROM sources WHERE id=?').bind(slot.source).first();
  const since=prior?.last_success?Math.floor(Date.parse(prior.last_success)/1000)-60:Math.floor(Date.now()/1000)-86400;
  let page,seen=0,modelCalls=0;const qstate={calls:0},account=slot===ACCOUNTS.school?'school':'personal';
  do{const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('q',`after:${since}`);url.searchParams.set('maxResults','50');if(page)url.searchParams.set('pageToken',page);const listing=await get(url,token);
   for(const item of listing.messages||[]){if(await env.DB.prepare('SELECT id FROM dedupe WHERE id=?').bind('gmail:'+item.id).first())continue;if(++seen>150)throw new Error('Inbox backlog: requires another pass');
    const message=await get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=In-Reply-To&metadataHeaders=List-Unsubscribe&metadataHeaders=Authentication-Results&metadataHeaders=Reply-To`,token);
    const headers=Object.fromEntries((message.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
    // Baseline existing messages on first connection without sorting or alerting on old mail.
    if(prior?.last_success){
      if((message.labelIds||[]).includes('SENT')){await run(env,'INSERT OR IGNORE INTO dedupe VALUES(?,?)','gmail:'+item.id,nowIso());continue;}
      // Quarantined senders (his choice): no normal alert; checked for emergencies and things that need him, reviewed Sundays.
      if(await isQuarantined(env,account,headers.from)){await recordQuarantined(env,account,item.id,headers,message.snippet||'',new Date(Number(message.internalDate)||Date.now()).toISOString(),qstate);await run(env,'INSERT OR IGNORE INTO dedupe VALUES(?,?)','gmail:'+item.id,nowIso());continue;}
      const domain=storedDomain(headers.from),rule=ruleTriage(headers,message.snippet||''),received=new Date(Number(message.internalDate)||Date.now()).toISOString();
      // Verified card alerts: parsed by code, never sent to the model, and their subject (amount, merchant) stays out of mail_items.
      const charge=!rule?.phishing&&!rule?.injection&&chargeAlert(headers,message.snippet||'',received);
      if(charge){await recordCharge(env,item.id,charge);await run(env,'INSERT OR IGNORE INTO mail_items(id,received_at,sender,subject,level,reason,verified,domain,account) VALUES(?,?,?,?,?,?,?,?,?)',item.id,received,clip(headers.from,200)||'(unknown sender)','[card alert — charge recorded]','ignore','Card charge alert; recorded in charges.',1,domain||null,account);await run(env,'INSERT OR IGNORE INTO dedupe VALUES(?,?)','gmail:'+item.id,nowIso());continue;}
      const t=demote(rule,await senderRule(env,domain),headers)||(++modelCalls<=25?await modelTriage(env,headers,message.snippet||'',slot.source==='uchicago'?'uchicago':'personal'):{level:'digest',reason:'Unsorted (per-run limit).'});
      // School records keep no subject: the subject alone can be the grade.
      await run(env,'INSERT OR IGNORE INTO mail_items(id,received_at,sender,subject,level,reason,verified,domain,account) VALUES(?,?,?,?,?,?,?,?,?)',item.id,received,clip(headers.from,200)||'(unknown sender)',t.school?'[school record — open it directly]':clip(headers.subject,300)||'(no subject)',t.level,t.reason,t.verified?1:0,domain||null,account);
      // A verified reply in a thread Jackson wrote in, from an outreach contact, stops that contact's follow-up nudges.
      if(headers['in-reply-to']&&!t.phishing&&!t.injection&&verified(headers,domainOf(headers.from)))await markReplied(env,domain,headers.from,received).catch(()=>null);
      if(t.level==='notify'||t.level==='phishing'){const a=alertText(headers,t);await notify(env,{id:'mail:'+item.id,title:slot.tag+a.title,body:a.body,kind:t.phishing?'phishing':'mail'});}
    }
    await run(env,'INSERT OR IGNORE INTO dedupe VALUES(?,?)','gmail:'+item.id,nowIso());
   }page=listing.nextPageToken;
  }while(page);
  await source(env,slot.source,'ok',`${slot.label} metadata checked every 15 minutes.`);
 }catch{await source(env,slot.source,'error','Inbox check failed or backlog exceeded the per-run limit. Last successful checkpoint retained.');}
}
