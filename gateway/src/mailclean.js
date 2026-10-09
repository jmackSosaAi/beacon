// Inbox cleanup Jackson picks from the scout report (admin key, laptop only).
// Unsubscribe: RFC 8058 one-click POST to the sender's own List-Unsubscribe https URL; nothing else.
// Quarantine: a Gmail filter (skip inbox, label "Quarantine"). Never deletes, trashes or sends mail (SAFETY rule 7).
import {run,nowIso} from './service.js';
import {googleAccessToken,get} from './google.js';
import {gfetch} from './gapi.js';

const ALLOWED=[['GET',/^\/gmail\/v1\/users\/me\/labels$/],['POST',/^\/gmail\/v1\/users\/me\/labels$/],['POST',/^\/gmail\/v1\/users\/me\/settings\/filters$/]];
async function gmailSettings(env,account,method,path,payload){
  if(!ALLOWED.some(([m,p])=>m===method&&p.test(path)))throw new Error('Gmail call not allowed');
  const r=await gfetch(method,'https://gmail.googleapis.com'+path,await googleAccessToken(env,account),payload);
  if(r.status===403||r.status===401)throw new Error('filter-scope');
  if(!r.ok)throw new Error(`gmail-${r.status}`);
  return r.json();
}
// An address, or "@domain" for everything from a domain (quarantine only).
const SENDER=/^(?:[a-z0-9._%+-]{1,100})?@[a-z0-9.-]{1,150}\.[a-z]{2,}$/;
const senders=list=>{if(!Array.isArray(list)||!list.length||list.length>100)throw new Error('1-100 senders');return list.map(s=>String(s).trim().toLowerCase()).filter(s=>SENDER.test(s));};
const accountOf=a=>a==='school'?'school':'personal';
const audit=(env,action,target)=>run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),action,String(target).slice(0,200),nowIso());

// The https URL from the newest List-Unsubscribe header, only when the sender declares one-click (RFC 8058).
export function oneClickUrl(headers){
  if(!/List-Unsubscribe=One-Click/i.test(headers['list-unsubscribe-post']||''))return null;
  const m=/<(https:\/\/[^>\s]+)>/i.exec(headers['list-unsubscribe']||'');if(!m)return null;
  try{const u=new URL(m[1]);return u.protocol==='https:'&&!u.username&&!u.password&&!/^[\d.]+$|^\[/.test(u.hostname)?u.href:null;}catch{return null;}
}
export async function unsubscribe(env,input){
  const account=accountOf(input?.account),token=await googleAccessToken(env,account),out=[];
  for(const sender of senders(input?.senders).filter(s=>!s.startsWith('@'))){
    try{
      const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('q',`from:${sender}`);url.searchParams.set('maxResults','1');
      const id=(await get(url,token)).messages?.[0]?.id;if(!id){out.push({sender,status:'no recent mail'});continue;}
      const m=await get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`,token);
      const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value])),target=oneClickUrl(headers);
      if(!target){out.push({sender,status:'manual',link:/<(https:[^>\s]+)>/i.exec(headers['list-unsubscribe']||'')?.[1]||null});continue;}
      // No cookies or credentials; the body is the fixed RFC 8058 value.
      const r=await fetch(target,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click',redirect:'manual',signal:AbortSignal.timeout(15000)});
      const ok=r.status<400;await audit(env,`mail:unsubscribe:${ok?'ok':'failed'}:${account}`,sender);
      out.push({sender,status:ok?'unsubscribed':`failed (${r.status})`});
    }catch(e){out.push({sender,status:`error: ${String(e.message).slice(0,60)}`});}
  }
  return {account,results:out};
}
export async function quarantine(env,input){
  const account=accountOf(input?.account),out=[];
  const labels=(await gmailSettings(env,account,'GET','/gmail/v1/users/me/labels')).labels||[];
  const label=labels.find(l=>l.name==='Quarantine')||await gmailSettings(env,account,'POST','/gmail/v1/users/me/labels',{name:'Quarantine',labelListVisibility:'labelShow',messageListVisibility:'show'});
  for(const sender of senders(input?.senders)){
    try{
      const f=await gmailSettings(env,account,'POST','/gmail/v1/users/me/settings/filters',{criteria:{from:sender},action:{addLabelIds:[label.id],removeLabelIds:['INBOX']}});
      await run(env,'INSERT INTO quarantine(account,sender,filter_id,created_at) VALUES(?,?,?,?) ON CONFLICT(account,sender) DO UPDATE SET filter_id=excluded.filter_id',account,sender,f.id||null,nowIso());
      await audit(env,`mail:quarantine:${account}`,sender);out.push({sender,status:'quarantined'});
    }catch(e){out.push({sender,status:e.message==='filter-scope'?'needs reconnect (filter permission)':`error: ${String(e.message).slice(0,60)}`});if(e.message==='filter-scope')break;}
  }
  return {account,results:out};
}
export async function isQuarantined(env,account,from){
  const sender=String((/<([^>]+)>/.exec(from||'')||[])[1]||from||'').trim().toLowerCase();
  return !!await env.DB.prepare('SELECT 1 FROM quarantine WHERE account=? AND sender IN (?,?)').bind(account,sender,'@'+sender.split('@')[1]).first();
}
