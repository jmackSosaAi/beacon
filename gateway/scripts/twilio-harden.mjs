#!/usr/bin/env node
// Twilio account hardening via the API (ROADMAP M0). Reads the SID/token from ~/.config/jarvis; prints no secrets.
//   node scripts/twilio-harden.mjs status   → current voice geo permissions and usage triggers
//   node scripts/twilio-harden.mjs apply    → voice calling US only (no high-risk numbers anywhere), daily $7 spend alert → Telegram
// Before changing geo permissions it saves the previous list to ~/.config/jarvis/twilio-geo-backup.json.
import {readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
const dir=homedir()+'/.config/jarvis/',sid=readFileSync(dir+'twilio_account_sid','utf8').trim(),token=readFileSync(dir+'twilio_auth_token','utf8').trim();
const auth={Authorization:'Basic '+Buffer.from(`${sid}:${token}`).toString('base64')};
const CALLBACK='https://your-worker.example.workers.dev/twilio/usage',DAILY_LIMIT='7';
async function call(url,form){const r=await fetch(url,{method:form?'POST':'GET',headers:{...auth,...(form?{'content-type':'application/x-www-form-urlencoded'}:{})},...(form?{body:new URLSearchParams(form)}:{})});const out=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`${r.status} ${out.message||''}`);return out;}
async function countries(){const all=[];let url='https://voice.twilio.com/v1/DialingPermissions/Countries?PageSize=1000';while(url){const p=await call(url);all.push(...p.content);url=p.meta?.next_page_url;}return all;}
const on=c=>c.low_risk_numbers_enabled||c.high_risk_special_numbers_enabled||c.high_risk_tollfraud_numbers_enabled;
const cmd=process.argv[2]||'status';
const list=await countries(),enabled=list.filter(on);
console.log(`Voice geo permissions: ${enabled.length} of ${list.length} countries enabled: ${enabled.map(c=>c.iso_code+(c.high_risk_special_numbers_enabled||c.high_risk_tollfraud_numbers_enabled?'(+high-risk)':'')).join(', ')||'none'}`);
const triggers=(await call(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Triggers.json`)).usage_triggers||[];
console.log(`Usage triggers: ${triggers.map(t=>`${t.usage_category} ${t.trigger_by} ${t.trigger_value} ${t.recurring||'once'}`).join('; ')||'none'}`);
if(cmd==='apply'){
  writeFileSync(dir+'twilio-geo-backup.json',JSON.stringify(enabled.map(({iso_code,low_risk_numbers_enabled,high_risk_special_numbers_enabled,high_risk_tollfraud_numbers_enabled})=>({iso_code,low_risk_numbers_enabled,high_risk_special_numbers_enabled,high_risk_tollfraud_numbers_enabled})),null,1),{mode:0o600});
  const changes=list.filter(c=>c.iso_code==='US'?(!c.low_risk_numbers_enabled||c.high_risk_special_numbers_enabled||c.high_risk_tollfraud_numbers_enabled):on(c))
    .map(c=>({iso_code:c.iso_code,low_risk_numbers_enabled:c.iso_code==='US'?'true':'false',high_risk_special_numbers_enabled:'false',high_risk_tollfraud_numbers_enabled:'false'}));
  for(let i=0;i<changes.length;i+=100){const r=await call('https://voice.twilio.com/v1/DialingPermissions/BulkCountryUpdates',{UpdateRequest:JSON.stringify(changes.slice(i,i+100))});console.log(`Geo update: ${r.update_count} countries changed.`);}
  if(!changes.length)console.log('Geo permissions already US-only.');
  if(triggers.some(t=>t.callback_url===CALLBACK))console.log('Daily spend alert already exists.');
  else{await call(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Triggers.json`,{CallbackUrl:CALLBACK,CallbackMethod:'POST',TriggerValue:DAILY_LIMIT,UsageCategory:'totalprice',TriggerBy:'price',Recurring:'daily',FriendlyName:'Beacon daily spend alert'});console.log(`Created daily spend alert at $${DAILY_LIMIT} → Telegram.`);}
  const after=(await countries()).filter(on);console.log(`Now enabled: ${after.map(c=>c.iso_code).join(', ')}`);
}
