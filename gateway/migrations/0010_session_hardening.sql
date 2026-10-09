-- Sessions: idle timeout (last_seen_at) and a short device label built in code from a fixed list (never raw User-Agent).
ALTER TABLE sessions ADD COLUMN created_at TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN device TEXT;
-- Fixed-window rate-limit counters keyed by scope + hashed client IP + window start. No raw IPs stored.
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
