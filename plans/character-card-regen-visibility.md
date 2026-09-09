# Concurrent projects + character card regeneration visibility — Implementation Plan

**Overall Progress:** `90%` (local build clean and verified, deploy pending)

## TLDR

Started as a single bug report ("character card regen stuck in queued, never
starts"). Root cause, verified live: the job queue is one global lane for the
*entire app* — a completely different project's stuck `assemble` job was holding
the only slot. Scope expanded on request: rather than just surfacing the wait,
give the worker real concurrency — up to `MAX_CONCURRENT_PROJECTS` (default 3)
different projects running a job at once — plus the original visibility/shimmer
work, which is still worth doing on top of concurrency (there will still be times
all slots are full).

## Evidence (unchanged from the original bug report)

```
target project's queued job:  character_card  queued  attempts=0  progress=None
other project holding the lane: assemble  running  last_seen_at=<a few seconds ago>
```

## Critical Decisions

- **Concurrency capped per-project, not raw global count**: at most one running job
  per project, up to N different projects. This is what "2-3 projects in parallel"
  actually means, and it sidesteps every intra-project race (version allocation,
  canonical file writes) since those already assume "one job, one project" and
  stay true — no changes needed to `lib/pipeline/versions.ts` or the budget guard.
- **`assemble` gets its own, tighter cap** (default 1) regardless of the project
  cap. Measured: a single assembly encode peaks at 241 MB; three concurrent ones
  would approach 950 MB against this container's 1 GB ceiling. Every other job
  kind (image/video generation, transcription) is network-bound with negligible
  local memory — no special cap needed for those.
- **`lib/models/usageTracker.ts` moves from a module-level variable to
  `AsyncLocalStorage`** — the one required correctness fix, not optional. Its own
  comment predicted exactly this: "if that ever becomes concurrent, this must
  become a proper per-job context or costs will be attributed to the wrong
  project." Verified directly: two deliberately-interleaved concurrent contexts
  stay correctly isolated (each only ever saw its own callbacks).
- **Everything else already checked and already safe**: `reserveSpend`/
  `releaseSpend`/`projectCommittedUsd` are already keyed per-project in a `Map`;
  `activeScenes` is already keyed per-job; the atomic job claim (`UPDATE ... WHERE
  status='queued'`) needs no change — it extends safely to multiple simultaneous
  claims exactly as it does to one.

## Tasks

- [x] 🟩 **Step 1: AsyncLocalStorage for usage tracking**
  - [x] 🟩 Rewrite `lib/models/usageTracker.ts`: `withUsageSink(sink, fn)` replaces
        `setUsageSink`/manual clear; `reportUsage` unchanged externally
  - [x] 🟩 Update the two call sites in `lib/models/gemini.ts` — no change needed,
        `reportUsage`'s signature is the same
  - [x] 🟩 Update `lib/jobs/worker.ts` to wrap job execution in `withUsageSink`

- [x] 🟩 **Step 2: Concurrent claiming in the worker**
  - [x] 🟩 `MAX_CONCURRENT_PROJECTS` (env, default 3), `MAX_CONCURRENT_ASSEMBLE`
        (env, default 1), alongside the existing `CONCURRENCY_IMAGE`/`_VIDEO`
  - [x] 🟩 Shared state grows to `{ timer, runningProjects: Set<string>,
        runningAssembleCount: number }`, still on `globalThis`
  - [x] 🟩 `tick()`: skip if `runningProjects.size >= MAX_CONCURRENT_PROJECTS`;
        find the oldest queued job whose project isn't already running and
        (if `assemble`) under the assemble cap; claim it (same atomic UPDATE,
        unchanged); fire its execution *without* awaiting inline so the next
        tick can claim into another open slot
  - [x] 🟩 Job completion (success/fail) removes the project from
        `runningProjects` and decrements the assemble count in a `finally`

- [x] 🟩 **Step 3: Expose queue state to the UI**
  - [x] 🟩 `app/api/projects/[id]/route.ts` — replace the single `blockedBy` idea
        with something that fits real concurrency: how many project-slots are
        currently busy out of the max, and (if this project's own job is
        queued) roughly how many ahead of it are waiting for a slot
  - [x] 🟩 Thread through `ProjectWorkspace.tsx`

- [x] 🟩 **Step 4: Running banner reflects real concurrency**
  - [x] 🟩 When queued and all slots are busy: "queued — N/N project slots busy"
        rather than naming one specific blocker (may not be a single job anymore)

- [x] 🟩 **Step 5: Character card in-flight state** (unchanged from original plan)
  - [x] 🟩 `cardJobState()` helper (character_card has no scene concept)
  - [x] 🟩 `<JobBadge>` next to the "Character card" title
  - [x] 🟩 Shimmer overlay on the existing image while generating/queued
  - [x] 🟩 Disable Regenerate/Approve/NoteBox while in flight

- [x] 🟩 **Local Build**
  - [x] 🟩 `npm run typecheck`
  - [x] 🟩 `npm run build`
  - [x] 🟩 `/review-code`
  - [x] 🟩 `/qa` — this is the one that matters most here: prove concurrency for
        real. Queue jobs for 2-3 different real projects at once and confirm they
        actually run simultaneously (not serialized), confirm cost lands on the
        right project for each, confirm a 4th project's job waits for a slot,
        confirm two `assemble` jobs queued together respect the tighter cap
  - [x] 🟩 `/visual-review` — character card shimmer/badge, running banner's new
        wording, mobile + desktop
  - [x] 🟩 Report results, confirm before deploying

- [ ] 🟨 **Deploy**
  - [ ] 🟥 Commit with a long, explanatory message + `Co-Authored-By`
  - [ ] 🟥 `git push origin main`
  - [ ] 🟥 `railway up --detach --service ad-creatives-tool`
  - [ ] 🟥 Poll for `SUCCESS`
  - [ ] 🟥 Confirm live: queue real jobs across multiple real projects and watch
        them run concurrently on the actual deployment
  - [ ] 🟥 Hand off to `/document`


## Additional finding, caught during /qa

Live-verifying the original bug scenario (the queued job did eventually run once
its blocker cleared, confirming the queue was never fundamentally broken) surfaced
a real, separate, generic bug: it ran and failed with "Image generation returned no
image part." Traced to `repairLoop`'s `generate()` call having no try/catch — a
thrown error aborted the ENTIRE retry loop on attempt 1, even with
`MAX_ATTEMPTS_IMAGE=3` configured. Affects character cards and storyboards alike,
not just this note-triggered case. Fixed: a generate() failure now retries (same
prompt — there is no critic finding for the repair planner to act on) up to
maxAttempts, and only surfaces as a real failure once attempts are exhausted, with
a clear "this looks transient, try again" summary instead of a cryptic crash.
Verified with three cases: recovers after one failure, exhausts cleanly without
crashing when every attempt fails, and the existing FAIL-verdict repair path
(regression check) still works.
