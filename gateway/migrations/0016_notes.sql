-- Jackson's own notes and feedback about Beacon, captured by voice/Telegram/web in his exact words.
-- Exported to the repo (notes/INBOX.md, feedback/BEACON_FEEDBACK.md) by scripts/export-notes.mjs.
CREATE TABLE IF NOT EXISTS notes (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('note','feedback')), text TEXT NOT NULL,
 channel TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, exported_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_export ON notes(exported_at,created_at);
