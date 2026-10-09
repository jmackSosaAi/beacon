// Eval runs (M7 batch 6, design "Replay on the Mac"): scripts/agent-eval.mjs replays the asks.json eval set against the real
// planner on the Mac and posts counts plus failing ask ids here (admin key). Each failure also becomes a capability request
// so the Sunday review lists it under Gaps and "recurring gaps" catches repeats. Text is code-built by the script (ask id,
// expected and observed tool and action names, the ask phrase); the model's replies never leave the Mac.
import {run,nowIso} from './service.js';
import {auditRow} from './actions.js';
const ASK_ID=/^a\d{3}$/,MAX_FAILURES=100,clip=(v,n)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);
export async function recordEval(env,input){
  const asks=Number(input?.asks),passed=Number(input?.passed);
  if(!Number.isInteger(asks)||!Number.isInteger(passed)||asks<0||asks>1000||passed<0||passed>asks)throw new Error('asks and passed must be counts');
  const failures=(Array.isArray(input.failures)?input.failures:[]).filter(f=>f&&ASK_ID.test(String(f.id))).slice(0,MAX_FAILURES);
  const id=crypto.randomUUID(),now=nowIso(),day=now.slice(0,10),stmts=[];
  stmts.push(env.DB.prepare('INSERT INTO eval_runs(id,created_at,asks,passed,failing_ids) VALUES(?,?,?,?,?)').bind(id,now,asks,passed,JSON.stringify(failures.map(f=>f.id))));
  // One capability request per failing ask per day, so a rerun the same day never floods the review.
  let logged=0;
  for(const f of failures){
    const first=await run(env,'INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)',`eval:${f.id}:${day}`,now);if(!first.meta.changes)continue;logged++;
    stmts.push(env.DB.prepare('INSERT INTO capability_requests(id,created_at,what,why,text,proposal_id,interaction_id) VALUES(?,?,?,?,?,NULL,NULL)').bind(crypto.randomUUID(),now,`eval ${f.id}: ${clip(f.what,300)||'failed'}`,clip(f.why,300)||null,clip(f.text,300)||'(no text)'));
  }
  await env.DB.batch(stmts);await auditRow(env,'eval:recorded',`${passed}/${asks}`);
  return {id,asks,passed,failures:failures.length,logged};
}
