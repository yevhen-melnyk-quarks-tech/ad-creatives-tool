# QA — Empirical Verification

Run this **after** `/execute`'s local build steps (typecheck, build, `/review-code`)
pass. This project has no browser-flow test suite and no auth to fixture — its QA
discipline is empirical verification against real state, not Playwright specs. See
`PROJECT.md` "Operating principle": don't trust a schema, a log line, or your own
reasoning about what should be happening — check the actual bytes, the actual
timing, the actual server state. Every serious bug found in this project so far was
found this way, not by a passing typecheck.

## Core Rule

A check that only confirms "it ran without throwing" validates that the code
executes, not that it produces the right output. Assert on the actual artifact or
state:

- **Pipeline math** (pacing, splitting, timing, cost estimates) — run the real
  function against real or reference-documented inputs and compare the actual
  output to a known-correct number. If a source-of-truth doc exists (e.g. the
  scene-splitting SOP), reproduce its own worked examples exactly, not just "output
  looks plausible."
- **Rendered media** (fonts, spacing, overlays, CTA geometry, logo placement) —
  render the actual frame with ffmpeg (or pull one from a real asset — local first,
  the live deployment if the bug is asset-specific) and inspect it with the Read
  tool. A geometry calculation "looking right" in the math is not the same as
  looking right on screen — measure, then look.
- **Job queue / concurrency changes** — reproduce the actual race, don't just read
  the fix and reason that it should work. Interleave the exact SQL statements by
  hand if a live timing-dependent race can't be forced on demand (see the atomic
  job-claim fix in git history for the pattern) — and say plainly if a live
  repro attempt didn't land, rather than presenting a hoped-for repro as a
  confirmed one.
- **Anything touching the live deployment** — this is a single-instance production
  app with no staging environment. Prefer checking against the actual Railway URL
  over trusting local dev alone once a fix is deployed: `curl` the real endpoint,
  read the real job log (`jobs.progress` carries the full history — read it before
  guessing what happened), check the real DB row shape via the API.

## Cost Awareness

Gemini calls (images, critics, the repair planner) are cheap — a few cents. A
Replicate video render is not (roughly $0.20-$5+ depending on resolution and
duration). Default to the free/cheap path:

- Test pipeline logic with synthetic inputs, not a live generation.
- Test rendering/assembly against clips and captions that already exist in a real
  project — assembly and its ffmpeg steps cost nothing but compute.
- `planRepair` and the critics are cheap, real, and safe to call directly when
  verifying anything about the QA/repair loop.
- Only trigger an actual video generation when the change specifically can't be
  verified any other way (e.g. testing the Replicate retry classifier's real
  network path rather than its logic) — and say what it will cost before doing it.

## Report

```
QA — [task name]

✅ [what was checked] — [how, and what the actual measured/observed result was]
✅ [...]
⚠️  [something that didn't verify cleanly] → [fixed: what changed | flagged: why not fixed]

Verified against: [live deployment | local render | pure-function test] — [why that
was the right level for this change]
```

## Behaviour Rules

- Never report something as verified because the build passed or no exception was
  thrown — say specifically what state was checked and what it showed.
- If a live repro of a race or a stuck-state bug can't be forced on demand, say so
  explicitly rather than presenting the fix as proven by a test that didn't actually
  exercise the failure mode.
- Read what a "test" script actually asserts before trusting its result, same as any
  other code.
- Bugs found during QA get fixed in the same pass, noted in the report, and folded
  into the same commit — this project's commit messages are written to carry that
  context (see `PROJECT.md`), not squashed away.
