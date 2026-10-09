#!/usr/bin/env node
// Cloudflare deploy token (~/.config/jarvis/cf_token, scoped: Workers Scripts + D1 edit, Account Settings read).
//   node scripts/cf-token.mjs check          → verifies it with Cloudflare; prints status only, never the token
//   node scripts/cf-token.mjs run <cmd...>   → runs a command (e.g. npx wrangler deploy) with CLOUDFLARE_API_TOKEN set
import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
const file=homedir()+'/.config/jarvis/cf_token';
if(!existsSync(file)){console.log('No token saved yet (~/.config/jarvis/cf_token missing).');process.exit(1);}
const token=readFileSync(file,'utf8').trim(),[cmd,...rest]=process.argv.slice(2);
if(cmd==='run'){const r=spawnSync(rest[0],rest.slice(1),{stdio:'inherit',env:{...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:process.env.CLOUDFLARE_ACCOUNT_ID||''}});process.exit(r.status??1);}
const r=await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json()).catch(()=>null);
console.log(r?.success?`Token valid: ${r.result.status}, expires ${r.result.expires_on||'never'}.`:`Token not valid: ${r?.errors?.[0]?.message||'no response'}.`);
// Keep Beacon's expiry reminder in sync with the real date (admin key; dates only).
if(r?.success&&r.result.expires_on){const admin=readFileSync(homedir()+'/.config/jarvis/admin_key','utf8').trim();
  const u=await fetch('https://your-worker.example.workers.dev/api/credentials',{method:'POST',headers:{'X-Jarvis-Admin-Key':admin,'content-type':'application/json'},body:JSON.stringify({id:'cloudflare',expires_at:r.result.expires_on})}).then(r=>r.json()).catch(()=>null);
  console.log(u?.updated?'Beacon expiry reminder updated.':'Could not update Beacon expiry reminder.');}
