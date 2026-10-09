-- Quarantined mail is still checked: a flag for anything that needs Jackson (subject and sender only, no body),
-- reviewed weekly. Senders with nothing useful for 4 weeks get one "unsubscribe or keep?" nudge.
CREATE TABLE IF NOT EXISTS quarantine_items (
 id TEXT PRIMARY KEY, account TEXT NOT NULL, sender TEXT NOT NULL, name TEXT, subject TEXT NOT NULL,
 received_at TEXT NOT NULL, important INTEGER NOT NULL DEFAULT 0, reason TEXT
);
CREATE INDEX IF NOT EXISTS quarantine_items_week ON quarantine_items(received_at);
CREATE TABLE IF NOT EXISTS quarantine_nudges (
 id TEXT PRIMARY KEY, account TEXT NOT NULL, sender TEXT NOT NULL, created_at TEXT NOT NULL, decision TEXT
);
