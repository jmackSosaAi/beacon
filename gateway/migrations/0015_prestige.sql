-- Cached employer prestige ratings (1-5) for the job scout's minimum threshold. Company names only.
CREATE TABLE IF NOT EXISTS prestige_cache (company TEXT PRIMARY KEY, score INTEGER NOT NULL, source TEXT NOT NULL, rated_at TEXT NOT NULL);
