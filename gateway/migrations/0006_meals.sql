-- Food log (data class C2: Jackson's own diet, user-provided). Estimates, not measurements.
CREATE TABLE IF NOT EXISTS meals (
 id TEXT PRIMARY KEY, eaten_at TEXT NOT NULL, description TEXT NOT NULL, items TEXT NOT NULL,
 calories INTEGER NOT NULL, protein_g INTEGER NOT NULL, carbs_g INTEGER NOT NULL, fat_g INTEGER NOT NULL,
 source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meals_time ON meals(eaten_at);
