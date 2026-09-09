# Restore Context — Resume from Checkpoint

Run this at the **start of a new session** when continuing a task that was
checkpointed with `/save-context`.

## Step 1 — Find the Checkpoint

```bash
ls .claude/sessions/ 2>/dev/null || echo "No checkpoints found"
```

If there's only one, load it automatically. If multiple, show the list and ask
which one to restore.

## Step 2 — Read and Internalize

Read the full checkpoint file. Do NOT summarise it back to the user — just
internalize it.

## Step 3 — Verify Current State

Cross-check the checkpoint against reality — this project has a single `main`
branch and a single live deployment, so "reality" includes the live state, not just
git:

```bash
git log --oneline -5
git status
```

If the checkpoint mentions a deploy or a live verification, consider re-checking the
actual Railway deployment status and the live URL rather than trusting the
checkpoint's account of it — state can have moved on (a later session, or the app's
own job queue finishing something) since it was written.

## Step 4 — Report to User

```
Context restored — [Task Name]

Status: [X/Y steps complete]
Last completed: [specific action]
Next up: [exact next step]

[If any divergence from checkpoint]: ⚠️ Note: [what changed since checkpoint was saved]

Ready to continue. Run /execute to pick up from where we left off.
```

## Behaviour Rules

- Do not re-read the entire codebase from scratch — trust the checkpoint, spot-check
  only what matters for the next step.
- If the checkpoint file is missing or corrupted, say so clearly and suggest
  running `/explore` instead.
- Keep the status report short.
