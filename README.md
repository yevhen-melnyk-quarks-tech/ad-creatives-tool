# Ad Creatives Tool

Internal tool that turns a scenario into a finished vertical ad: character card →
storyboards → per-scene video → captions → assembled 1080×1920 cut, with an AI QA
agent gating every step.

Ported from the `CartoonAds` proof-of-concept in `growli-spa/POC-GROW-69`, where the
whole pipeline was run by hand.

## Why it is not on Vercel

Two independent reasons, both verified rather than assumed:

1. **The account is blocked.** `POST /v9/projects` returns
   `403 "You don't have permission to create the project"` for
   `yevhen.melnyk@quarks.tech` (`limited: true`), across two different tokens in two
   sessions. That is an account-level restriction, not token scope.
2. **Serverless cannot run this pipeline anyway.** One assembly runs ffmpeg for
   minutes over ~1.5 GB of clips and emits an ~80 MB file; one video generation polls
   an external API for ~150 s. Vercel functions cap at 300 s, ship no ffmpeg binary,
   and have no persistent disk.

So it deploys as a **single container** (Railway / Render / Fly / anything that runs
Docker) with a mounted volume — Next.js UI, job worker and ffmpeg in one box.

## Run it

```bash
cp .env.example .env.local     # add GEMINI_API_KEY and REPLICATE_API_TOKEN
npm install
npm run dev                    # http://localhost:3000
```

Docker:

```bash
docker build -t ad-creatives-tool .
docker run -p 3000:3000 -v ad-creatives-data:/data \
  -e GEMINI_API_KEY=... -e REPLICATE_API_TOKEN=... ad-creatives-tool
```

Artifacts land in `DATA_ROOT` (`./data` locally, `/data` in the container), one
directory per project, deliberately browsable and prunable from the UI.

## The flow

1. **Brief** — paste the creative brief straight from Notion (any language, any
   shape) or upload a `.txt`/`.md`/`.csv`. A parsing agent
   (`lib/agents/briefParser.ts`) turns it into the structured scenario. Pasting
   scenario JSON directly is still available as an advanced mode, and the brief can
   be edited and re-parsed later from the project page.

   Scenes are then split into **generatable units of at most 15 seconds**
   (`lib/pipeline/timing.ts`), because that is the video model's hard `duration`
   ceiling — a brief's 40-second conversation becomes `3-1`, `3-2`, `3-3`, each with
   its own storyboard and its own clip, exactly as the manual run did by hand. Splits
   land on frame boundaries, since a frame is one dialogue line and therefore one
   shot. A scenario already inside the limit passes through untouched, so
   hand-authored durations are never overwritten.
2. **Character card** — generated, QA'd, then **you approve**.
3. **Storyboards** — one sheet per scene, each QA'd, each **approved individually**.
4. **Videos** — generated **only for approved storyboards**. This gate is the point:
   a bad sheet costs cents to re-roll, the clip generated from it costs real money.
5. **Captions & assembly** — transcript-timed captions with script wording, then the
   final cut plus a deterministic geometry check.

## The QA agents

Each stage is `generate → critique → repair → regenerate`, bounded
(`lib/agents/repair.ts`). Every critic run is stored in `qa_runs`, so an auto-repair
is reviewable rather than a black box.

| Stage | Critic | Kind |
|---|---|---|
| Brief → scenario | schema validation, name resolution, 15s clip-limit splitting | deterministic |
| Character card | all characters present, distinct, match descriptions, labelled | vision |
| Storyboard | card fidelity + **cross-panel consistency** | vision, 2 samples |
| Video scene | same, on a 4-up contact sheet sampled from the clip | vision, 2 samples |
| Captions | script-to-audio alignment coverage | deterministic |
| Assembly | resolution, duration drift, logo centring | deterministic |

Five things this design gets from the POC, each earned by a defect that shipped:

- **Cross-panel, not per-panel.** The worst bug was one sheet containing two different
  versions of the same character — right in panel 1, re-cast in panel 4. A "is the
  right character here?" check cannot see it; the video model followed it faithfully.
- **Two stages, because the sheet is not ground truth.** One sheet drifted a
  character's hair yet its clip came out clean, and nothing stops the video model
  inventing drift a clean sheet never had.
- **Blocking vs advisory.** The first critic failed 10 of 15 sheets, almost all on
  noise — a scripted background extra read as an intruder, a shirt pocket, panel
  contents differing from a list that was itself guessed from prose. A gate that cries
  wolf gets switched off.
- **Consensus before spending.** Critic judgement is *not* reproducible even at
  temperature 0: re-running the same audit flagged different borderline details each
  time. A blocking verdict must repeat across samples before it triggers a paid
  re-roll. `REVIEW` means the samples disagreed — that goes to a human, not a retry.
