# Save Context — Checkpoint Session State

Run this any time during a long task when you want to preserve state before closing
the session, switching tasks, or when context is getting long.

## What This Does

Writes a structured checkpoint file to `.claude/sessions/` so you — or a future
session — can pick up exactly where you left off without re-reading the entire
codebase or re-deriving decisions from `git log`.

## Step 1 — Identify the Task Slug

Look for the plan's slug in `plans/*.md` (there is no ticket number in this repo —
see `PROJECT.md`). If there is no plan file, use `SCRATCH` as the identifier.

## Step 2 — Write the Checkpoint File

Create or overwrite `.claude/sessions/[slug]-checkpoint.md`:

```markdown
# Context Checkpoint — [Task Name]
**Saved:** [date and time]

## What We're Building
[One paragraph summary of the task from the plan/design doc]

## Current Status
[Copy the current plan progress — which steps are 🟩 Done / 🟨 In Progress / 🟥 To Do]

## Last Thing Completed
[Specific description — file changed, function written, deployed and verified how]

## Next Thing To Do
[Exact next step — be specific enough that a fresh session knows where to start]

## Key Decisions Made
[Architectural/implementation decisions agreed during this session, and why]

## Files Touched So Far
[List of files created or modified in this session]

## Gotchas / Watch Out For
[Anything discovered this session a fresh one would miss — a concurrency edge case,
a cost consideration, a rendering quirk — the kind of thing that otherwise gets
re-derived expensively next time, per `PROJECT.md`'s operating principle]

## Open Questions
[Anything unresolved that needs answering before or during the next session]
```

## Step 3 — Confirm

```
Context saved → .claude/sessions/[slug]-checkpoint.md

To resume: start a new session and run /restore-context
```

## Behaviour Rules

- Always overwrite the previous checkpoint for the same slug — don't accumulate
  stale files.
- Be specific in "Next Thing To Do" — vague checkpoints are useless.
- Do NOT summarise the entire codebase — only what's relevant to the current task.
