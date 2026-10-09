// Knowledge base search over the repo's markdown (ROADMAP M4). Documents arrive already chunked from
// scripts/kb-index.mjs (laptop admin key or the Mac node); unchanged files are skipped by hash.
// Snippets reach the model only inside the untrusted data block: notes are data, never rules (SAFETY rule 9).
import {all,run,nowIso} from './service.js';
import {clip,scrub,INJECTION} from './mail.js';
const PATH=/^(?!finance\/)(?!research\/mail-scout\/)[\w .\/()-]{1,200}\.md$/;
export async function kbSync(env,input){
  const docs=Array.isArray(input?.docs)?input.docs.slice(0,200):[],keep=Array.isArray(input?.paths)?input.paths.filter(p=>PATH.test(p)):null;
  let changed=0;
  for(const d of docs){
    if(!PATH.test(String(d.path))||typeof d.hash!=='string'||!Array.isArray(d.chunks))continue;
    const cur=await env.DB.prepare('SELECT hash FROM kb_docs WHERE path=?').bind(d.path).first();if(cur?.hash===d.hash)continue;
    await run(env,'DELETE FROM kb WHERE path=?',d.path);
    for(const c of d.chunks.slice(0,200))await run(env,'INSERT INTO kb(path,title,body) VALUES(?,?,?)',d.path,String(c.title||'').slice(0,200),String(c.body||'').slice(0,4000));
    await run(env,'INSERT INTO kb_docs(path,hash,updated_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash,updated_at=excluded.updated_at',d.path,d.hash.slice(0,64),nowIso());changed++;
  }
  // A full sync lists every current path; anything else was deleted or renamed.
  let removed=0;
  if(keep){for(const r of await all(env,'SELECT path FROM kb_docs'))if(!keep.includes(r.path)){await run(env,'DELETE FROM kb WHERE path=?',r.path);await run(env,'DELETE FROM kb_docs WHERE path=?',r.path);removed++;}}
  return {changed,removed};
}
const STOP=new Set('the a an and or of to in on for is are was it my me i you what when where how do does did should with about at be this that from by can will just'.split(' '));
// Words only (no FTS operators from user text), OR'ed, best matches first.
export function kbQuery(text){return [...new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g)||[])].filter(w=>!STOP.has(w)).slice(0,12).map(w=>`"${w}"`).join(' OR ');}
export async function kbSearch(env,text,n=4){
  const q=kbQuery(text);if(!q)return [];
  try{return await all(env,"SELECT path,title,snippet(kb,2,'','','…',40) AS snippet FROM kb WHERE kb MATCH ? ORDER BY bm25(kb) LIMIT ?",q,n);}catch{return [];}
}
// Notes are his own files but still data (SAFETY rule 9), and reviews/ carries text that started as model or email-derived
// content: bare domains go, and an instruction-shaped chunk is withheld before any snippet reaches a model.
export const noteText=v=>{const s=clip(v,300);return INJECTION.test(s)?'[withheld: contains instructions aimed at an assistant]':scrub(s);};
export const kbNotes=async(env,text,n=4)=>(await kbSearch(env,text,n)).map(r=>({path:r.path,title:noteText(r.title),snippet:noteText(r.snippet)}));
export async function kbText(env,text){
  const rows=await kbSearch(env,text,5);
  return rows.length?`📚 From your notes:\n${rows.map(r=>`• ${r.path}${r.title?` › ${r.title}`:''}: ${r.snippet.replace(/\s+/g,' ').slice(0,240)}`).join('\n')}`:'Nothing in your notes matches that.';
}
