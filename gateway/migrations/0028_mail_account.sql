-- Which Google account each triaged email came from ('personal' or 'school'), so "what's new in my school email" can filter.
ALTER TABLE mail_items ADD COLUMN account TEXT;
CREATE INDEX IF NOT EXISTS mail_items_account ON mail_items(account,received_at);
