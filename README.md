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

## Why a scene's cast is never derived from prose

A clip once shipped starring the wrong character: the boss walked to the travel agency
as the protagonist while John trailed behind, and the boss appeared to receive his own
firing call. The prompt was self-contradictory —

> Only John's Boss appear — nobody else enters at any point. **John Carter, Sarah
> Carter, Mia Carter, Liam Carter do NOT appear**; never use their faces.

— while the action text read *"the family walks down the street... John's phone rings
... he falls behind to answer."* Told to render a man answering a phone, told John did
not exist, and given one permitted character, the model recast the boss. It was the
only reading that satisfied the prompt.

The cause was `charactersInFrame` matching **full names** against prose that never
contains them. A brief says "John's", "he", "the family" — so detection found nobody,
the per-unit cast collapsed to whoever had a dialogue line, and the identity lock then
forbade the protagonist. Four defences now:

1. The brief parser emits `charactersPresent` per frame — supplied data, not inference
2. `detectByName` matches full names first, then name tokens and possessives, masking
   each match so "John's Boss" cannot also count as a hit for "John Carter"
3. `reconcileCast` widens a cast to cover anyone the action references, so a prompt
   that says "X does not appear" while X acts is impossible to emit
4. The parser is told to name characters explicitly and never lean on a group noun

Group nouns cannot be mapped to specific people — "the kids" means different
characters in every brief — so when a scene's action leans on one, the lock states who
IS present and **omits the negative clause entirely**. Asserting the wrong absence is
what produced a sheet of a woman alone on a pavement asking "John, what happened?",
because the cast was two and the action said "the family exits, the kids run ahead".
Scenes with no group reference keep the strict form.

### A speaker is not automatically the subject

The frame's subject used to be whoever had the dialogue line. That is right across a
desk and wrong down a telephone, where the person listening is who the shot is on —
it framed a boss as a dominant foreground close-up while the man taking his call stood
small behind him, and injected the boss's face and clothing into the frame caption so
the image model drew him on the pavement.

Visibility now comes from `charactersPresent`: a speaker absent from it is heard, not
seen. Such a line is marked "voice only, heard through the phone, NOT visible in this
frame", their appearance is kept out of the caption entirely, and the video prompt adds
"show only the character listening; never place them in the scene". Decided from
authored data rather than by searching the prose for the word "phone". A scenario with
no `charactersPresent` keeps the old assumption, which is correct for an ordinary
face-to-face scene.

## Knowing what is running

A running job shows in a sticky bar at the top of the viewport: the phase, a count and
progress bar where the total is knowable (scenes to generate, clips to render, scenes
to transcribe), the most recent log line, and the full log behind a disclosure. Sticky
because it was not — the indicator sat at the top of the page, so pressing a button in
step 3 or 4 scrolled it out of view and the app looked like it had done nothing.

## Theming

Light and dark, chosen with the Light / Dark / System control in the header. The
choice is stored per browser and applied by an inline script before first paint, so
switching pages does not flash the wrong theme. On System the OS is tracked live.

Colour lives in semantic tokens — `surface`, `ink`, `line`, `accent` and four status
families — defined once in `app/globals.css`, with the dark theme as a set of variable
overrides under `[data-theme="dark"]`. No component names a raw colour. That is a
deliberate response to how the contrast bug happened: the scaffold flipped the text
colour under `prefers-color-scheme: dark` while every panel stayed light, and the
reason it went unnoticed is that colour decisions were spread across 130 class names
with nowhere to keep them consistent. Adding `dark:` variants one at a time would have
the same failure mode, since one missed utility is one unreadable panel.

Every text-on-surface pair the interface actually renders is measured in both themes;
the weakest is 4.54:1, above the 4.5:1 WCAG AA floor for body text. `color-scheme` is
set alongside each theme, which is load-bearing rather than cosmetic — without it the
browser styles textareas, inputs and scrollbars from its own preference regardless of
the page, and that is what kept the descriptor field unreadable even once its
container had a colour.

