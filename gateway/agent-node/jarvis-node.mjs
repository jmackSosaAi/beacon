#!/usr/bin/env node
// Beacon Mac node: polls the Worker every 30s over outbound HTTPS (no inbound ports) and runs one job at a time.
// Every job must carry a valid Worker signature (2-minute window) and an allowlisted kind; tasks carry their approval id.
// task: headless Claude Code in the Beacon repo with agent-node/claude-settings.json, then git push.
// send_file: a file from the repo (deny-list, 50MB cap) to Jackson's Telegram.
// pull: git pull --ff-only after Beacon commits. fix: overnight fix session on a fix/DATE branch (never merged or deployed).
// A daily integrity check refuses task/fix jobs if the node's own files or LaunchAgent were changed.
import {readFileSync,existsSync,symlinkSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PHOTO_PATH,freePhotoPath,resolveFile,contentType,taskPrompt,verifyJob,plistFor,integrityProblems,pushTarget,PROFILES,fixIssues,fixReaderPrompt,validatePlan,fixActorPrompt} from './lib.mjs';
import {scanText} from '../src/scan.js';

const BASE=process.env.JARVIS_URL||'https://your-worker.example.workers.dev';
// The real binary, not the shell alias (which adds --dangerously-skip-permissions).
const CLAUDE='/Users/you/.local/bin/claude';
const HERE=dirname(fileURLToPath(import.meta.url)),GW=resolve(HERE,'..'),ROOT=resolve(GW,'..'),SETTINGS=resolve(HERE,'claude-settings.json');
const PLIST=homedir()+'/Library/LaunchAgents/com.jarvis.node.plist';
// Token from the macOS Keychain (service jarvis-node); the old file is only a fallback.
function readToken(){
  try{return execFileSync('/usr/bin/security',['find-generic-password','-s','jarvis-node','-a','jarvis','-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}
  catch{const f=homedir()+'/.config/jarvis/node_token';if(existsSync(f))return readFileSync(f,'utf8').trim();throw new Error('No node token in Keychain');}
}
const TOKEN=readToken();
const POLL_MS=30000,TASK_MS=20*60000,BEAT_MS=3000,DAY_MS=86400000;
const log=(...a)=>console.log(new Date().toISOString(),...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function api(path,body,headers={}){
  const raw=body instanceof Uint8Array;
  const r=await fetch(BASE+'/api/node/'+path,{method:'POST',headers:{'X-Jarvis-Node-Key':TOKEN,'content-type':raw?headers['content-type']:'application/json',...headers},body:raw?body:JSON.stringify(body||{}),signal:AbortSignal.timeout(raw?180000:20000)});
  const out=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`${path}: ${r.status} ${out.error||''}`);return out;
}
const git=(args,cwd=ROOT)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:120000}).trim();
const repoUrl=()=>git(['remote','get-url','origin']).replace(/\.git$/,'').replace(/^git@github\.com:/,'https://github.com/');

// ---- integrity ----
let integrity={ok:true,checked:0,problems:[]};
function checkIntegrity(){
  const files={};
  for(const f of ['claude-settings.json','claude-reader-settings.json','jarvis-node.mjs','lib.mjs']){
    let committed=null;try{committed=git(['show',`HEAD:gateway/agent-node/${f}`])+'\n';}catch{}
    files[`agent-node/${f}`]={disk:readFileSync(resolve(HERE,f),'utf8').replace(/\n*$/,'\n'),committed:committed?.replace(/\n*$/,'\n')??null};
  }
  let plist=null;
  if(existsSync(PLIST)){const disk=readFileSync(PLIST,'utf8'),node=(/<array><string>([^<]+)<\/string>/.exec(disk)||[])[1]||'';
    plist={disk,expected:['/opt/homebrew/bin/node','/usr/local/bin/node'].includes(node)?plistFor({node,gw:GW,home:homedir()}):'(unexpected node path)'};}
  const problems=integrityProblems(files,plist);
  integrity={ok:!problems.length,checked:Date.now(),problems};
  if(problems.length){log('INTEGRITY FAILED:',problems.join('; '));api('alert',{problem:problems.join('; ')}).catch(()=>{});}
  else log('integrity ok');
}

// A photo Jackson sent in Telegram, saved into his life folder at the path the Worker built (re-checked here).
async function savePhoto(job){
  const LIFE=resolve(ROOT,'..');
  if(!PHOTO_PATH.test(String(job.query||'')))return api('result',{id:job.id,ok:false,summary:'That photo path is not one of the allowed folders.'});
  const rel=freePhotoPath(job.query,r=>existsSync(resolve(LIFE,r)));if(!rel)return api('result',{id:job.id,ok:false,summary:'Too many photos with that name.'});
  // A move: the old file (an allowed photo path, prompt) is renamed into place; never deleted.
  if(job.prompt&&PHOTO_PATH.test(job.prompt)&&existsSync(resolve(LIFE,job.prompt))){mkdirSync(dirname(resolve(LIFE,rel)),{recursive:true});renameSync(resolve(LIFE,job.prompt),resolve(LIFE,rel));log('moved photo',job.prompt,'→',rel);return api('result',{id:job.id,ok:true,summary:`Moved to ${rel}`});}
  const r=await fetch(BASE+'/api/node/photo?id='+encodeURIComponent(job.id),{method:'POST',headers:{'X-Jarvis-Node-Key':TOKEN},signal:AbortSignal.timeout(60000)});
  if(!r.ok)return api('result',{id:job.id,ok:false,summary:`Couldn't fetch the photo (${r.status}).`});
  const bytes=new Uint8Array(await r.arrayBuffer());if(!bytes.byteLength||bytes.byteLength>20e6)return api('result',{id:job.id,ok:false,summary:'Photo was empty or too large.'});
  const path=resolve(LIFE,rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes,{flag:'wx'});
  log('saved photo',rel,bytes.byteLength,'bytes');
  return api('result',{id:job.id,ok:true,summary:`Saved ${rel}`});
}
async function sendFile(job){
  const f=resolveFile(ROOT,job.query);
  if(f.error){log('send_file refused:',f.error);return api('result',{id:job.id,ok:false,summary:f.error});}
  log('sending',f.rel,f.size,'bytes');
  await api(`file?id=${encodeURIComponent(job.id)}`,new Uint8Array(await readFile(f.path)),{'content-type':contentType(f.rel),'X-File-Name':basename(f.rel)});
}

function runClaude(job,prompt,cwd,profile='actor'){
  const p=PROFILES[profile];
  return new Promise(done=>{
    const child=spawn(CLAUDE,['-p',prompt,'--output-format','json','--permission-mode',p.mode,'--max-turns',String(p.turns),'--settings',resolve(HERE,p.settings)],{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CLAUDE_CODE_ENTRYPOINT:'jarvis-node'}});
    let out='',err='',stopped=null;
    child.stdout.on('data',d=>{out+=d;if(out.length>2e6)out=out.slice(-2e6);});child.stderr.on('data',d=>{err+=d;if(err.length>2e5)err=err.slice(-2e5);});
    const kill=why=>{if(stopped)return;stopped=why;log('stopping session:',why);try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500);};
    const timer=setTimeout(()=>kill('20-minute limit reached'),TASK_MS);
    // Paused Beacon or /cancel stops the session at the next check-in.
    const beat=setInterval(()=>api('heartbeat',{id:job.id}).then(r=>{if(r.stop)kill('paused or cancelled in Beacon');}).catch(()=>{}),BEAT_MS);
    child.on('close',code=>{clearTimeout(timer);clearInterval(beat);done({code,out,err,stopped});});
    child.on('error',e=>{clearTimeout(timer);clearInterval(beat);done({code:-1,out,err:String(e.message),stopped});});
  });
}
const outcome=r=>{let parsed={};try{parsed=JSON.parse(r.out);}catch{}const text=String(parsed.result||'').trim();
  return {ok:!r.stopped&&r.code===0&&!parsed.is_error,summary:r.stopped?`Stopped: ${r.stopped}.`:text||`Claude Code exited with code ${r.code}. ${r.err.slice(-500)}`};};

