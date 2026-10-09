-- Credentials that expire, so Beacon can warn Jackson (Telegram 14 and 7 days out, a call 3 days out and on the day).
-- Names and dates only; never the credential itself.
CREATE TABLE IF NOT EXISTS credential_expiry (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at TEXT NOT NULL, renew TEXT NOT NULL
);
INSERT OR IGNORE INTO credential_expiry VALUES
 ('cloudflare','Cloudflare deploy token','2027-01-04T07:00:00Z','Cloudflare → My Profile → API Tokens → roll or recreate "jarvis-gateway deploy", save it with the hidden-input command, then run node scripts/cf-token.mjs check.'),
 ('github','GitHub token for notes and feedback','2027-01-03T06:00:00Z','GitHub → Settings → Developer settings → fine-grained tokens → regenerate the Beacon token, then update the GITHUB_TOKEN Worker secret.');
