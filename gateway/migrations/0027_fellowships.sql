-- Fellowship and trek pages watched weekly (M5). Page text is untrusted: only code reads it (keyword sections hashed,
-- dates extracted by regex); no model ever sees it.
CREATE TABLE IF NOT EXISTS watch_pages (
 id TEXT PRIMARY KEY, hash TEXT, dates TEXT, status TEXT, checked_at TEXT, changed_at TEXT, flagged TEXT
);
