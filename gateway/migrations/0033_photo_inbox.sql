-- Photos sent in Telegram, sorted into buckets in the life folder (~/Jackson Mackney) by the Mac node (photo.js).
-- The image itself stays in Telegram until the node saves it; nothing here holds the bytes.
CREATE TABLE IF NOT EXISTS photo_inbox (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
 caption TEXT, forwarded INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','filing','filed','failed')),
 bucket TEXT, course TEXT, title TEXT, path TEXT, job_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photo_inbox_status ON photo_inbox(status,created_at);
-- node_jobs gains the 'save_photo' kind (the Mac saves a sorted photo). Rebuilt because SQLite can't alter a CHECK.
CREATE TABLE node_jobs_v3 (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','send_file','pull','fix','save_photo')), prompt TEXT, query TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','cancelled')),
 origin TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, claimed_at TEXT, finished_at TEXT, result TEXT, proposal_id TEXT
);
INSERT INTO node_jobs_v3(id,kind,prompt,query,status,origin,created_at,approved_at,claimed_at,finished_at,result,proposal_id)
 SELECT id,kind,prompt,query,status,origin,created_at,approved_at,claimed_at,finished_at,result,proposal_id FROM node_jobs;
DROP TABLE node_jobs;
ALTER TABLE node_jobs_v3 RENAME TO node_jobs;
CREATE INDEX IF NOT EXISTS node_jobs_queue ON node_jobs(status,created_at);
