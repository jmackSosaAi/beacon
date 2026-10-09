-- Reminder calls: "call me at 2pm tomorrow about X". A Confirm-tier action stores one row; the 5-minute scheduler
-- (service.js tick → reminders.js) rings Jackson's own number once when it comes due. Only his number is ever called.
CREATE TABLE IF NOT EXISTS reminder_calls (
 id TEXT PRIMARY KEY, text TEXT NOT NULL, call_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','calling','called','failed','missed','cancelled')),
 origin TEXT NOT NULL, proposal_id TEXT, created_at TEXT NOT NULL, called_at TEXT
);
CREATE INDEX IF NOT EXISTS reminder_calls_due ON reminder_calls(status,call_at);
