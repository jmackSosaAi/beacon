-- Step-up (SAFETY.md Identity): unpausing, resetting a circuit breaker, connecting Google and editing contacts
-- need a fresh single-use link minted with the laptop-only admin key. Claiming it marks this web session for 15 minutes.
CREATE TABLE IF NOT EXISTS step_up_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
ALTER TABLE sessions ADD COLUMN stepup_until TEXT;
