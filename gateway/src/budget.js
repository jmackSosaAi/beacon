// Daily Claude budget (M2, per-model since M7). Every Claude call goes through claude() or claudeMessages(): they check
// today's weighted token total against preferences.llmDailyTokenCap, record calls and tokens per Chicago day, purpose and
// model in D1, and return null when over the cap so each caller falls back in code (triage → digest, news → plain
// headlines, chat → limit reply, agent → single-shot converse()).
import {localParts} from './core.js';
import {sendTelegram} from './tgapi.js';

// List prices by model-id prefix, USD per million tokens (in, out, cache read). The only place pricing lives.
export const PRICES={'claude-sonnet-5-5':{in:2,out:10,cache:0.2},'claude-haiku-4-5':{in:1,out:5,cache:0.1}};
export const PLANNER='claude-sonnet-5-5',READER='claude-haiku-4-5-20251001',DEFAULT_MODEL=READER;
export const DEFAULT_CAP=400000,AGENT_CAP=1000000;
const priceOf=model=>PRICES[Object.keys(PRICES).find(p=>String(model||'').startsWith(p))]||PRICES['claude-haiku-4-5'];
export const costOf=(model,input,output,cache=0)=>{const p=priceOf(model);return (input*p.in+output*p.out+cache*p.cache)/1e6;};
// Cap math: cached reads cost a tenth, so they count a tenth.
export const weighted=(input,output,cache=0)=>input+output+Math.round(cache*0.1);
const approx=value=>Math.ceil(String(value??'').length/4);

export async function tokenCap(env,key='llmDailyTokenCap',fallback=DEFAULT_CAP){
  const row=await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first();
  const cap=Number(JSON.parse(row?.value||'{}')[key]);
  return Number.isInteger(cap)&&cap>0?cap:fallback;
}
export async function usageToday(env,at=new Date(),purpose=null){
  const day=localParts(at).date,cap=await tokenCap(env,...(purpose==='agent'?['agentDailyTokenCap',AGENT_CAP]:[]));
  const rows=(await env.DB.prepare(`SELECT purpose,model,calls,input_tokens,output_tokens,cache_read_tokens FROM llm_usage WHERE day=?${purpose?' AND purpose=?':''}`).bind(day,...(purpose?[purpose]:[])).all()).results;
  const sum=k=>rows.reduce((n,r)=>n+(r[k]||0),0),input=sum('input_tokens'),output=sum('output_tokens'),cache=sum('cache_read_tokens'),tokens=weighted(input,output,cache);
  const cost=rows.reduce((c,r)=>c+costOf(r.model,r.input_tokens,r.output_tokens,r.cache_read_tokens),0);
  return {day,calls:sum('calls'),input_tokens:input,output_tokens:output,cache_read_tokens:cache,tokens,cap,cost:Math.round(cost*10000)/10000,over:tokens>=cap};
}
export const usageLine=u=>`AI today: ${u.calls} call${u.calls===1?'':'s'}, ${Math.round(u.tokens/100)/10}k of ${Math.round(u.cap/1000)}k tokens (~$${u.cost.toFixed(2)})${u.over?' — daily limit reached':''}`;

// One Telegram notice per day. Numbers only, no content.
async function capNotice(env,u){
  const first=await env.DB.prepare('INSERT OR IGNORE INTO dedupe(id,created_at) VALUES(?,?)').bind(`llm-cap:${u.day}`,new Date().toISOString()).run();
  if(first.meta.changes)await sendTelegram(env,`⚠️ Beacon reached its daily AI limit (${u.tokens} of ${u.cap} tokens, ~$${u.cost.toFixed(2)}). Until midnight: email goes to the digest unsorted, news is plain headlines, and chat is paused. Capture and check-in buttons still work.`)?.catch?.(()=>null);
}
export async function overBudget(env){const u=await usageToday(env);if(u.over)await capNotice(env,u);return u.over;}

export async function recordUsage(env,purpose,input,output,model=null,cache=0){
  await env.DB.prepare('INSERT INTO llm_usage(day,purpose,calls,input_tokens,output_tokens,model,cache_read_tokens) VALUES(?,?,1,?,?,?,?) ON CONFLICT(day,purpose) DO UPDATE SET calls=calls+1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,model=COALESCE(excluded.model,model),cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens').bind(localParts().date,purpose,input,output,model,cache).run();
}
// Usage from the response when present, otherwise ~4 characters per token. Cache creation is billed as input.
const usageOf=(result,body,text)=>{
  const u=result.usage||{},ok=Number.isFinite(u.input_tokens);
  return {input:ok?u.input_tokens+(u.cache_creation_input_tokens||0):approx(JSON.stringify(body)),output:Number.isFinite(u.output_tokens)?u.output_tokens:approx(text),cache_read:ok?(u.cache_read_input_tokens||0):0};
};
// Full Messages API response ({content,stop_reason,usage}) or null when over budget; supports tools. Throws 'model' on HTTP failure.
// body.model picks the model; usage is recorded under that model so costOf() prices each purpose correctly.
export async function claudeMessages(env,purpose,body,ms){
  if(await overBudget(env))return null;
  const model=body.model||env.CLAUDE_MODEL||DEFAULT_MODEL;
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({...body,model}),signal:AbortSignal.timeout(ms)});
  if(!r.ok){await recordUsage(env,purpose,0,0,model);throw new Error('model');}
  const result=await r.json(),content=Array.isArray(result.content)?result.content:[];
  const text=content.filter(c=>c.type==='text').map(c=>c.text).join(''),usage=usageOf(result,body,text);
  await recordUsage(env,purpose,usage.input,usage.output,model,usage.cache_read);
  return {content,stop_reason:result.stop_reason||null,usage};
}
export const claudeMessage=claudeMessages;
// Returns the response text, or null when over budget. Single-shot callers (triage, news, converse) stay on this.
export async function claude(env,purpose,body,ms){
  const r=await claudeMessages(env,purpose,body,ms);
  return r&&r.content.filter(c=>c.type==='text').map(c=>c.text).join('');
}
