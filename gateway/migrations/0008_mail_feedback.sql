-- Jackson's 👍/👎 on email alerts, per mail_items row, and sender rules derived from them in code.
-- Rules only ever demote a domain to the digest; they never promote and never touch phishing or school records.
ALTER TABLE mail_items ADD COLUMN domain TEXT;
ALTER TABLE mail_items ADD COLUMN feedback TEXT CHECK(feedback IN ('matters','ignore'));
ALTER TABLE mail_items ADD COLUMN feedback_at TEXT;
CREATE INDEX IF NOT EXISTS mail_items_feedback ON mail_items(domain,feedback);
CREATE TABLE IF NOT EXISTS sender_rules (
 domain TEXT PRIMARY KEY, level TEXT NOT NULL CHECK(level IN ('digest')), reason TEXT NOT NULL, created_at TEXT NOT NULL
);