// Agent task: runs in its own worktree from origin/main (Jackson's working copy is never touched). Before any push the
// added lines are scanned for secrets and personal data; only notes and agent-task reports go straight to main.
async function task(job){
  const id=String(job.id).slice(0,8),branch=`jarvis/task-${id}`,dir=resolve(ROOT,'..',`.jarvis-task-${id}`);
  try{git(['fetch','--quiet','origin']);git(['worktree','add','--force','-B',branch,dir,'origin/main']);}
  catch(e){return api('result',{id:job.id,ok:false,summary:`Couldn't create a work area: ${String(e.message).slice(0,200)}`});}
  try{if(existsSync(resolve(GW,'node_modules'))&&!existsSync(resolve(dir,'gateway/node_modules')))symlinkSync(resolve(GW,'node_modules'),resolve(dir,'gateway/node_modules'));}catch{}
  const before=git(['rev-parse','HEAD'],dir);
  log('task started');
  let {ok,summary}=outcome(await runClaude(job,taskPrompt(job.prompt),dir,'actor')),commit_url=null;
  const after=git(['rev-parse','HEAD'],dir);
  if(after!==before){
    const files=git(['diff','--name-only',before,after],dir).split('\n').filter(Boolean),added=git(['diff','-U0',before,after],dir).split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).join('\n');
    const hits=scanText(added),target=pushTarget(files);
    if(hits.length){summary+=`\n\nNot pushed: the changes look like they contain a ${hits.join(', ')}. The commit stays on the Mac on branch ${branch}.`;log('push blocked by scan');}
    else try{
      if(target==='main'){try{git(['push','--quiet','origin','HEAD:main'],dir);}catch{git(['pull','--quiet','--rebase','origin','main'],dir);git(['push','--quiet','origin','HEAD:main'],dir);}
        commit_url=`${repoUrl()}/commit/${git(['rev-parse','HEAD'],dir)}`;try{git(['pull','--ff-only','--quiet']);reindex();}catch{log('local pull skipped');}}
      else{git(['push','--quiet','--force-with-lease','origin',branch],dir);commit_url=`${repoUrl()}/tree/${branch}`;summary+=`\n\nIt changed files outside notes and reports (${files.slice(0,5).join(', ')}${files.length>5?'…':''}), so it's on branch ${branch} for you to review, not on main.`;}
    }catch(e){summary+='\n\nCommitted but the push failed; it is on the Mac.';log('push failed');}
  }else if(ok)summary+='\n\n(No commit was made.)';
  if(commit_url||after===before)try{git(['worktree','remove','--force',dir]);}catch{}
  log('task finished',ok?'ok':'failed');
  return api('result',{id:job.id,ok,summary:summary.slice(0,3400),commit_url});
}
// Overnight fix session: a separate worktree on fix/DATE from origin/main, so Jackson's working copy is untouched.
async function fix(job){
  const day=new Date().toISOString().slice(0,10),branch=`fix/${day}`,dir=resolve(ROOT,'..',`.jarvis-fix-${day}`);
  try{git(['fetch','--quiet','origin']);git(['worktree','add','--force','-B',branch,dir,'origin/main']);}
  catch(e){return api('result',{id:job.id,ok:false,summary:`Couldn't create the fix branch: ${String(e.message).slice(0,200)}`});}
  try{if(existsSync(resolve(GW,'node_modules'))&&!existsSync(resolve(dir,'gateway/node_modules')))symlinkSync(resolve(GW,'node_modules'),resolve(dir,'gateway/node_modules'));}catch{}
  const before=git(['rev-parse','HEAD'],dir);
  // Reader first: it reads the untrusted issue text but can't change anything. The actor only gets the plan code validated.
  log('fix session: reader');
  const issues=fixIssues(job.prompt),read=await runClaude(job,fixReaderPrompt(issues),dir,'reader');let parsed={};try{parsed=JSON.parse(read.out);}catch{}
  const {plan,skipped}=validatePlan(parsed.result||'',issues),skipNote=skipped.map(s=>`#${s.issue} skipped: ${s.why}`).join('\n');
  if(read.stopped||!plan.length){try{git(['worktree','remove','--force',dir]);}catch{}return api('result',{id:job.id,ok:!read.stopped,summary:(read.stopped?`Stopped: ${read.stopped}.`:'No safe fixes planned.')+(skipNote?`\n${skipNote}`:'')});}
  log('fix session: actor,',plan.length,'planned');
  let {ok,summary}=outcome(await runClaude(job,fixActorPrompt(plan,day),dir,'actor')),url=null;if(skipNote)summary+=`\n\n${skipNote}`;
  const after=git(['rev-parse','HEAD'],dir);
  if(after!==before){try{git(['push','--quiet','--force-with-lease','origin',branch],dir);url=`${repoUrl()}/tree/${branch}`;}catch{summary+='\n\nCommitted on the fix branch but the push failed.';}}
  else if(ok)summary+='\n\n(No changes were committed.)';
  try{git(['worktree','remove','--force',dir]);}catch{}
  return api('result',{id:job.id,ok,summary:summary.slice(0,3400),commit_url:url});
}
// Refresh Beacon's searchable notes after the repo changes (best effort).
const reindex=()=>{try{execFileSync(process.execPath,[resolve(GW,'scripts/kb-index.mjs'),'--node'],{cwd:ROOT,timeout:120000,stdio:'ignore'});log('knowledge base refreshed');}catch{log('knowledge base refresh failed');}};
async function pull(job){
  try{git(['pull','--ff-only','--quiet']);reindex();return api('result',{id:job.id,ok:true,summary:'Pulled.'});}
  catch(e){return api('result',{id:job.id,ok:false,summary:`git pull --ff-only failed (local changes or diverged): ${String(e.message).split('\n')[0].slice(0,200)}`});}
}

