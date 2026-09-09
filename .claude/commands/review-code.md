# Code Review Task

Perform comprehensive code review. Be thorough but concise. Apply every fix directly
— no confirmation gate (same auto-fix model as `/qa` and `/visual-review`). Skip only
for pure refactors, renames, or comment-only changes.

## Check For

**Job queue correctness** — any change touching `lib/jobs/worker.ts` or a job's
status transitions: is the claim still atomic (`WHERE id=? AND status='queued'`,
never a separate SELECT-then-UPDATE)? Does `recoverOrphanedJobs` still gate on
`last_seen_at` staleness rather than reclaiming on sight? This project has shipped
this exact bug twice — see `PROJECT.md`.

**Concurrency / shared state** — does a new scratch path live under a shared
directory (`_work`, `_diag`, `_transcripts`) that a concurrent job could also touch?
Per-attempt isolation is the pattern (see `workAttempt` in `lib/paths.ts`) — a new
scratch write should default to it, not to a fixed per-project path.

**ffmpeg / memory** — any new or changed `run()` call in `lib/media/`: does it need
`ENCODER_LIMITS`-style thread/lookahead caps? This container OOMs at 1 GB and has
before. Does it use the `concat` filter (buffers frames in memory) where the
`concat` demuxer (a stream copy) would do?

**Disk accounting** — anything that writes a new intermediate file: is it cleaned up
in a `finally`, not just on the success path? A failed run's scratch should not
outlive the run (see the try/finally pattern in `assembleFinal`).

**Spend** — any new Gemini or Replicate call: is it recorded via `recordCost`? Is a
paid (Replicate) call inside a loop that could retry automatically without a human
decision point — video generation is capped at one attempt for exactly this reason,
don't reintroduce an automatic retry-on-critic-verdict for it.

**TypeScript** — no `any`, no `@ts-ignore`, no unused imports/vars (the project's
eslint catches these — run it, don't skip because tsc passed).

**React/Hooks** — no `setState` synchronously inside a `useEffect` body (the
project's `react-hooks/set-state-in-effect` rule has caught real bugs here — adjust
state during render instead, per React's own "you might not need an effect"
guidance, not by wrapping the fix in a stale-closure workaround).

**Production readiness** — no `console.log` debug statements left in, no
hardcoded API keys (check `.env.local` isn't accidentally read/committed), no TODOs
standing in for a decision that should have been made.

**Architecture** — follows existing patterns (see `PROJECT.md`), lives in the
correct `lib/` subdirectory, doesn't duplicate something `lib/pipeline/` or
`lib/media/` already does.

## Output Format

### ✅ Looks Good
- [Item 1]

### ⚠️ Issues Found
- **[Severity]** [File:line] - [Issue description]
  - Fix: [what was changed]

### 📊 Summary
- Files reviewed: X
- Critical issues: X (fixed: X)
- Warnings: X (fixed: X)

## Severity Levels
- **CRITICAL** — data loss, a second worker able to double-claim a job, an OOM risk,
  a paid call that can loop without a human decision
- **HIGH** — real bugs, wrong output, bad UX
- **MEDIUM** — code quality, maintainability
- **LOW** — style, minor improvements
