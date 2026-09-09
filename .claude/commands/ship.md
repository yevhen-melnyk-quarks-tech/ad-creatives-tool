# Ship — Full Pipeline Orchestrator

Takes a task description and runs the full development loop end-to-end, using
propose-mode for think/explore so you get recommendations to confirm, not a Q&A
session. Only stops for input at two gates: plan approval, and the local-build
confirmation right before deploying.

Adapted from growli-spa's `/ship` for this repo's actual shape: no issue tracker
(the plan file is the record), no staging environment (a push to `main` plus
`railway up` is the release, so there is one fewer gate than growli-spa's version —
that project's separate "staging confirm" has no equivalent here since there's
nothing between local and live).

## Usage

Give a task description. Optionally specify: "skip design" (skip `/think`, go
straight to `/explore` for bug fixes or small changes — this is the common case),
"skip QA" (skip `/qa`'s empirical verification — only for copy-only or config-only
changes with no pipeline/UI impact).

QA runs by default for anything touching pipeline logic, the job queue, rendering,
or the UI. Skipping it is the exception — flag it explicitly if invoked.

## Pipeline

1. **`/think`** (propose mode) — only for a genuinely new capability, not a bug fix.
   Skip by default; skip explicitly if the user said "skip design."

2. **`/explore`** (propose mode) — technical scoping against the actual current
   code (this project's `git log` frequently explains *why* something is shaped the
   way it is — check it before proposing a change to it). Present findings + a
   recommended approach once, ask for a single confirm/adjust.

3. **`/create-plan`** — write `plans/<slug>.md` from the confirmed
   think/explore output.

4. **GATE 1 — Plan Approval** — present the plan. Do not proceed to `/execute`
   until the user explicitly confirms. Do not skip or soften this even in propose
   mode — this is the one place a bad guess is expensive (a wrong assumption about
   the job queue or ffmpeg's memory budget has cost real debugging time here before).

5. **`/execute`** — implements per plan. Its Local Build sequence runs typecheck,
   build, `/review-code` (auto-applies fixes), `/qa` by default (empirical
   verification — skip only if "skip QA" was specified, or auto-triggered anyway if
   `/review-code` changed something), `/visual-review` if UI changed — all before
   **GATE 2 — Local Build Confirmation** (existing gate inside `/execute`,
   unchanged). Once confirmed, `/execute` commits, pushes to `main`, deploys via
   Railway, polls for `SUCCESS`, and verifies the live URL actually reflects the
   change (not just that the deploy succeeded).

6. **`/document`** — runs once the user confirms the deploy is live and verified:
   CHANGELOG entry, remove the plan file, final report.

## Behaviour Rules

- Never skip Gate 1 or Gate 2 — these are the two stops that stay intact regardless
  of propose mode.
- `/qa` is default-on for anything touching pipeline logic, the job queue,
  rendering, or the UI. Only skip when explicitly told to, and only for
  non-functional changes.
- `/review-code` is default-on (same carve-out: skip only for pure
  refactors/renames/comment-only changes) and never adds its own confirmation gate
  — Gate 2 already covers it.
- If `/explore` surfaces a genuinely blocking ambiguity, pause and ask — don't
  guess past something that changes scope materially.
- Report progress between each numbered step with a one-line status, not a full
  recap.
- If any step fails (build error, deploy failure, a QA check that doesn't hold up),
  stop and report — do not silently work around it and continue the pipeline.
- Cost awareness carries through every step: prefer the free/cheap verification
  path (see `/qa`) over a real paid generation unless the change specifically can't
  be verified any other way.
