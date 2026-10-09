-- Node jobs v2: allowlisted kinds now include 'pull' (git pull after Beacon commits) and 'fix' (overnight fix
-- session on a branch), and task jobs carry the approved proposal id. Rebuilt because SQLite can't alter a CHECK.
CREATE TABLE node_jobs_v2 (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','send_file','pull','fix')), prompt TEXT, query TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','cancelled')),
 origin TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, claimed_at TEXT, finished_at TEXT, result TEXT, proposal_id TEXT
);
INSERT INTO node_jobs_v2(id,kind,prompt,query,status,origin,created_at,approved_at,claimed_at,finished_at,result)
 SELECT id,kind,prompt,query,status,origin,created_at,approved_at,claimed_at,finished_at,result FROM node_jobs;
DROP TABLE node_jobs;
ALTER TABLE node_jobs_v2 RENAME TO node_jobs;
CREATE INDEX IF NOT EXISTS node_jobs_queue ON node_jobs(status,created_at);