- **Geometry is measured, not eyeballed.** Captions once rendered 64% oversized, and
  the CTA logo sat 10.5% off centre because the *source brand asset* was wrong. Both
  are measurements; `lib/agents/assemblyCheck.ts` reads raw pixels and asserts them.

Repairs are additive — they append constraints, never rewrite the prompt — so a fix
cannot quietly drop the scene's content. When the repair agent produces no new
constraint, the loop stops rather than paying for the same dice roll again.

## Resuming, and not losing work

The bulk buttons generate only what is **missing** ("Generate missing (N)"), never
overwriting an existing artifact — regenerating one clears its approval, so a
blanket redo would throw away reviewed work. Replace a single artifact with its own
Re-roll, or pass `force: true` to the jobs API for a deliberate full redo.

Everything lives on the mounted volume, so approvals and artifacts survive a
redeploy. A job interrupted mid-flight (redeploy, crash, OOM) is requeued when the
worker next starts and continues from where it stopped, bounded by an attempt count
so a job that reliably kills the process is eventually abandoned rather than looping.

A scene that fails no longer abandons the rest of the run: each scene is isolated,
and the log names the ones that failed. This matters because image generation and
the repair planner are both refused outright on some scenes containing children,
which used to abort the whole batch and leave every later scene ungenerated.

Each scene row shows a **generating** badge while it is being worked on, so progress
is visible without scrolling back to the top of a long project.

## Cost control

Every billable call is written to `costs` — Seedance video, Whisper, image
generation, and every agent call (critics, repair planner, brief parser). The
project header breaks the total down by operation.

Video re-rolls check `PROJECT_BUDGET_USD` before each attempt and stop at the
ceiling. Defaults: `MAX_ATTEMPTS_IMAGE=3`, `MAX_ATTEMPTS_VIDEO=2`,
`PROJECT_BUDGET_USD=25`.

Gemini usage is **measured** (token counts come from the API, images are counted)
but priced at **configurable rates**, since published prices move and vary by
model. Until you set them the UI labels these figures as estimates:

```
GEMINI_IMAGE_USD=0.04            # per generated image
GEMINI_INPUT_USD_PER_M=2.0       # per 1M input tokens
GEMINI_OUTPUT_USD_PER_M=12.0     # per 1M output tokens
```

## What a REVIEW or FAIL means, and what a re-roll does

A re-roll is not a reshuffle. Each run is a bounded
`generate → critique → repair → regenerate` loop: on a failure the repair agent
reads the critic's findings and appends concrete constraints, then regenerates.
Those constraints are **persisted on the artifact and carried into the next
re-roll**, so a second re-roll starts from the fixes the first one worked out
instead of rediscovering them. The UI shows what was applied.

- **FAIL** — a defect both QA passes agreed on. Re-roll retries with it fed back in.
- **REVIEW** — the passes disagreed, so nothing is confirmed. Storyboards still
  attempt one repair (cheap); video does not, because spending on an
  uncorroborated finding is spending on noise.
- **UNAVAILABLE** — no check ran at all. This is distinct from a REVIEW, and it
  happens reliably when a scene's cast includes a child: the character
  description plus a request to verify appearance against the images trips a
  non-configurable safety filter that relaxed `safetySettings` do not cover.
  Those sheets need a human eye; the tool says so rather than implying a verdict.

### Telling it what to fix yourself

Every artifact has a note box: type what is wrong in plain language and press
"Re-roll with note". The text is appended to the prompt as an OPERATOR CORRECTIONS
block marked as overriding both the template and anything the repair agent
inferred, because it comes from a human looking at the actual output.

Notes persist and are reapplied on later attempts until cleared, and they work
with no critic report at all — which is the point, since they are the only
feedback channel for scenes QA cannot assess. On a video the note is capped to fit
the model's 4000-character prompt limit and the run log says so if it had to trim.

## Layout

```
lib/models/      gemini + replicate clients (retry, non-JSON error handling)
lib/pipeline/    scenario types, prompt generation, captions, stage orchestration
lib/agents/      critic runner, per-stage critics, repair loop, assembly checks
lib/media/       ffmpeg helpers and the final assembly
lib/jobs/        in-process job worker
app/             UI + API routes
```

## Known gaps

- The brief parser invents visual identity (skin tone, hair, build) wherever the brief
  is silent, which it usually is. That is necessary — a vague description cannot drive
  an identity lock — but it means the character card is the agent's interpretation, so
  it is worth a real look before approving.
- There is no scene editor: to change the parsed scenario you edit the brief text and
  re-parse, which replaces the scenario and clears prior approvals.
- Split points are chosen arithmetically (balanced units on frame boundaries), not for
  narrative effect. A single dialogue line too long for one clip cannot be split at
  all — that is reported as a warning rather than silently sped up, since the SOP rule
  is that dialogue is never shortened automatically.
- Video generation is 720p from the model and upscaled at assembly; only the overlays
  are natively 1080p.
- No auth. It is an internal tool and assumes a trusted network.
