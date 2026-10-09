CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','started','partial','done','stuck','skipped')),
 category TEXT NOT NULL DEFAULT 'personal', due_at TEXT, source TEXT NOT NULL,
 source_url TEXT, confidence TEXT NOT NULL DEFAULT 'unconfirmed',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS blocks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, category TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','started','partial','done','stuck','skipped')),
 note TEXT NOT NULL DEFAULT '', actual_minutes INTEGER, calendar_url TEXT,
 active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_time ON blocks(active,start_at,end_at);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL,
 block_id TEXT, created_at TEXT NOT NULL, read_at TEXT,
 delivery TEXT NOT NULL DEFAULT 'inbox', attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, subscription TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, status TEXT NOT NULL, last_success TEXT, detail TEXT NOT NULL DEFAULT '',
 coverage_end TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dedupe (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS voice_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('preferences','{"timezone":"America/Chicago","morning":"07:15","evening":"19:00","weekly":"16:45","quietStart":23,"quietEnd":7,"notifications":true,"persianTargetMinutes":360,"automaticRescheduling":false}');
