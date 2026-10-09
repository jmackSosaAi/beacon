-- Contacts: the only source of call and draft recipients. Added only through an approved proposal from Jackson's own channel.
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, phone TEXT, email TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, origin TEXT NOT NULL);
-- Bridged calls: one-use TwiML token per approved call; the number is read from contacts when Twilio fetches it. Rows also back the 5-per-hour cap.
CREATE TABLE IF NOT EXISTS bridge_calls (token_hash TEXT PRIMARY KEY, contact_id TEXT NOT NULL, proposal_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, call_sid TEXT);
CREATE INDEX IF NOT EXISTS bridge_calls_created ON bridge_calls(created_at);
CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at);
