-- Task priority (1 high, 2 normal, 3 low) for "what's next?", and a 24-hour Undo log with before-images
-- for reversible Auto actions (task add/done/priority, calendar writes). Undo restores the before-image once.
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 2;
CREATE TABLE IF NOT EXISTS action_undo (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, target TEXT NOT NULL, before TEXT, created_at TEXT NOT NULL, undone_at TEXT
);
CREATE INDEX IF NOT EXISTS action_undo_recent ON action_undo(created_at);
