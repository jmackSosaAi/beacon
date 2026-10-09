// Circuit breaker (ROADMAP M2): too many executions or failures of one action type in 10 minutes pauses that
// type only (not all of Beacon), with one Telegram notice. Resuming a type needs the web app, like unpausing.
import {run,all,nowIso} from './service.js';
import {sendTelegram} from './tgapi.js';
const WINDOW_MS=10*60000,MAX_FAILURES=3,MAX_RUNS={capture:20,checkin:30,contact:10,call:6,agent_task:5,meal:20};
const key=type=>`breaker:${String(type).replace(/[^a-z_]/g,'').slice(0,30)}`;
export async function tripped(env,type){return (await env.DB.prepare('SELECT value FROM settings WHERE id=?').bind(key(type)).first())?.value==='open';}
export async function record(env,type,ok){
  if(await tripped(env,type))return;
  const since=new Date(Date.now()-WINDOW_MS).toISOString();
  const n=async kind=>(await env.DB.prepare('SELECT COUNT(*) AS n FROM audit WHERE action LIKE ? AND created_at>?').bind(`proposal:${kind}:${type}:%`,since).first()).n;
  // The current run is audited after this call on success, so count it here.
  const runs=(await n('executed'))+(ok?1:0),failures=await n('failed');
  if(failures<MAX_FAILURES&&runs<=(MAX_RUNS[type]||10))return;
  await run(env,'INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',key(type),'open');
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`breaker:open:${type}`,failures>=MAX_FAILURES?'failures':'volume',nowIso());
  await sendTelegram(env,`⚠️ Paused "${type}" actions: ${failures>=MAX_FAILURES?`${failures} failed`:`${runs} ran`} in 10 minutes. Everything else still works. Resume them in the Beacon web app (Settings).`)?.catch?.(()=>null);
}
export async function openBreakers(env){return (await all(env,"SELECT id FROM settings WHERE id LIKE 'breaker:%' AND value='open'")).map(r=>r.id.slice(8));}
export async function resetBreaker(env,type){
  await run(env,'DELETE FROM settings WHERE id=?',key(type));
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`breaker:reset:${type}`,'web',nowIso());
  return {ok:true};
}
