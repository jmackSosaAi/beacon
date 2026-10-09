// Writes Jackson's notes and feedback into the private repo. Fine-grained token (this repo only, Contents + Issues).
// Allowlist: append to notes/INBOX.md and create issues labeled "feedback". Nothing else is reachable.
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,NOTES_PATH='notes/INBOX.md';
const gh=async(env,method,path,body)=>{
  const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private';if(!env.GITHUB_TOKEN||!REPO.test(repo))throw new Error('github-not-configured');
  const allowed=[['GET',`/repos/${repo}/contents/${NOTES_PATH}`],['PUT',`/repos/${repo}/contents/${NOTES_PATH}`],['POST',`/repos/${repo}/issues`],['GET',`/repos/${repo}/issues?labels=feedback&state=open&per_page=10`]];
  // Application tracker (source of truth stays markdown): read and status updates only.
  if(path===`/repos/${repo}/contents/tracker/applications.md`&&['GET','PUT'].includes(method))allowed.push([method,path]);
  // Weekly reviews: reviews/YYYY-MM-DD.md and reviews/interactions-YYYY-MM-DD.md only.
  if(/^\/repos\/[^/]+\/[^/]+\/contents\/reviews\/(?:interactions-)?\d{4}-\d{2}-\d{2}\.md$/.test(path)&&['GET','PUT'].includes(method)&&path.startsWith(`/repos/${repo}/`))allowed.push([method,path]);
  if(!allowed.some(([m,p])=>m===method&&p===path))throw new Error('GitHub call not allowed');
  const r=await fetch('https://api.github.com'+path,{method,headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json','User-Agent':'jarvis-gateway','X-GitHub-Api-Version':'2022-11-28',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if(r.status===404&&method==='GET')return null;
  if(!r.ok)throw new Error(`github-${r.status}`);
  return r.json();
};
const b64=s=>btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64=s=>new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g,'')),c=>c.charCodeAt(0)));
const chicago=iso=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'});
// Provenance front-matter: every file Beacon writes says who wrote it and whose words it holds.
const FRONT='---\nwritten_by: jarvis-gateway\nprovenance: Jackson\'s own words, captured by voice, Telegram or the web app\ntrust: owner\n---\n';
const HEADER=FRONT+'# Notes inbox\n\nNotes Jackson captured by call or Telegram, in his words.\n\n';
const withFront=text=>text.startsWith('---\n')?text:FRONT+text;
export async function commitNote(env,note){
  const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private',path=`/repos/${repo}/contents/${NOTES_PATH}`;
  for(let attempt=0;attempt<2;attempt++){
    const cur=await gh(env,'GET',path),text=(cur?withFront(unb64(cur.content)):HEADER)+`- ${chicago(note.created_at)} (${note.channel}): ${note.text.replace(/\n+/g,' ')}\n`;
    try{const out=await gh(env,'PUT',path,{message:`Note from ${note.channel}`,content:b64(text),...(cur?{sha:cur.sha}:{})});return out.commit?.html_url||'committed';}
    catch(e){if(e.message!=='github-409'&&e.message!=='github-422')throw e;}
  }
  throw new Error('github-conflict');
}
export async function openFeedbackIssue(env,note){
  const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private';
  let ctx='';try{const c=JSON.parse(note.context||'{}');ctx=[c.during?`**During:** ${c.during}`:'',...(c.recent||[]).map(m=>`- **${m.role==='assistant'?'Beacon':'Jackson'}:** ${String(m.text).replace(/\s+/g,' ')}`)].filter(Boolean).join('\n');}catch{}
  const title=note.text.replace(/\s+/g,' ').slice(0,80)+(note.text.length>80?'…':'');
  const body=`${note.text}\n\n_${chicago(note.created_at)} via ${note.channel}${note.call?` (${note.call} call)`:''}_${ctx?`\n\n<details><summary>Context</summary>\n\n${ctx}\n</details>`:''}`;
  const out=await gh(env,'POST',`/repos/${repo}/issues`,{title,body,labels:['feedback']});
  return out.html_url;
}
// Open feedback issues (number, title, his words) for the overnight fix session.
export async function openFeedback(env){
  const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private';
  return ((await gh(env,'GET',`/repos/${repo}/issues?labels=feedback&state=open&per_page=10`))||[]).filter(i=>!i.pull_request).map(i=>({number:i.number,title:String(i.title).slice(0,120),body:String(i.body||'').split('<details>')[0].trim().slice(0,600)}));
}
// The overnight fix session payload: the issues as JSON data only. The Mac runs a read-only session over this
// untrusted text first; the session that edits code only sees the plan that code validated (agent-node/lib.mjs).
export function fixPrompt(issues){for(let max=600;;max=Math.floor(max*0.7)){const out=JSON.stringify(issues.slice(0,10).map(i=>({number:i.number,title:i.title,body:String(i.body).slice(0,max)})));if(out.length<=3900||max<20)return out.slice(0,3900);}}

// Weekly review files (reviews/DATE.md, reviews/interactions-DATE.md). Same pre-commit scan as notes; a hit means it isn't committed.
export async function commitReview(env,date,text,prefix=''){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['','interactions-'].includes(prefix))throw new Error('bad date');
  const hits=(await import('./scan.js')).scanText(text);if(hits.length)throw new Error('scan:'+hits.join(','));
  const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private',path=`/repos/${repo}/contents/reviews/${prefix}${date}.md`,cur=await gh(env,'GET',path);
  const front=`---\nwritten_by: jarvis-gateway\nprovenance: ${prefix?'interaction review built by code from the interactions log (his own asks, counts, tool names; no replies)':'weekly review built by code from Beacon\'s own records (check-ins, counts, audit)'}\ntrust: owner\n---\n`;
  const out=await gh(env,'PUT',path,{message:`${prefix?'Interaction review':'Weekly review'} ${date}`,content:b64(front+text),...(cur?{sha:cur.sha}:{})});
  await (await import('./node.js')).queueJob(env,{kind:'pull'},'routine').catch(()=>null);
  return out.commit?.html_url||'committed';
}

// Tracker file access for tracker.js. Writes are scanned like every other Beacon commit.
export async function readTracker(env){const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private',cur=await gh(env,'GET',`/repos/${repo}/contents/tracker/applications.md`);return cur?{text:unb64(cur.content),sha:cur.sha}:null;}
export async function writeTracker(env,text,sha,message){
  const hits=(await import('./scan.js')).scanText(text);if(hits.length)throw new Error('scan:'+hits.join(','));
  const repo=env.GITHUB_REPO||'jmackSosaAi/beacon-private',out=await gh(env,'PUT',`/repos/${repo}/contents/tracker/applications.md`,{message:String(message).slice(0,120),content:b64(text),sha});
  await (await import('./node.js')).queueJob(env,{kind:'pull'},'routine').catch(()=>null);return out.commit?.html_url||'committed';
}
