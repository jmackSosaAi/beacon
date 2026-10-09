-- Typed vs called tracking: messages gets the channel (web|telegram|voice; NULL = before this migration), every voice call gets one
-- `calls` row (opened when the socket is claimed, closed on hang-up), and the weekly model-written self-review is kept in D1 only
-- (reviews/ is indexed into the knowledge base, so model prose never goes there).
ALTER TABLE messages ADD COLUMN channel TEXT;
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
 turns INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, pin_failures INTEGER NOT NULL DEFAULT 0,
 ended_by TEXT);                                                                                           -- hangup|limit|turn_cap|pin_lockout; NULL ended_at = socket never closed cleanly
CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at);
CREATE TABLE IF NOT EXISTS review_synthesis (week TEXT PRIMARY KEY, created_at TEXT NOT NULL, model TEXT, turns INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
