-- Jobs for the Mac node (agent-node/jarvis-node.mjs). Agent tasks are queued only after an approved proposal;
-- send_file is Auto (read-only, to Jackson only). The node's last check-in is settings.node_seen.
CREATE TABLE IF NOT EXISTS node_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','send_file')), prompt TEXT, query TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','cancelled')),
 origin TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, claimed_at TEXT, finished_at TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS node_jobs_queue ON node_jobs(status,created_at);
