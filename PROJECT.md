# PROJECT.md — how this repo actually works

Internal tool, not the Growli product. This repo has nothing to do with
`growli-spa` — separate git history, separate deploy target, separate
conventions. If you're picking this up expecting growli-spa's workflow (JIRA,
`GROW-XX` branches, a staging/master split), none of that applies here. See
`README.md` for what the tool does and the pipeline architecture; this file is
about how to work in the repo day to day.

## Workflow — no staging, no tickets

- One branch: `main`. Commit directly to it, no PR, no staging deploy.
- Commit messages: long and explanatory, not a one-liner. State the actual bug/
  root cause, not just what changed — `git log --oneline` history in this repo
  is written to be read later without the original conversation. End with
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- Deploy: `railway up --detach --service ad-creatives-tool` after every commit
  that should go live. There is no "later" — this is a single-container app
  with one environment, so shipped means deployed.
- No formal test suite (`npm run build` + `npx tsc --noEmit` are the gates,
  `eslint` catches real bugs — react-hooks/set-state-in-effect has caught more
  than one genuine issue here, don't ignore it). Verify empirically instead:
  render the actual output (ffmpeg frame grabs, pixel diffs), hit the live API
  with curl, seed a real project and race it. Every fix in this project's
  history that shipped without that kind of check is the one that turned out
  to be wrong or incomplete.

## Operating principle

Measure before fixing, and re-measure after. Don't trust a schema, a log
line, or your own reasoning about what "should" be happening — check the
actual bytes, the actual timing, the actual server state. This project's own
history is full of cases where the plausible-sounding cause was wrong: a
"broken" logo that was actually 0.07% different pixel-for-pixel (the real
issue was off-center source art), a caption drift bug where the first
diagnosis undercounted the actual drift by 4x because the measurement tool
itself had the same bug being chased. When investigating a live incident, look
at the actual job log before proposing a fix — this project's job rows keep
their full progress log, and it usually already contains the answer.

## Architecture constraints that shape everything

- **1 GB container.** ffmpeg encoder settings are deliberately capped
  (`ENCODER_LIMITS` in `lib/media/assemble.ts`) — this is not paranoia, an
  uncapped encode measured at 607 MB resident and an uncapped filter graph hit
  exactly 1.000 GB and got SIGKILLed. Read the comments in that file before
  changing anything about the assembly pipeline's memory shape.
- **Single SQLite file on a Railway volume, one in-process worker.** No Redis,
  no external queue — deliberate, not a shortcut, for a single-writer tool.
  This DOES mean job-queue correctness is subtle: the worker's job claim must
  be an atomic `UPDATE ... WHERE status='queued'`, not a separate SELECT+UPDATE
  (a real double-execution incident came from exactly that gap — see the git
  log around "Close the job queue's double-claim race"). `ensureWorker()` is
  wired to the project detail route specifically because that's what's
  actually polled while someone has a project open — don't add a new
  long-lived polling loop without checking it also calls `ensureWorker()`, or
  a queued job can sit dead after a redeploy.
- **Every generation attempt is kept**, never overwritten. `lib/pipeline/
  versions.ts` — the canonical `scene_X_video.mp4` etc. is a *copy* promoted
  from an immutable per-attempt file, deliberately not a hard link, so nothing
  that writes to the canonical path can corrupt history.
- **Video does not auto-regenerate on a QA fail.** One attempt, one critic
  report, and if it's not a pass the repair agent's diagnosis is offered as a
  suggestion for a *manual* re-roll — never spent automatically. Images
  (character card, storyboards) still auto-repair; that asymmetry is
  deliberate — video is the expensive one.

## The pacing SOP

`lib/pipeline/timing.ts`'s `RATES` (ideal 2.0 words/sec, never approach 2.7)
comes from the motion designer's own scene-splitting doc (Jake/Growli
pipeline, 21 scenes, zero regenerations). If that doc changes, or a new one
supersedes it, update `RATES` and re-verify against the doc's own worked
examples the way the "Re-time scenes to the Jake/Growli pacing SOP" commit
did — computing duration from the doc's own word counts at `RATES.ideal`
should reproduce its table exactly.

## Credentials

`.env.local` (gitignored) for local dev; Railway env vars for production —
`railway variables --service ad-creatives-tool` to inspect. `GEMINI_API_KEY`
and `REPLICATE_API_TOKEN` are billing-live keys, treat them accordingly.

R2 credentials currently in use are Growli's account-wide S3 keys (can reach
`growli-audio` and `growli-avatars` too, not just this tool's bucket) — known,
outstanding, not yet fixed. A token scoped to `growli-ad-creatives` only is a
straightforward swap whenever one exists; don't propagate the account-wide key
to anywhere new in the meantime.
