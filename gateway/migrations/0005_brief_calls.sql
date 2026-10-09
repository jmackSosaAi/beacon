-- One-use spoken briefs: Twilio fetches the text once, by token, on a signed request.
CREATE TABLE IF NOT EXISTS brief_calls (
 token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, code TEXT NOT NULL,
 call_sid TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
