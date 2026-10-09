-- Gmail drafts Beacon created (Jackson sends them himself from Gmail). Body kept so edits can be applied.
CREATE TABLE IF NOT EXISTS drafts (
 id TEXT PRIMARY KEY, gmail_draft_id TEXT, contact_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_updated ON drafts(updated_at);
