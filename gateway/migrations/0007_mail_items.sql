-- Triage results (metadata only: sender, subject, level, reason). No message bodies are stored.
CREATE TABLE IF NOT EXISTS mail_items (
 id TEXT PRIMARY KEY, received_at TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL,
 level TEXT NOT NULL, reason TEXT NOT NULL, verified INTEGER NOT NULL, briefed_at TEXT
);
CREATE INDEX IF NOT EXISTS mail_items_level ON mail_items(level,briefed_at);
