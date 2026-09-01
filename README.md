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

1. **Scenario** — characters + scenes as JSON (`lib/pipeline/types.ts`).
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

## Cost control

Every billable call is written to `costs`. Video re-rolls check
`PROJECT_BUDGET_USD` before each attempt and stop at the ceiling. Defaults:
`MAX_ATTEMPTS_IMAGE=3`, `MAX_ATTEMPTS_VIDEO=2`, `PROJECT_BUDGET_USD=25`.

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

- Scenario authoring is paste-JSON; there is no scene editor or LLM brief-to-scenario
  step yet.
- The prompt-edit path the brief describes ("approve or edit with a prompt") is
  currently re-roll-only; per-artifact manual prompt overrides are not wired up.
- Video generation is 720p from the model and upscaled at assembly; only the overlays
  are natively 1080p.
- No auth. It is an internal tool and assumes a trusted network.
