# Changelog

All notable changes to this project are documented here. Format: dated entries,
newest first, grouped as Added / Changed / Fixed / Removed. Versions track
`package.json` — bumped by `/document` on every close-out.

## 0.2.0 — 2026-09-09

### Fixed
- Job queue double-claim race: the worker's job claim is now an atomic
  `UPDATE ... WHERE status='queued'`, closing a real incident where two executions
  of the same assembly job ran concurrently and corrupted its scratch files.
- `recoverOrphanedJobs` no longer reclaims a job the instant a process boots — it
  now waits for the job to go silent (no progress write) for 90+ seconds first, so
  a redeploy can no longer yank a still-running job back to `queued`.
- The worker could go idle after a redeploy if nobody loaded the home page —
  `ensureWorker()` now also runs from the project detail route, which is what's
  actually polled while a project is open.
- Scene pacing re-tuned to the motion designer's own scene-splitting SOP (2.0
  words/sec ideal, never approach 2.7+) — the previous target (3.0, informed by an
  earlier, denser reference ad) was roughly 50% too fast for clean first-attempt
  renders. Added a child-voice pacing modifier and two scene-boundary rules
  (location change, decision/realisation) to the brief-parsing agent's prompt.
- Disclaimer line spacing tightened from a 52px gap to 31px (was 1.7x the font
  size, now a normal tight leading).
- The specific Seedance failure ("unknown file extension" on a re-served reference
  image) now retries automatically with a fresh upload, up to 3 attempts, before
  surfacing as a failure.

### Changed
- Video generation caps at one attempt — no more automatic paid re-render on a
  critic FAIL/REVIEW. The critic still runs in full; its suggested fix is now
  surfaced as a "copy into my note" action for a manual, reviewed re-roll instead.
- Each assembly attempt gets its own scratch subdirectory rather than sharing one
  per project, and "prune scratch" now refuses while a job is running.

## 0.1.0 — 2026-09-02

Initial pipeline: scenario → character card → storyboards → per-scene video →
captions → assembled 1080x1920 cut, with an AI QA gate at every stage. Deployed to
Railway. Object storage (Cloudflare R2) for finished deliverables. Per-attempt
version history for every generated artifact.
