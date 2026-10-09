---
name: kickoff
description: Run Jackson's project kickoff team (researcher, pitch, planner, safety lead, scribe; 5 agents, ~$1) on a big, fuzzy or risky new project. Use when he says "let's start a project", "kickoff", "I have an idea for…", or types /kickoff. Not for quick questions or feature work (that goes builder → reviewer).
---

# Project kickoff

1. Take the idea in Jackson's own words (the args or his message). If it's one vague line, ask at most ONE clarifying question; otherwise go. Put the full idea in `idea` even if his latest message is just "go" or a pick (workflow agents also see that message; the script tells them to ignore it unless it's the idea).
2. Pick a short kebab-case slug and today's date (YYYY-MM-DD, America/Chicago).
3. Call the Workflow tool with `name: "kickoff"` and `args: {"idea": "<his words>", "slug": "<slug>", "date": "<date>"}`. It runs in the background.
4. When it finishes, you are the **liaison**: reply in Jackson's style (short, plain words):
   - The plan in 3–5 bullets (what we'd build first).
   - Safety must-fixes, if any, in one line each.
   - **Decisions for you** (max 3) with your recommendation.
   - The file path `projects/<slug>/DECISIONS.md`.
   Then offer: "Want the builder to start on milestone 1?"
5. Commit `projects/<slug>/` (pull --rebase first, only those files).
