#!/usr/bin/env node
// Job-pipeline mail pull: searches both Google accounts for application, assessment, interview and decision mail
// and writes raw JSON to research/job-mail/<date>.json (git-ignored) for classification into tracker/applications.md.
// Read-only. Usage: node scripts/job-mail.mjs [days]
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
const base='https://your-worker.example.workers.dev',key=readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim();
const days=Number(process.argv[2])||30;
const QUERY='{application applied applying candidacy candidate interview assessment "coding challenge" hirevue codesignal "online assessment" "next steps" "thank you for your interest" "thank you for applying" "we received" "received your" "move forward" "moving forward" "unfortunately" "not to move" "other candidates" offer recruiter recruiting internship "summer analyst" "summer 2027" greenhouse lever ashby workday myworkday smartrecruiters icims taleo successfactors avature} -from:jobs-noreply@linkedin.com -from:newsletters-noreply@linkedin.com -from:messages-noreply@linkedin.com -from:updates-noreply@linkedin.com -from:noreply@news.bloomberg.com -category:promotions';
async function api(path,data){const r=await fetch(base+'/api'+path,{method:'POST',headers:{'X-Jarvis-Admin-Key':key,'content-type':'application/json'},body:JSON.stringify(data)});const out=await r.json();if(!r.ok)throw new Error(out.error||r.status);return out;}
const all=[];
for(const account of ['school','personal']){
  let page=null,pages=0;
  try{do{const r=await api('/mail/jobs',{account,days,query:QUERY,page});all.push(...r.messages);page=r.next;process.stdout.write(`\r${account}: ${all.filter(m=>m.account===account).length}`);await new Promise(r=>setTimeout(r,1500));}while(page&&++pages<25);}
  catch(e){console.log(`\n${account}: ${e.message}`);}
  console.log();
}
all.sort((a,b)=>b.date.localeCompare(a.date));
const dir=new URL('../../research/job-mail/',import.meta.url);mkdirSync(dir,{recursive:true});
const file=new URL(`${new Date().toISOString().slice(0,10)}.json`,dir);writeFileSync(file,JSON.stringify(all,null,1),{mode:0o600});
console.log(file.pathname);
