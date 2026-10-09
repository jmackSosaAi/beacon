-- Searchable knowledge base: the repo's markdown (plans, tracker, people, criteria, decisions, notes, research),
-- chunked by heading. Never finance/ or the mail-scout sender lists. Refreshed by scripts/kb-index.mjs.
CREATE VIRTUAL TABLE IF NOT EXISTS kb USING fts5(path UNINDEXED, title, body, tokenize='porter');
CREATE TABLE IF NOT EXISTS kb_docs (path TEXT PRIMARY KEY, hash TEXT NOT NULL, updated_at TEXT NOT NULL);
