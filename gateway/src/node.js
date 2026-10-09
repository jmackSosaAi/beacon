// The Mac node: a program on Jackson's Mac (agent-node/jarvis-node.mjs) that polls over outbound HTTPS with NODE_TOKEN.
// It can only claim jobs, report results and upload a requested file. Node output is untrusted: plain text, to Jackson only.
import {run,all,nowIso,isPaused} from './service.js';
import {sendTelegram,sendTelegramFile} from './tgapi.js';
import {cleanText} from './core.js';
import {TRUSTED_ORIGINS} from './contacts.js';

export const MAX_FILE_BYTES=50*1024*1024,ONLINE_MS=90000,STALE_RUN_MS=30*60000;
const COMMIT=/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:commit\/[0-9a-f]{7,40}|tree\/(?:fix\/[0-9-]{10}[\w-]{0,20}|beacon\/task-[0-9a-f-]{1,8}))$/;
const audit=(env,action,target=null)=>run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),action,target,nowIso());

export async function nodeOnline(env){const row=await env.DB.prepare("SELECT value FROM settings WHERE id='node_seen'").first();return !!row&&Date.now()-Date.parse(row.value)<ONLINE_MS;}
const seen=env=>run(env,"INSERT INTO settings(id,value) VALUES('node_seen',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",nowIso());

// Allowlisted job kinds. task: approved agent task; send_file: Auto; pull/fix: system jobs queued by Beacon routines only.
export const JOB_KINDS=['task','send_file','pull','fix','save_photo'],SYSTEM_KINDS=['pull','fix'],SIGNED_MS=120000;
// Agent tasks reach here only from executeProposal (approved, with its proposal id); send_file is queued straight from conversation.
export async function queueJob(env,job,origin,approved=false,proposalId=null){
  if(!JOB_KINDS.includes(job.kind))throw new Error('Unknown job kind');
  if(SYSTEM_KINDS.includes(job.kind)?origin!=='routine':!TRUSTED_ORIGINS.includes(origin))throw new Error('Node jobs can only come from your own messages');
  if(await isPaused(env))throw new Error('paused');
  if(job.kind==='task'&&(!approved||!proposalId))throw new Error('Agent tasks need your approval');
  // One pending pull is enough; one fix session per night.
  if(SYSTEM_KINDS.includes(job.kind)&&await env.DB.prepare("SELECT 1 FROM node_jobs WHERE kind=? AND status IN ('queued','running')").bind(job.kind).first())return {id:null,online:await nodeOnline(env),duplicate:true};
  const id=crypto.randomUUID(),now=nowIso();
  await run(env,'INSERT INTO node_jobs(id,kind,prompt,query,status,origin,created_at,approved_at,proposal_id) VALUES(?,?,?,?,?,?,?,?,?)',id,job.kind,['task','fix'].includes(job.kind)?cleanText(job.prompt,4000):job.kind==='save_photo'&&job.prompt?cleanText(job.prompt,300):null,['send_file','save_photo'].includes(job.kind)?cleanText(job.query,300):null,'queued',origin,now,approved?now:null,proposalId);
  await audit(env,`node:queued:${job.kind}:${origin}`,id);
  return {id,online:await nodeOnline(env)};
}
export const queuedReply=(kind,online)=>`${kind==='task'?'Queued for your Mac.':'Finding that file.'}${online?'':' Your Mac is offline, so it will run when the Mac is back.'}`;

// Oldest queued job, claimed atomically. Nothing is handed out while Beacon is paused.
export async function claimJob(env){
  await seen(env);
  await run(env,"UPDATE node_jobs SET status='failed',finished_at=?,result='Timed out' WHERE status='running' AND claimed_at<?",nowIso(),new Date(Date.now()-STALE_RUN_MS).toISOString());
  if(await isPaused(env))return {job:null,paused:true};
  const job=await env.DB.prepare("UPDATE node_jobs SET status='running',claimed_at=? WHERE id=(SELECT id FROM node_jobs WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING id,kind,prompt,query,proposal_id").bind(nowIso()).first();
  if(!job)return {job:null,paused:false};
  await audit(env,`node:claimed:${job.kind}`,job.id);
  return {job:await signJob(env,{...job,exp:Date.now()+SIGNED_MS}),paused:false};
}
// Jobs are signed so the node runs only what this Worker handed out, within 2 minutes of the claim.
// The signing key is derived from NODE_TOKEN with a fixed label; the node derives the same key.
export const jobPayload=j=>[j.id,j.kind,j.prompt||'',j.query||'',j.proposal_id||'',j.exp].join('\n');
async function signingKey(token){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign']);const raw=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode('jarvis-node-job-signing:v1'));return crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);}
export async function signJob(env,job){const sig=new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(env.NODE_TOKEN),new TextEncoder().encode(jobPayload(job))));return {...job,sig:Array.from(sig).map(b=>b.toString(16).padStart(2,'0')).join('')};}
// The node's own alerts (config integrity): plain text, to Jackson's Telegram.
export async function nodeAlert(env,input){
  await seen(env);const problem=String(input?.problem||'').replace(/[^\w .,:;()\/-]/g,'').slice(0,300)||'unspecified';
  const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`nodealert:${problem.slice(0,80)}:${nowIso().slice(0,10)}`,nowIso());
  await audit(env,'node:alert',problem.slice(0,120));
  if(first.meta.changes)await sendTelegram(env,`⚠️ Mac node integrity check failed: ${problem}\nAgent tasks are refused until it's fixed. If you didn't change the node's files, pause Beacon (/stop).`,{reply_markup:{inline_keyboard:[[{text:'Pause Beacon',callback_data:'s:pause'}]]}});
  return {ok:true};
}
// While a task runs the node checks in; if Beacon was paused or the job cancelled, it kills the session.
export async function heartbeat(env,input){
  await seen(env);
  const row=await env.DB.prepare('SELECT status FROM node_jobs WHERE id=?').bind(cleanText(input?.id,64)).first();
  return {stop:await isPaused(env)||row?.status!=='running'};
}
const runningJob=async(env,id)=>{const job=await env.DB.prepare("SELECT * FROM node_jobs WHERE id=? AND status='running'").bind(cleanText(id,64)).first();if(!job)throw new Error('No running job with that id');return job;};

