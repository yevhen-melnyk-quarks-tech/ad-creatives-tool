# Changelog

All notable changes to this project are documented here. Format: dated entries,
newest first, grouped as Added / Changed / Fixed / Removed. Versions track
`package.json` — bumped by `/document` on every close-out.

## 0.4.0 — 2026-09-12

### Added
- **Localization (step 5, optional).** Once an ad has tested well, it can be
  translated into other markets: HeyGen produces a translated, lip-synced voiceover
  from the clean master, then the tool re-burns its own captions, legal descriptor
  and CTA, so each language comes out as a finished 1080x1920 cut rather than a raw
  translation. Every localized cut is downloadable and shareable like any other
  deliverable. Verified end to end on a real ad: 37 caption cues, correct house
  style, CTA intact.
- The language list is chosen once and reused by every project, in a new app-wide
  `app_settings` table behind `GET/PUT /api/settings` — the first configuration in
  this tool that is not scoped to a single project. The picker is populated live
  from HeyGen's 190 languages.
- `burnAndFinish()` — the upscale/burn/CTA tail of assembly, split out so the English
  and localized cuts go through exactly one implementation and cannot drift apart.

### Changed
- `DELIVERABLES` became `deliverablesFor(projectId)`: the finished-file list is now
  derived per project, so per-language cuts reach object storage and can be shared.
  The static array silently excluded anything not named in it, across uploads, the
  interface's file list and the share-link allowlist alike.
- The jobs route now carries a `languages` payload; it previously dropped every field
  except `sceneId`/`force`, so the request would have looked accepted and done nothing.
- Duplicate-job coalescing compares languages as well as scene. Keyed on scene alone,
  two runs for different languages both had `sceneId` null, so the second was
  swallowed as a duplicate of the first and those markets never rendered.
- `localize` shares `assemble`'s tighter concurrency cap: it ends by running the same
  full-length encode, and two of those in a 1 GB container is how the encoder gets
  SIGKILLed here.

### Fixed
- A HeyGen translation takes minutes, and `recoverOrphanedJobs` requeues any job
  silent for 90 seconds — so every poll writes job progress. Without it a localization
  job would have been requeued mid-flight and paid for a second time. Confirmed in
  production: a run polled for 347 seconds without being reclaimed.
- The translated video arrives carrying an embedded `mov_text` subtitle track (HeyGen
  adds one when captions are enabled); it is explicitly dropped, or it would ride into
  the deliverable as a soft track under the burned-in captions.
- A missing `MASTER_clean.mp4` — legitimately skipped when the volume is tight at
  assembly time — now explains itself and names the fix instead of failing as a
  file-not-found.

## 0.3.1 — 2026-09-10

### Fixed
- **Videos stopped being generated at all.** Next.js memoizes `fetch` GET requests
  with the same URL and options, and the worker polls Replicate with exactly such a
  request every 10 seconds — so every poll after the first replayed the first
  response and the status could never change. Clips reached the 20-minute poll
  ceiling and were discarded while Replicate had in fact finished them in 16-127
  seconds. On 2026-09-10 this burned 3,226 seconds of billed compute across 24
  successful predictions and saved zero clips. Every provider request now carries an
  `AbortController` signal, which opts out of that memoization (`cache: "no-store"`
  does not — it governs a different cache). Same root cause as the "Whisper stall"
  seen the day before.
- The job worker now starts from `instrumentation.ts` at server boot rather than
  from the home page's render. A poll timer created inside a Server Component render
  inherits that render's memoization for the life of the process, so the worker being
  a process-wide singleton meant one page load could poison all polling. Route
  handlers still call `ensureWorker()` as a safety net — they are not memoized.
- A prediction that outlives its poll budget is no longer thrown away. It is billed
  either way, so the poll now falls through to a grace period that keeps asking until
  it finishes, and only then gives up — reporting a `PredictionTimeoutError` carrying
  the prediction id instead of a misleading "Prediction processing".
- Billed-but-undelivered renders now appear in the cost ledger (as `-unclaimed`, with
  the prediction id). They were previously invisible, because the cost was only
  recorded on the success path — the day above reported $0 of video spend.
- Re-rolling a scene whose render was lost that way now downloads the already-paid
  clip instead of paying for a second one, but only when the prompt is byte-identical
  — an edited note or a changed repair addition still pays for a fresh render rather
  than silently returning a clip made from different instructions.

## 0.3.0 — 2026-09-09

### Added
- The worker now runs up to 3 different projects' jobs concurrently instead of
  one job at a time system-wide — a motion designer can work on 2-3 projects in
  parallel. `assemble` (the one ffmpeg-heavy job kind) keeps its own tighter cap
  of 1 concurrent, regardless of the general limit.
- The running banner explains a queued job's wait ("queued — waiting for a slot
  (3/3 projects busy)") instead of a bare "queued" that looked identical to stuck.
- The character card now shows an in-flight badge, a shimmer over the existing
  image while a new one is coming, and disabled controls while a job is running —
  matching the treatment storyboards/videos already had.

### Fixed
- Root cause of "character card regeneration stuck in queued, never starts": the
  job queue was a single global lane for the entire app, so an unrelated project's
  stuck job could silently block everything else. Fixed by the concurrency work
  above, not by patching the symptom.
- Cost tracking moved from a single global variable to per-job `AsyncLocalStorage`
  context — required for the concurrency work above; the old approach would have
  attributed one project's Gemini spend to whichever project's job happened to be
  running at the moment a call resolved.
- A thrown error from an image generation call (e.g. Gemini occasionally returning
  no image part with no content-policy block) used to abort every remaining retry
  attempt immediately, regardless of `MAX_ATTEMPTS_IMAGE`. Now retries like any
  other recoverable failure. Affects character cards and storyboards.

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
