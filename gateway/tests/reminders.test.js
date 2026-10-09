import {describe,it,expect} from 'vitest';
import {validateReminder,renderReminder,dueReminders,LATE_MS} from '../src/reminders.js';
import {ACTIONS,validateAction} from '../src/actions.js';

// Minimal D1 stand-in: just enough SQL for reminders.js.
function fakeEnv(rows=[],paused=false){
  const db={rows:rows.map(r=>({...r}))};
  const stmt=(sql,args=[])=>({
    bind:(...a)=>stmt(sql,a),
    first:async()=>sql.includes("id='paused'")?(paused?{value:'true'}:null):null,
    all:async()=>({results:sql.includes('FROM reminder_calls')?db.rows.filter(r=>r.status==='pending'&&r.call_at<=args[0]).sort((a,b)=>a.call_at<b.call_at?-1:1):[]}),
    run:async()=>{
      if(sql.startsWith('UPDATE reminder_calls SET status=? WHERE id=? AND status=')){const r=db.rows.find(x=>x.id===args[1]&&x.status==='pending');if(r)r.status=args[0];return {meta:{changes:r?1:0}};}
      if(sql.startsWith('UPDATE reminder_calls SET status=?,called_at=?')){const r=db.rows.find(x=>x.id===args[2]);r.status=args[0];r.called_at=args[1];return {meta:{changes:1}};}
      return {meta:{changes:1}};
    }});
  return {db,DB:{prepare:sql=>stmt(sql)},TELEGRAM_TOKEN:'',TELEGRAM_CHAT_ID:''};
}
const NOW=Date.parse('2026-10-09T18:00:00Z');

describe('reminder calls',()=>{
  it('validates a future time and his text, and rejects past, far-future, or empty',()=>{
    expect(validateReminder({start:'2026-10-09T14:00:00-05:00',title:' Ask  Eveline '},NOW-3600000)).toEqual({type:'reminder_call',start:'2026-10-09T19:00:00.000Z',title:'Ask Eveline'});
    expect(validateReminder({start:'2026-10-09T12:00:00-05:00',title:'x'},NOW)).toBeNull();
    expect(validateReminder({start:'2026-12-30T12:00:00-05:00',title:'x'},NOW)).toBeNull();
    expect(validateReminder({start:'2026-10-09T14:00:00-05:00',title:'   '},NOW-3600000)).toBeNull();
    expect(validateReminder({start:'not a date',title:'x'},NOW)).toBeNull();
  });
  it('is a Confirm-tier action in the registry with a code-written read-back',()=>{
    expect(ACTIONS.reminder_call.tier).toBe('confirm');
    expect(renderReminder({start:'2026-10-09T19:00:00.000Z',title:'Ask Eveline'})).toContain('2:00');
  });
  it('rings once when due, never twice, and marks stale rows missed instead of calling',async()=>{
    const env=fakeEnv([
      {id:'a',text:'Ask Eveline',call_at:new Date(NOW-60000).toISOString(),status:'pending'},
      {id:'b',text:'Old',call_at:new Date(NOW-LATE_MS-60000).toISOString(),status:'pending'},
      {id:'c',text:'Later',call_at:new Date(NOW+3600000).toISOString(),status:'pending'}]);
    const calls=[];const call=async(e,r)=>{calls.push(r.id);return {called:true};};
    const out=await dueReminders(env,new Date(NOW),{call});
    expect(calls).toEqual(['a']);
    expect(env.db.rows.find(r=>r.id==='a').status).toBe('called');
    expect(env.db.rows.find(r=>r.id==='b').status).toBe('missed');
    expect(env.db.rows.find(r=>r.id==='c').status).toBe('pending');
    await dueReminders(env,new Date(NOW+60000),{call});
    expect(calls).toEqual(['a']);
    expect(out.map(o=>o.status).sort()).toEqual(['called','missed']);
  });
  it('does nothing while Beacon is paused',async()=>{
    const env=fakeEnv([{id:'a',text:'x',call_at:new Date(NOW-60000).toISOString(),status:'pending'}],true);
    const calls=[];await dueReminders(env,new Date(NOW),{call:async(e,r)=>{calls.push(r.id);return {called:true};}});
    expect(calls).toEqual([]);expect(env.db.rows[0].status).toBe('pending');
  });
  it('marks failed when the call does not go through',async()=>{
    const env=fakeEnv([{id:'a',text:'x',call_at:new Date(NOW-60000).toISOString(),status:'pending'}]);
    await dueReminders(env,new Date(NOW),{call:async()=>({called:false})});
    expect(env.db.rows[0].status).toBe('failed');
  });
});