log('jarvis-node started; repo',ROOT);
checkIntegrity();
for(;;){
  let worked=false;
  try{
    if(Date.now()-integrity.checked>DAY_MS)checkIntegrity();
    const {job,paused}=await api('claim');
    if(job){worked=true;
      const refused=verifyJob(job,TOKEN)||(['task','fix'].includes(job.kind)&&!integrity.ok?`node integrity check failed (${integrity.problems.join('; ')})`:null);
      log('claimed',job.kind,job.id,refused?`REFUSED: ${refused}`:'');
      try{
        if(refused)await api('result',{id:job.id,ok:false,summary:`The Mac refused this job: ${refused}.`});
        else if(job.kind==='task')await task(job);else if(job.kind==='fix')await fix(job);else if(job.kind==='pull')await pull(job);else if(job.kind==='save_photo')await savePhoto(job);else await sendFile(job);
      }catch(e){log('job error',e.message);await api('result',{id:job.id,ok:false,summary:`The Mac hit an error: ${String(e.message).slice(0,300)}`}).catch(()=>{});}
    }else if(paused)log('Beacon is paused; not claiming');
  }catch(e){log('poll failed:',e.message,e.cause?.code||'',String(e.cause?.message||'').slice(0,120));}
  if(!worked)await sleep(POLL_MS);
}
