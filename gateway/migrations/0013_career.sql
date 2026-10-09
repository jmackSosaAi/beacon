-- Career engine (M5). Outreach is imported from Jackson's local tracker/outreach.md with the admin key.
-- replied_at is set only by Gmail triage (a verified In-Reply-To reply); imports never clear it.
CREATE TABLE IF NOT EXISTS outreach (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL, domain TEXT, sent_at TEXT, last_reply_at TEXT,
 status TEXT NOT NULL DEFAULT '', replied_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outreach_domain ON outreach(domain);
-- Scout finds from public job boards (untrusted text). url is built by code from the board slug and posting id.
CREATE TABLE IF NOT EXISTS scout_jobs (
 id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL, url TEXT NOT NULL,
 score INTEGER NOT NULL, found_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS scout_jobs_found ON scout_jobs(found_at);
