-- Agentic Beacon (M7, decisions/agentic-beacon.md "Schemas"). Per-model pricing, the interaction log, capability requests,
-- the full synced calendar, in-thread drafts and eval runs. agent_state is a settings row ('agent_working_set'), not a table.
ALTER TABLE llm_usage ADD COLUMN model TEXT; ALTER TABLE llm_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;  -- PK stays (day,purpose); one model per purpose
ALTER TABLE drafts ADD COLUMN cc TEXT NOT NULL DEFAULT ''; ALTER TABLE drafts ADD COLUMN bcc TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN thread_id TEXT; ALTER TABLE drafts ADD COLUMN in_reply_to TEXT;            -- cc/bcc: JSON arrays of contact ids
ALTER TABLE mail_items ADD COLUMN thread_id TEXT; ALTER TABLE mail_items ADD COLUMN message_id TEXT;      -- Message-ID added to metadataHeaders in google.js
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
 owned INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL, updated_at TEXT NOT NULL);                    -- full calendar −1d..+15d, same 15-min sync; blocks stays the work subset
CREATE INDEX IF NOT EXISTS events_start ON events(start_at);                                              -- category by code: course words → class, 'Career —' → work, else personal
CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, channel TEXT NOT NULL, route TEXT NOT NULL,  -- fast:schedule|fast:mail|fast:assignments|followup|undo|agent|command|fell_back
 text TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]',                                                    -- [{name,ms,ok,arg_keys,n}]: never free-text args, bodies or summaries
 reply TEXT, reply_len INTEGER NOT NULL DEFAULT 0, reply_withheld INTEGER NOT NULL DEFAULT 0,             -- reply NULL + withheld=1 on email_read turns
 action_type TEXT, proposal_id TEXT, undo_id TEXT, note_id TEXT, latency_ms INTEGER, model TEXT,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL CHECK (kind IN ('turn','error','gap','undone')), error TEXT,                           -- error: short code (deadline, budget, google_401, model_http, parse), never e.message
 tainted INTEGER NOT NULL DEFAULT 0, demoted TEXT, corrected_by TEXT, correction_type TEXT, correction TEXT);
CREATE INDEX IF NOT EXISTS interactions_created ON interactions(created_at);
CREATE TABLE IF NOT EXISTS interaction_signals (interaction_id TEXT NOT NULL, signal TEXT NOT NULL, weight INTEGER NOT NULL, evidence TEXT, PRIMARY KEY(interaction_id,signal));
CREATE TABLE IF NOT EXISTS capability_requests (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, what TEXT NOT NULL, why TEXT, text TEXT NOT NULL, proposal_id TEXT, interaction_id TEXT);
CREATE TABLE IF NOT EXISTS eval_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, asks INTEGER NOT NULL, passed INTEGER NOT NULL, failing_ids TEXT NOT NULL DEFAULT '[]');
