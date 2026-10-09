// Gmail drafts only. The gmail.compose scope would also allow sending, so this module is the only code that
// writes to Gmail and its allowlist permits creating and updating drafts, nothing else (SAFETY rule 7).
import {googleAccessToken} from './google.js';
import {gfetch} from './gapi.js';
const ALLOWED=[['POST',/^\/gmail\/v1\/users\/me\/drafts$/],['PUT',/^\/gmail\/v1\/users\/me\/drafts\/[A-Za-z0-9_-]{1,64}$/]];
async function gmailWrite(env,method,path,payload,account){
  if(!ALLOWED.some(([m,p])=>m===method&&p.test(path)))throw new Error('Gmail write not allowed');
  const r=await gfetch(method,'https://gmail.googleapis.com'+path,await googleAccessToken(env,account),payload);
  if(r.status===403||r.status===401)throw new Error(account==='school'?'school-scope':'scope');
  if(!r.ok)throw new Error('gmail');
  return r.json();
}
const b64url=s=>btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const encodedWord=s=>`=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
const ascii=s=>/^[\x20-\x7e]*$/.test(s);
// Header values never carry line breaks or control characters, so a name or subject cannot start a new header.
const clean=v=>String(v??'').replace(/[\r\n\t]+/g,' ').replace(/[\x00-\x1f\x7f]/g,'').trim();
const header=s=>ascii(s)?s:encodedWord(s);
// RFC 5322 atext plus space; anything else (specials such as < > " @ , ; : . [ ] ( ) \) must be quoted.
const ATOMS=/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]*$/;
const ADDRESS=/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const MESSAGE_ID=/^<[^\s<>]{1,200}>$/,THREAD_ID=/^[A-Za-z0-9_-]{1,64}$/;
// A display name is emitted as an RFC 2047 encoded-word (non-ASCII) or an RFC 5322 quoted-string with backslash escapes
// (specials), so a name like `Dana <x@evil.example>, hr@evil.example` can never change the parsed recipient.
export const phrase=name=>{const n=clean(name);return !n?'':!ascii(n)?encodedWord(n):ATOMS.test(n)?n:`"${n.replace(/["\\]/g,c=>'\\'+c)}"`;};
const mailbox=r=>{const a=String(r?.address||'').trim().toLowerCase();if(!ADDRESS.test(a)||a.length>120)throw new Error('bad address');const p=phrase(r.name);return p?`${p} <${a}>`:a;};
// {to:[{name,address}],cc,bcc,subject,body,inReplyTo,references}: In-Reply-To/References only with a valid Message-ID,
// References is the stored chain (ids only) ending in the message replied to.
export function rawMessage({to,cc=[],bcc=[],subject,body,inReplyTo,references}){
  if(!Array.isArray(to)||!to.length)throw new Error('recipient required');
  const lines=[`To: ${to.map(mailbox).join(', ')}`];
  if(cc.length)lines.push(`Cc: ${cc.map(mailbox).join(', ')}`);
  if(bcc.length)lines.push(`Bcc: ${bcc.map(mailbox).join(', ')}`);
  lines.push(`Subject: ${header(clean(subject))}`);
  if(inReplyTo&&MESSAGE_ID.test(inReplyTo)){
    const refs=String(references||'').split(/\s+/).filter(x=>MESSAGE_ID.test(x));if(!refs.includes(inReplyTo))refs.push(inReplyTo);
    lines.push(`In-Reply-To: ${inReplyTo}`,`References: ${refs.slice(-20).join(' ')}`);
  }
  lines.push('MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8');
  return b64url(`${lines.join('\r\n')}\r\n\r\n${String(body).replace(/\r?\n/g,'\r\n')}`);
}
// threadId goes in the draft payload so Gmail files a reply in its thread; the allowlist above is unchanged.
export async function saveGmailDraft(env,{gmailDraftId,to,cc,bcc,subject,body,inReplyTo,references,threadId,account='personal'}){
  const message={raw:rawMessage({to,cc,bcc,subject,body,inReplyTo,references}),...(threadId&&THREAD_ID.test(threadId)?{threadId}:{})};
  const out=gmailDraftId?await gmailWrite(env,'PUT',`/gmail/v1/users/me/drafts/${gmailDraftId}`,{id:gmailDraftId,message},account):await gmailWrite(env,'POST','/gmail/v1/users/me/drafts',{message},account);
  return out.id;
}
