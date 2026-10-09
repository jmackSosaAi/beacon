// Trouble signals (M7, design "Trouble signals"), the minimal set derived from rows already written: one tunable weights
// object, rows in interaction_signals, friction = the sum per turn (interactions.js signalsFor). Not yet: the behavioural
// signals that need more sources (draft_abandoned, did_it_manually, frustration_lexicon, thumbs_down, voice_hangup,
// many_tools, recurring_gap) and the once-an-hour "did I get that wrong?" prompt; see ROADMAP M7.
export const WEIGHTS={rephrase:3,slot_swap_after_miss:3,cross_channel_retry:2,card_expired:2,clarification_unanswered:2,fell_back_to_slash:2,clarify_chain:2,verification_ask:2,undo_fast:3,voice_interrupt:1,voice_what:2,slow_turn:1,timeout_fallback:3,tool_error:2,budget_stop:2,empty_lookup:1,capability_gap:3};
const SLOW_MS=15000;
// A correction type on the previous row → the signal written against that row (the model never labels these).
const BY_CORRECTION={rephrase:'rephrase',slot_swap:'slot_swap_after_miss',cross_channel_retry:'cross_channel_retry',clarification_unanswered:'clarification_unanswered',fell_back_to_slash:'fell_back_to_slash',clarify_chain:'clarify_chain',verification_ask:'verification_ask',undo_fast:'undo_fast',interrupted:'voice_interrupt',voice_what:'voice_what',expired:'card_expired'};
export const correctionSignal=type=>BY_CORRECTION[type]||null;
// Signals a turn carries on its own, from its row: fallbacks and deadlines, failed tools, slow turns, budget stops, empty lookups, gaps.
export function turnSignals(r){
  const out=[],tools=Array.isArray(r.tools)?r.tools:[];
  if(r.route==='fell_back'||r.error==='deadline')out.push('timeout_fallback');
  if(r.error==='budget')out.push('budget_stop');
  if(tools.some(t=>!t.ok))out.push('tool_error');
  if(r.latency_ms>SLOW_MS)out.push('slow_turn');
  if(tools.length&&tools.every(t=>t.ok&&/_search$|_recent$/.test(t.name)&&!t.n))out.push('empty_lookup');
  if(r.kind==='gap'||r.capability)out.push('capability_gap');
  return out;
}
export const signalStmt=(env,id,signal,evidence=null)=>env.DB.prepare('INSERT OR REPLACE INTO interaction_signals(interaction_id,signal,weight,evidence) VALUES(?,?,?,?)').bind(id,signal,WEIGHTS[signal]||1,evidence==null?null:String(evidence).slice(0,200));
