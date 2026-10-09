// Pre-commit scan for anything Beacon writes to the repo (Worker note commits and the node's git pushes).
// Secrets (gitleaks-style patterns) and personal data (SSNs, card numbers that pass Luhn, routing+account pairs).
// Pure: no imports, so the node (agent-node/jarvis-node.mjs) can import it too.
const SECRETS=[['Anthropic key',/sk-ant-[A-Za-z0-9_-]{20,}/],['AWS key',/AKIA[0-9A-Z]{16}/],['GitHub token',/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
 ['Slack token',/xox[abpr]-[A-Za-z0-9-]{10,}/],['Google OAuth secret',/GOCSPX-[A-Za-z0-9_-]{20,}/],['private key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
 ['Telegram bot token',/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/],['Twilio key',/\b(?:SK|AC)[0-9a-f]{32}\b/],['Stripe key',/\b[sr]k_live_[A-Za-z0-9]{20,}/],
 ['generic secret',/\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{24,}/i]];
const luhn=d=>{let s=0;for(let i=0;i<d.length;i++){let n=+d[d.length-1-i];if(i%2){n*=2;if(n>9)n-=9;}s+=n;}return s%10===0;};
const aba=d=>d.length===9&&(3*(+d[0]+ +d[3]+ +d[6])+7*(+d[1]+ +d[4]+ +d[7])+(+d[2]+ +d[5]+ +d[8]))%10===0;
export function scanText(text){
  const t=String(text||''),found=new Set();
  for(const [kind,re] of SECRETS)if(re.test(t))found.add(kind);
  if(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/.test(t))found.add('Social Security number');
  for(const m of t.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)){const d=m[0].replace(/\D/g,'');if(d.length>=13&&d.length<=19&&luhn(d)&&!/^(\d)\1+$/.test(d))found.add('card number');}
  if(/routing|aba\b/i.test(t)&&/account|acct/i.test(t)&&[...t.matchAll(/\b\d{9}\b/g)].some(m=>aba(m[0])))found.add('bank routing and account numbers');
  return [...found];
}
