-- Scouting report of recurring bulk senders per inbox (for choosing what to unsubscribe from).
-- Bulk mail only (List-Unsubscribe or no-reply style senders); people writing to Jackson are never recorded.
CREATE TABLE IF NOT EXISTS mail_scan (
 account TEXT NOT NULL, sender TEXT NOT NULL, name TEXT, domain TEXT, count INTEGER NOT NULL DEFAULT 0,
 first_at TEXT, last_at TEXT, unsub_oneclick INTEGER NOT NULL DEFAULT 0, unsub_http INTEGER NOT NULL DEFAULT 0,
 unsub_mailto INTEGER NOT NULL DEFAULT 0, subject TEXT, PRIMARY KEY(account,sender)
);
