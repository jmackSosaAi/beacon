-- Finance alerts (M4). Derived fields only (DATA.md): merchant, amount, date and issuer. No card or account numbers, no statement text.
CREATE TABLE IF NOT EXISTS charges (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, merchant TEXT NOT NULL, merchant_key TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, charged_on TEXT NOT NULL, subscription TEXT, alert TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS charges_merchant ON charges(merchant_key);
CREATE INDEX IF NOT EXISTS charges_date ON charges(charged_on);
-- Imported from Jackson's local finance/subscriptions.md with the admin key. pattern = normalized merchant text it matches.
CREATE TABLE IF NOT EXISTS known_subscriptions (
 pattern TEXT PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL,
 cadence TEXT NOT NULL CHECK(cadence IN ('monthly','annual')), billing_day INTEGER, next_due TEXT, updated_at TEXT NOT NULL
);
