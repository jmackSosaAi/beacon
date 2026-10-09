-- Drafts can be written to either connected Google account: personal Gmail or UChicago.
ALTER TABLE drafts ADD COLUMN account TEXT NOT NULL DEFAULT 'personal' CHECK(account IN ('personal','school'));
