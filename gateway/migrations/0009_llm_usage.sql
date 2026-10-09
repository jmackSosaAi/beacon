-- Daily Claude usage per purpose (converse, triage, news), keyed by America/Chicago date. Counts only, no content.
CREATE TABLE IF NOT EXISTS llm_usage (
 day TEXT NOT NULL, purpose TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day,purpose)
);
