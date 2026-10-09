-- Proposals: the only thing a confirmation can execute. One-use, expiring, bound to exact args.
CREATE TABLE IF NOT EXISTS proposals (
 id TEXT PRIMARY KEY, action TEXT NOT NULL, args_hash TEXT NOT NULL, origin TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_expiry ON proposals(expires_at);
