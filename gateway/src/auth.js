export async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function equalSecret(a,b) { if (!a || !b) return false; const [x,y]=await Promise.all([hash(a),hash(b)]); let diff=0;for(let i=0;i<x.length;i++) diff|=x.charCodeAt(i)^y.charCodeAt(i);return diff===0; }
export function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function authenticate(request,env) {
  // Admin key lives only on Jackson's laptop; the service key is for imports, calls and GroupMe.
  if(env.ADMIN_KEY&&await equalSecret(request.headers.get('X-Jarvis-Admin-Key'),env.ADMIN_KEY)) return 'admin';
  if(await equalSecret(request.headers.get('X-Jarvis-Key'),env.GATEWAY_KEY)) return 'service';
  // The Mac node's key: /api/node/* only (enforced in the router).
  if(env.NODE_TOKEN&&await equalSecret(request.headers.get('X-Jarvis-Node-Key'),env.NODE_TOKEN)) return 'node';
  const token=sessionToken(request);
  if(!token) return null;
  const tokenHash=await hash(token),now=Date.now(),session=await env.DB.prepare('SELECT expires_at,last_seen_at FROM sessions WHERE token_hash=?').bind(tokenHash).first();
  if(!session||session.expires_at<=new Date(now).toISOString()||(session.last_seen_at&&Date.parse(session.last_seen_at)<now-IDLE_MS))return null;
  // Touch at most every 10 minutes to keep D1 writes low; idle precision doesn't need more.
  if(!session.last_seen_at||Date.parse(session.last_seen_at)<now-600000)await env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').bind(new Date(now).toISOString(),tokenHash).run();
  return 'user';
}
export const SESSION_COOKIE='__Host-jarvis_session',SESSION_DAYS=30,IDLE_MS=7*86400000;
// Transition: the old jarvis_session name is still read (until existing 30-day sessions lapse) but never set.
export function sessionToken(request){const cookie=request.headers.get('Cookie')||'';return cookie.match(/(?:^|;\s*)__Host-jarvis_session=([^;]+)/)?.[1]||cookie.match(/(?:^|;\s*)jarvis_session=([^;]+)/)?.[1]||null;}
export const sessionCookie=(value,maxAge)=>`${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
// The label is picked from fixed lists, never echoed from the User-Agent, because it goes into a Telegram notice.
export function deviceLabel(ua=''){
  ua=String(ua||'');
  const os=/iPhone/.test(ua)?'iPhone':/iPad/.test(ua)?'iPad':/Android/.test(ua)?'Android':/CrOS/.test(ua)?'ChromeOS':/Macintosh|Mac OS X/.test(ua)?'Mac':/Windows/.test(ua)?'Windows':/Linux/.test(ua)?'Linux':'unknown device';
  const browser=/Edg[A-Z]?\//.test(ua)?'Edge':/Firefox|FxiOS/.test(ua)?'Firefox':/CriOS|Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':/curl|python|node|Go-http|wget/i.test(ua)?'Script':'Unknown browser';
  return `${browser} on ${os}`;
}
// Fixed-window counters in D1 (no extra bindings): [max, window]. Keyed by hashed CF-Connecting-IP, never the raw IP.
export const LIMITS={login:[10,15*60000],voice:[10,3600000],oauth:[10,3600000],key:[20,3600000]};
export async function rateLimited(env,request,scope,increment=true){
  const [max,ms]=LIMITS[scope],start=Math.floor(Date.now()/ms)*ms,ip=(await hash(request.headers.get('CF-Connecting-IP')||'unknown')).slice(0,16),key=`${scope}:${ip}:${start}`,expires=new Date(start+ms).toISOString();
  const row=increment?await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,expires).first():await env.DB.prepare('SELECT count FROM rate_limits WHERE key=?').bind(key).first();
  const n=row?.count||0;
  if(increment?n<=max:n<max)return false;
  // One audit row per blocked bucket and window, so a flood can't grow the audit table without bound.
  const first=await env.DB.prepare('INSERT OR IGNORE INTO rate_limits(key,count,expires_at) VALUES(?,0,?)').bind(key+':logged',expires).run();
  if(first.meta.changes)await env.DB.prepare('INSERT INTO audit VALUES(?,?,?,?)').bind(crypto.randomUUID(),`ratelimit:blocked:${scope}`,ip,new Date().toISOString()).run();
  return true;
}
export async function validateTwilio(request,env,params={}) {
  if(!env.TWILIO_TOKEN) return false;
  const input=request.url+Object.keys(params).sort().map(k=>k+params[k]).join('');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TWILIO_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(input)));
  return equalSecret(btoa(String.fromCharCode(...bytes)),request.headers.get('X-Twilio-Signature'));
}
