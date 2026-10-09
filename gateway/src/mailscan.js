// Inbox scout: tallies recurring bulk senders in one account so Jackson can pick what to unsubscribe from.
// Admin-only, read-only (gmail.readonly metadata). Mail from people (no unsubscribe header, not a no-reply
// sender) is skipped entirely, and school-record mail keeps no subject.
import {run,all} from './service.js';
import {googleAccessToken,migrateLegacy,get} from './google.js';
import {clip,domainOf,ruleTriage} from './mail.js';

const BULK_SENDER=/^(?:no-?reply|do-?not-?reply|newsletters?|news|marketing|notifications?|notify|updates|info|hello|team|digest|alerts?|mailer|offers|deals|promo)[^@]*@/i;
const address=from=>String((/<([^>]+)>/.exec(from||'')||[])[1]||from||'').trim().toLowerCase();
export function bulkInfo(headers){
  const unsub=headers['list-unsubscribe']||'',sender=address(headers.from);
  const bulk=!!unsub||BULK_SENDER.test(sender)||/^(bulk|list)$/i.test(headers.precedence||'');
  return {bulk,sender,http:/<https:/i.test(unsub),mailto:/<mailto:/i.test(unsub),oneclick:/One-Click/i.test(headers['list-unsubscribe-post']||'')};
}
// One page (up to 40 messages) per call so a Worker request stays well under its subrequest limit.
export async function scanPage(env,input){
  const account=input?.account==='school'?'school':'personal',days=Math.min(365,Math.max(7,Number(input?.days)||90));
  await migrateLegacy(env);
  const token=await googleAccessToken(env,account);
  if(!input?.page)await run(env,'DELETE FROM mail_scan WHERE account=?',account);
  const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('q',`newer_than:${days}d -in:sent -in:chats -in:drafts`);url.searchParams.set('maxResults','40');
  if(input?.page)url.searchParams.set('pageToken',String(input.page).slice(0,2000));
  const listing=await get(url,token),ids=(listing.messages||[]).map(m=>m.id);
  let bulk=0;
  for(let i=0;i<ids.length;i+=5){
    const batch=await Promise.all(ids.slice(i,i+5).map(id=>get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=Precedence&metadataHeaders=Authentication-Results`,token).catch(()=>null)));
    for(const m of batch){
      if(!m)continue;
      const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value])),b=bulkInfo(headers);
      if(!b.bulk||!b.sender.includes('@'))continue;bulk++;
      const at=new Date(Number(m.internalDate)||Date.now()).toISOString(),school=ruleTriage(headers,'')?.school;
      const subject=school?'[school record]':clip(headers.subject,120)||'(no subject)',name=clip((headers.from||'').replace(/<.*>/,'').replace(/"/g,'').trim(),80)||null;
      await run(env,`INSERT INTO mail_scan(account,sender,name,domain,count,first_at,last_at,unsub_oneclick,unsub_http,unsub_mailto,subject) VALUES(?,?,?,?,1,?,?,?,?,?,?)
        ON CONFLICT(account,sender) DO UPDATE SET count=count+1,first_at=MIN(first_at,excluded.first_at),
        subject=CASE WHEN excluded.last_at>last_at THEN excluded.subject ELSE subject END,name=COALESCE(name,excluded.name),last_at=MAX(last_at,excluded.last_at),
        unsub_oneclick=MAX(unsub_oneclick,excluded.unsub_oneclick),unsub_http=MAX(unsub_http,excluded.unsub_http),unsub_mailto=MAX(unsub_mailto,excluded.unsub_mailto)`,
        account,b.sender.slice(0,200),name,domainOf(headers.from)||null,at,at,b.oneclick?1:0,b.http?1:0,b.mailto?1:0,subject);
    }
  }
  return {account,scanned:ids.length,bulk,next:listing.nextPageToken||null};
}
export const scanReport=(env,account)=>all(env,'SELECT sender,name,domain,count,first_at,last_at,unsub_oneclick,unsub_http,unsub_mailto,subject FROM mail_scan WHERE account=? ORDER BY count DESC,last_at DESC LIMIT 500',account==='school'?'school':'personal');

// Job-mail search (scripts/job-mail.mjs): one page of messages matching a Gmail query, with sender, subject,
// date and snippet, so application confirmations, rejections and interview invites can be pulled into the tracker.
// Admin-only, read-only (gmail.readonly metadata). School-record mail is withheld, as in the triage.
export async function jobMailPage(env,input){
  const account=input?.account==='school'?'school':'personal',days=Math.min(365,Math.max(1,Number(input?.days)||30));
  const query=String(input?.query||'').slice(0,1500);
  await migrateLegacy(env);
  const token=await googleAccessToken(env,account);
  const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('q',`newer_than:${days}d -in:sent -in:chats -in:drafts ${query}`.trim());url.searchParams.set('maxResults','40');
  if(input?.page)url.searchParams.set('pageToken',String(input.page).slice(0,2000));
  const listing=await get(url,token),ids=(listing.messages||[]).map(m=>m.id),out=[];
  for(let i=0;i<ids.length;i+=5){
    const batch=await Promise.all(ids.slice(i,i+5).map(id=>get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,token).catch(()=>null)));
    for(const m of batch){
      if(!m)continue;
      const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value])),t=ruleTriage(headers,m.snippet||'');
      const date=new Date(Number(m.internalDate)||0).toISOString();
      if(t?.school){out.push({account,id:m.id,date,from:domainOf(headers.from||''),school_record:true});continue;}
      out.push({account,id:m.id,thread:m.threadId,date,from:clip(headers.from,120),subject:clip(headers.subject,200),snippet:clip(m.snippet,300)});
    }
  }
  return {messages:out,next:listing.nextPageToken||null};
}
