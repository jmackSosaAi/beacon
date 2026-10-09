// Tasks by voice and chat (ROADMAP M3, Auto tier): "what's next?", list, add, complete, reprioritize.
// "What's next" and "list" are answered by code from stored data, with no model call. Every change keeps a
// before-image in action_undo for 24 hours (one-tap Undo in Telegram).
import {all,run,nowIso,capture} from './service.js';
import {cleanText,validInstant} from './core.js';
const TZ='America/Chicago',UNDO_MS=86400000;
const clock=iso=>new Date(iso).toLocaleTimeString('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'});
const day=iso=>new Date(iso).toLocaleDateString('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric'});
const strip=t=>String(t).replace(/^(Class work|Career)\s+—\s+/,'');
export const PRIORITY={high:1,normal:2,low:3},PRIORITY_NAME={1:'high',2:'normal',3:'low'};
export const WHATS_NEXT=/^(?:(?:hey|ok|okay)\s+beacon[,.!\s]*)?(?:what'?s\s+next|what\s+(?:should|do)\s+i\s+(?:do|work\s+on)(?:\s+(?:now|next))?|what\s+now)\s*[?.!]*$/i;
export const LIST_TASKS=/^(?:(?:hey|ok|okay)\s+beacon[,.!\s]*)?(?:(?:list|show)(?:\s+me)?\s+(?:my\s+)?(?:open\s+)?tasks|my\s+tasks|what\s+are\s+my\s+tasks)\s*[?.!]*$/i;
const openTasks=env=>all(env,"SELECT id,title,due_at,priority,status FROM tasks WHERE status NOT IN ('done','skipped') ORDER BY priority, COALESCE(due_at,'9999'), created_at LIMIT 25");

export async function whatsNext(env,now=new Date()){
  const iso=now.toISOString(),endOfDay=new Date(now.getTime()+18*3600000).toISOString();
  const current=await env.DB.prepare("SELECT title,start_at,end_at FROM blocks WHERE active=1 AND start_at<=? AND end_at>? AND status NOT IN ('done','skipped') ORDER BY start_at LIMIT 1").bind(iso,iso).first();
  const next=await env.DB.prepare("SELECT title,start_at FROM blocks WHERE active=1 AND start_at>? AND start_at<? AND status NOT IN ('done','skipped') ORDER BY start_at LIMIT 1").bind(iso,endOfDay).first();
  const task=(await openTasks(env))[0],parts=[];
  if(current)parts.push(`Right now: ${strip(current.title)}, until ${clock(current.end_at)}.`);
  if(next){const mins=Math.round((Date.parse(next.start_at)-now.getTime())/60000);parts.push(`${current?'After that':'Next'}: ${strip(next.title)} at ${clock(next.start_at)}${mins<=90?` (in ${mins} minutes)`:''}.`);}
  if(task)parts.push(`Top task: ${task.title}${task.due_at?`, due ${day(task.due_at)} ${clock(task.due_at)}`:''}${task.priority===1?' (high priority)':''}.`);
  return parts.length?parts.join(' '):'Nothing scheduled and no open tasks. Want to capture something?';
}
export async function listTasks(env){
  const rows=(await openTasks(env)).slice(0,8);
  return rows.length?`Open tasks: ${rows.map((t,i)=>`${i+1}. ${t.title}${t.due_at?` (due ${day(t.due_at)})`:''}${t.priority===1?' [high]':t.priority===3?' [low]':''}`).join('; ')}.`:'No open tasks.';
}
async function remember(env,type,target,before){const id=crypto.randomUUID().slice(0,8);await run(env,'INSERT INTO action_undo(id,type,target,before,created_at) VALUES(?,?,?,?,?)',id,type,target,before==null?null:JSON.stringify(before),nowIso());return id;}
// Auto tier: runs now, returns {reply, undo_id}.
export async function applyTask(env,a){
  if(a.type==='task_add'){
    const r=await capture(env,{title:a.title,notes:a.notes,category:a.category,due_at:a.due_at,confidence:'confirmed'},'voice/chat');
    const id=r.id||(await env.DB.prepare('SELECT id FROM tasks WHERE title=? ORDER BY created_at DESC LIMIT 1').bind(a.title).first())?.id;
    if(a.priority&&a.priority!==2)await run(env,'UPDATE tasks SET priority=? WHERE id=?',a.priority,id);
    return {reply:`Added: ${a.title}${a.due_at?`, due ${day(a.due_at)} ${clock(a.due_at)}`:''}${a.priority===1?', high priority':''}.`,undo_id:await remember(env,'task_add',id,null)};
  }
  const row=await env.DB.prepare('SELECT id,title,status,priority FROM tasks WHERE id=?').bind(a.id).first();if(!row)throw new Error('Task not found');
  if(a.type==='task_done'){await run(env,"UPDATE tasks SET status='done',updated_at=? WHERE id=?",nowIso(),row.id);return {reply:`Done: ${row.title}.`,undo_id:await remember(env,'task_done',row.id,{status:row.status})};}
  await run(env,'UPDATE tasks SET priority=?,updated_at=? WHERE id=?',a.priority,nowIso(),row.id);
  return {reply:`${row.title} is now ${PRIORITY_NAME[a.priority]} priority.`,undo_id:await remember(env,'task_priority',row.id,{priority:row.priority})};
}
// Undo once, within 24 hours, from the stored before-image. Calendar undos are handled by calendar.js.
export async function undoAction(env,id){
  const u=await env.DB.prepare('SELECT * FROM action_undo WHERE id=? AND undone_at IS NULL AND created_at>?').bind(cleanText(id,16),new Date(Date.now()-UNDO_MS).toISOString()).first();
  if(!u)return 'Too late to undo (older than 24 hours or already undone).';
  const before=u.before?JSON.parse(u.before):null;
  // The reply names what was reverted, so a text undo that hit an older action than he meant is visible at once.
  const title=u.type.startsWith('task_')?(await env.DB.prepare('SELECT title FROM tasks WHERE id=?').bind(u.target).first())?.title:null,q=title?` “${title.slice(0,80)}”`:'';
  let what;
  if(u.type==='task_add'){await run(env,'DELETE FROM tasks WHERE id=?',u.target);what=`removed the task${q}`;}
  else if(u.type==='task_done'){await run(env,'UPDATE tasks SET status=?,updated_at=? WHERE id=?',before.status,nowIso(),u.target);what=`the task${q} is ${before.status} again`;}
  else if(u.type==='task_priority'){await run(env,'UPDATE tasks SET priority=?,updated_at=? WHERE id=?',before.priority,nowIso(),u.target);what=`the task${q} is back to ${PRIORITY_NAME[before.priority]||'normal'} priority`;}
  else if(u.type.startsWith('calendar_')){const r=await (await import('./calendar.js')).undoCalendar(env,u,before);if(r)return r;what={calendar_create:'the new calendar event is cancelled',calendar_move:'the event is back at its old time',calendar_cancel:'the cancelled event is restored'}[u.type];}
  else return 'That can’t be undone here.';
  await run(env,'UPDATE action_undo SET undone_at=? WHERE id=?',nowIso(),u.id);
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`undo:${u.type}`,u.target,nowIso());
  return `↩️ Undone: ${what}.`;
}
// The newest Auto action still open to a text undo (any path that wrote action_undo: agent, single-shot, approvals).
export const lastUndoId=async env=>(await env.DB.prepare('SELECT id FROM action_undo WHERE undone_at IS NULL AND created_at>? ORDER BY created_at DESC LIMIT 1').bind(new Date(Date.now()-UNDO_MS).toISOString()).first())?.id||null;
export const validDue=v=>v&&validInstant(v)?new Date(v).toISOString():null;