export async function finishJob(env,input){
  await seen(env);
  const job=await runningJob(env,input?.id),ok=input.ok===true;
  const summary=String(input.summary||'').replace(/\r/g,'').trim().slice(0,3500)||(ok?'Done.':'No details.');
  const commit=typeof input.commit_url==='string'&&COMMIT.test(input.commit_url)?input.commit_url:null;
  await run(env,'UPDATE node_jobs SET status=?,finished_at=?,result=? WHERE id=?',ok?'done':'failed',nowIso(),summary,job.id);
  await audit(env,`node:${ok?'done':'failed'}:${job.kind}`,job.id);
  // A successful pull is silent; a photo was already announced when it was sorted, so only a failure reports.
  if(job.kind==='pull'&&ok)return {ok:true};
  if(job.kind==='save_photo'){await (await import('./photo.js')).photoFiled(env,job.id,ok,summary);return {ok:true};}
  const head=job.kind==='task'?`${ok?'✅ Task done':'❌ Task failed'}: ${job.prompt.slice(0,200)}`:job.kind==='fix'?`🛠 Overnight fix session ${ok?'finished':'failed'}`:job.kind==='pull'?'⚠️ Mac couldn’t pull the latest Beacon repo':`📎 Couldn’t send “${job.query}”`;
  await sendTelegram(env,`${head}\n\n${summary}${commit?`\n\n${job.kind==='fix'?'Branch':'Commit'}: ${commit}`:''}`.slice(0,3900));
  return {ok:true};
}
// Raw body, at most 50MB, for a running send_file job only; goes to Jackson's Telegram and nowhere else.
export async function uploadFile(env,request,id){
  await seen(env);
  const job=await runningJob(env,id);
  if(job.kind!=='send_file')throw new Error('Not a file job');
  if(Number(request.headers.get('content-length')||0)>MAX_FILE_BYTES)throw new Error('File too large');
  const bytes=await request.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>MAX_FILE_BYTES)throw new Error('File too large or empty');
  const filename=(request.headers.get('X-File-Name')||'file').replace(/[^\w.\- ()]/g,'_').slice(0,120);
  const contentType=/^[\w.+-]+\/[\w.+-]+$/.test(request.headers.get('content-type')||'')?request.headers.get('content-type'):'application/octet-stream';
  const sent=await sendTelegramFile(env,{bytes,filename,contentType,caption:filename});
  await run(env,'UPDATE node_jobs SET status=?,finished_at=?,result=? WHERE id=?',sent?'done':'failed',nowIso(),sent?`Sent ${filename}`:'Telegram upload failed',job.id);
  await audit(env,`node:${sent?'done':'failed'}:send_file`,job.id);
  if(!sent)await sendTelegram(env,`📎 Couldn’t upload ${filename} to Telegram.`);
  return {ok:!!sent};
}

export async function cancelJobs(env){
  const r=await run(env,"UPDATE node_jobs SET status='cancelled',finished_at=? WHERE status IN ('queued','running')",nowIso());
  await audit(env,'node:cancelled:telegram',String(r.meta.changes));return r.meta.changes;
}
const ICON={queued:'⏳',running:'⚙️',done:'✅',failed:'❌',cancelled:'✖'};
export async function jobsText(env){
  const rows=await all(env,'SELECT kind,prompt,query,status,created_at FROM node_jobs ORDER BY created_at DESC LIMIT 8');
  if(!rows.length)return 'No Mac jobs yet. Ask me to run something on your Mac, or to send you a file.';
  return `🖥 Mac jobs (latest ${rows.length})\n${rows.map(r=>`${ICON[r.status]} ${{task:'Task',send_file:'File',pull:'Pull',fix:'Fix session',save_photo:'Photo'}[r.kind]}: ${(r.prompt||r.query||'git pull').replace(/\s+/g,' ').slice(0,120)}`).join('\n')}\n/cancel stops queued and running jobs.`;
}
export async function nodeText(env){
  const row=await env.DB.prepare("SELECT value FROM settings WHERE id='node_seen'").first(),queued=(await env.DB.prepare("SELECT COUNT(*) AS n FROM node_jobs WHERE status='queued'").first()).n;
  const when=row?new Date(row.value).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'}):'never';
  return `🖥 Mac node: ${await nodeOnline(env)?'online':'offline'} (last check-in ${when}). ${queued} job${queued===1?'':'s'} waiting.${await isPaused(env)?' Beacon is paused, so nothing runs.':''}`;
}
