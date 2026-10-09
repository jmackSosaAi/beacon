# Beacon

A personal assistant that runs on Cloudflare Workers and the Claude API. It triages two Gmail inboxes and a
calendar against rules the owner writes, sends a morning brief and an evening review, and escalates real
emergencies to a phone call (Twilio). It also takes notes, reminders and tasks over Telegram and voice.

**Design rule: the model can only propose.** Drafting an email, moving a meeting or creating a task produces a
one-time Approve/Cancel card; nothing happens until the owner taps it. Incoming email can inform Beacon but can
never trigger an action by itself.

- `gateway/` — the Worker (`src/`), D1 migrations, React UI, tests (Vitest) and admin scripts.
- `gateway/agent-node/` — an optional Mac node that runs approved Claude Code tasks in isolated worktrees.
- `.claude/` — Claude Code agents, hooks and a kickoff workflow used to build it.

Personal details in prompts, fixtures and tests have been replaced with placeholders. Infrastructure names
(`jarvis-gateway`, `X-Jarvis-*` headers) are the project's original working name.

Setup: see `gateway/README.md`. You need your own Cloudflare account, D1 database, Google OAuth client,
Telegram bot and (optionally) Twilio number.