## Legal descriptors and versions

The brief carries three descriptors and a VER block selecting one:

```
Тип 1  Fictional story. Results not typical and may vary.
Тип 2  AI-generated. Fictional story. Results not typical and may vary.
Тип 3  Results not typical and may vary.

VER 1 / Базова / Дескриптор: 2
```

The parser extracts every version with the descriptor number it selects, and step 4
shows which descriptor the final cut will burn, where that came from, and the exact
wording — pre-filled and editable. Precedence: text you edited, then a type you
picked, then the type the brief's version block selected, then type 2 as the fallback,
since that is the one required when a person is shown.

Type 2 renders "AI-generated." on its own bolder line above the sentence, as the
reference ad does. Types 1 and 3 have no prefix, so their single line moves up into
that position rather than leaving a blank line above it. Editing the text keeps the
same rule: a leading "AI-generated." becomes the bold line, anything else is rendered
as one line rather than guessing where a custom sentence should break.

## Captions and assembly are one action

**Assemble final** is the only button you need. Assembly only ever *read*
`captions.srt`, so on its own it would burn a stale file or none at all and still
produce something that looks finished — the caption track simply absent or drifting,
with nothing on screen to say why. Staleness is the sharper half: cue times are
absolute offsets into the concatenated story, so re-rolling any scene shifts every cue
after it.

Assembling therefore rebuilds captions whenever they are missing or older than any
clip, and says which. **Rebuild captions only** stays available for refreshing the
transcript without re-rendering the video.

## Localization set

Assembly writes a second cut alongside the final one:

- `MASTER_clean.mp4` — the same footage and audio at 1080x1920 with **no burned text
  at all**: no captions, no disclaimer, no CTA. The CTA is excluded rather than
  included-without-text, since without its text it is only a blurred still and is
  cheaper to re-render per locale from the logo and a translated label.
- `transcript.srt` — every spoken line with its timing, prefixed by who says it
- `transcript.json` — the same, plus **word-level** timings, for a text-to-speech pass
  that needs to fit an utterance into a known window

Both come from the alignment the captions already use, so timings match the cut
exactly. Line-level rather than the 2-3 word chunks captions use, which is the wrong
shape to hand a translator or a voice model.

**Known limit for re-voicing:** the video model returns one mixed audio track, with
dialogue and ambience together. There is no way to strip just the voices, so a
re-voiced version either layers new speech over the original or loses the ambience.

## Speed

Bulk runs generate several scenes at once, bounded by `CONCURRENCY_IMAGE` (default 3)
and `CONCURRENCY_VIDEO` (default 3). Critic samples for one audit also run together
rather than in sequence. Measured:

- 6 storyboards: **397s sequential -> 193s at 3 concurrent** (~2x; less than 3x
  because a scene's repair attempts are inherently sequential)
- 3 clips at 480p: **129s wall clock**, where one alone takes 109s — near-linear,
  and Replicate accepts the concurrency rather than rejecting it

Caps rather than unbounded fan-out: both providers rate-limit, and Replicate queues
anything over its own per-account limit. Two things had to change for this to be
safe — the job log now appends in a single SQL statement (a read-then-write silently
dropped lines when two scenes logged at once), and the budget guard counts in-flight
reservations, or concurrent clips would all pass the same stale check and overshoot
the ceiling together.

## Render quality

The video section has a **480p / 720p** selector, stored per project and defaulting
to **480p**. Measured on a 4-second clip: 480p returns 496x864 in ~109s, 720p takes
~295s, and 480p bills at well under half the rate. Use 480p while iterating on
storyboards and voices, then switch to 720p for the render you intend to ship —
assembly upscales to 1080x1920, so a 480p source will look soft in the final cut.

Changing the selector affects clips generated from then on; existing clips keep the
resolution they were rendered at, so a project can end up mixing the two.

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
