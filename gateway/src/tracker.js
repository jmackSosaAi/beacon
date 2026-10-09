// Application tracker view (decisions/tracker.md: markdown stays the source of truth). Beacon reads tracker/applications.md
// from GitHub, shows it in the web app and Telegram (/tracker), and commits status changes back to the same table row.
import {readTracker,writeTracker} from './github.js';
import {cleanText} from './core.js';
export const STATUSES=['found','approved','ready','submitted','interview','offer','rejected','dropped'];
const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
const unlink=c=>c.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,'$1');
const linkOf=c=>(/\]\((https:\/\/[^)\s]+)\)/.exec(c)||[])[1]||null;
export function parseTracker(md){
  const rows=[];let section='';
  for(const line of String(md).split('\n')){
    if(line.startsWith('## '))section=line.slice(3).trim();
    if(!line.startsWith('|')||/^\|\s*-/.test(line)||/^\|\s*Organization\s*\|/i.test(line))continue;
    const c=cells(line);if(c.length<4)continue;
    rows.push({org:unlink(c[0]),role:unlink(c[1]),deadline:c[2],status:c[3].toLowerCase(),link:linkOf(c[4]||''),next:unlink(c[5]||''),section});
  }
  return rows;
}
export async function trackerRows(env){const f=await readTracker(env);return f?parseTracker(f.text):[];}
// Changes only the Status cell of the one row whose Organization and Role match exactly.
export function withStatus(md,org,role,status){
  let hits=0;const out=String(md).split('\n').map(line=>{
    if(!line.startsWith('|'))return line;const c=cells(line);
    if(c.length>=4&&unlink(c[0])===org&&unlink(c[1])===role){hits++;c[3]=status;return `| ${c.join(' | ')} |`;}
    return line;});
  if(hits!==1)throw new Error(hits?'More than one row matches':'No such row');
  return out.join('\n');
}
export async function setStatus(env,input){
  const org=cleanText(input?.org,200),role=cleanText(input?.role,300),status=String(input?.status||'').toLowerCase();
  if(!STATUSES.includes(status))throw new Error('Unknown status');
  const f=await readTracker(env);if(!f)throw new Error('Tracker not found');
  return {committed:await writeTracker(env,withStatus(f.text,org,role,status),f.sha,`Tracker: ${org} — ${status}`)};
}
// Telegram /tracker: upcoming deadlines and anything past "found".
export async function trackerText(env){
  const rows=await trackerRows(env),today=new Date().toISOString().slice(0,10);
  const soon=rows.filter(r=>/^\d{4}-\d{2}-\d{2}/.test(r.deadline)&&r.deadline.slice(0,10)>=today&&!['submitted','rejected','dropped','offer'].includes(r.status)).sort((a,b)=>a.deadline.localeCompare(b.deadline)).slice(0,8);
  const active=rows.filter(r=>!['found','rejected','dropped'].includes(r.status));
  return `📋 Tracker (${rows.length} roles)\n${soon.length?`Next deadlines:\n${soon.map(r=>`• ${r.deadline.slice(0,10)} ${r.org}: ${r.role.slice(0,70)} (${r.status})`).join('\n')}`:'No upcoming dated deadlines.'}${active.length?`\nIn progress: ${active.map(r=>`${r.org} (${r.status})`).slice(0,10).join(', ')}`:''}\nChange a status in the Beacon web app (Tasks → Applications).`;
}
