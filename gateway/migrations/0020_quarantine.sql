-- Senders Jackson chose to quarantine: a Gmail filter skips the inbox and labels them "Quarantine";
-- Beacon also stops alerting on them. Unsubscribes are audited only.
CREATE TABLE IF NOT EXISTS quarantine (
 account TEXT NOT NULL, sender TEXT NOT NULL, filter_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(account,sender)
);
