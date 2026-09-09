# Plan Creation Stage

Based on the think/explore exchange, produce a markdown plan document.

Requirements for the plan:

- Include clear, minimal, concise steps.
- Track the status of each step using these emojis:
  - 🟩 Done
  - 🟨 In Progress
  - 🟥 To Do
- Include dynamic tracking of overall progress percentage (at top).
- Do NOT add extra scope or unnecessary complexity beyond explicitly clarified details.
- Steps should be modular, elegant, minimal, and integrate seamlessly with the
  existing pipeline architecture.
- The plan must always end with a **Local Build** step and a **Deploy** step as the
  final two steps (see template below) — there is no staging environment here, so
  "deploy" means push to `main` and `railway up`, and that push *is* the release.
- Write the file to `plans/<slug>.md` (create the `plans/` directory if missing),
  never to the repo root. `<slug>` is a short kebab-case name for the task (there is
  no ticket number to use instead). This is a working document for the task's
  duration; `/document` deletes it on close-out once the CHANGELOG and git history
  hold the durable record — it should never accumulate in the repo long-term.

Markdown Template:

```markdown
# [Task Name] — Implementation Plan

**Overall Progress:** `0%`

## TLDR
Short summary of what we're building and why.

## Critical Decisions
Key architectural/implementation choices made during exploration:
- Decision 1: [choice] - [brief rationale]
- Decision 2: [choice] - [brief rationale]

## Tasks:

- [ ] 🟥 **Step 1: [Name]**
  - [ ] 🟥 Subtask 1
  - [ ] 🟥 Subtask 2

- [ ] 🟥 **Step 2: [Name]**
  - [ ] 🟥 Subtask 1
  - [ ] 🟥 Subtask 2

...

- [ ] 🟥 **Local Build**
  - [ ] 🟥 `npm run typecheck` — must pass clean
  - [ ] 🟥 `npm run build` — must pass clean
  - [ ] 🟥 `/review-code` — auto-applies its own recommended fixes, no confirmation
        gate (skip only for pure refactors/renames/comment changes)
  - [ ] 🟥 `/qa` — empirical verification against real state (rendered media, live
        job/DB state, a real API call where cheap) — see `/qa`'s own rules for what
        "real" means here. Re-run if `/review-code` changed anything.
  - [ ] 🟥 `/visual-review` — screenshot the affected view(s) at mobile (390px) and
        desktop (1280px), detect issues with vision, auto-fix (skip only for
        server/pipeline-only changes with no UI impact)
  - [ ] 🟥 Report results (typecheck + build + /review-code + /qa + /visual-review)
        in a summary table
  - [ ] 🟥 Ask user to confirm the local build looks good before deploying

- [ ] 🟥 **Deploy**
  - [ ] 🟥 Commit with a long, explanatory message (root cause, not just what
        changed) + `Co-Authored-By` trailer
  - [ ] 🟥 `git push origin main`
  - [ ] 🟥 `railway up --detach --service ad-creatives-tool`
  - [ ] 🟥 Poll `railway deployment list` until the new deployment shows `SUCCESS`
  - [ ] 🟥 Confirm the live URL responds (`curl` the home page, and the specific
        endpoint/flow this change touches)
  - [ ] 🟥 Hand off to `/document`
```

Still not time to build yet. Just write the plan document — no extra complexity or
scope beyond what was discussed.
