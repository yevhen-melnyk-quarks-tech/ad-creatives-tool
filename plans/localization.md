# Plan — Localization stage (Step 5)

Status: awaiting approval. Delete this file at `/document` time.

## Goal

After a final cut tests well, localize it to other markets: translated captions,
translated voiceover, lip-sync — producing one finished, downloadable
`FINAL_<lang>.mp4` per language. Optional per project; the language list is chosen
once and reused.

## What already exists that this builds on

`assembleFinal` already writes **`MASTER_clean.mp4`** — "same footage and audio, no
burned text of any kind" (`lib/media/assemble.ts:70`), a cheap stream copy, already
offloaded to R2. The code comments there say outright that this file exists so a
locale can re-burn its own captions and re-render its own CTA. This plan is the
consumer that was anticipated.

Two properties of it that shape everything below:

- it is at the **clips' native resolution** (720x1280, or 496x864 for 480p) — *not*
  1080x1920, and
- it has **no CTA outro** (deliberately: without text the outro is just a blurred
  still, cheaper to re-render per locale).

So a localized cut is not "master + new audio". It is: master -> HeyGen -> scale to
1080x1920, burn translated captions + descriptor, append a CTA. That is exactly the
tail of `assembleFinal`, applied to an already-concatenated source.

## Verified against the live API (2026-09-11, checkpoint 1 — DONE)

Probed with a real 4.1-second clip translated to Spanish. Cost 4 credits. Findings
that differ from the published docs are marked ->.

**Endpoints** (base `https://api.heygen.com`, header `x-api-key`):

- `GET /v3/video-translations/languages` -> `{data:{languages:[...]}}`, **190** entries,
  names like `"Spanish"`, `"Spanish (Spain)"`, `"German (Austria)"`.
- `POST /v3/video-translations` -> **202**, and the body is
  -> `{"data":{"video_translation_ids":["<id>-es"]}}` — a LIST, one id per requested
  language, each suffixed with the language code. Not the `translation_id` the docs
  describe.
- `GET /v3/video-translations/{id}` -> status is -> `running` then **`completed`**,
  not the `success` the docs list. Completed payload carries `video_url`,
  `srt_caption_url`, `vtt_caption_url`, **`audio_url`** (translated audio alone) and
  `duration`.
- `GET /v2/user/remaining_quota` -> `data.details.api` — the credit balance. v2 is
  deprecated (removed 2026-10-31); find the v3 equivalent before relying on it.

**Billing — the assumption this architecture rested on, now measured.**
A 4.04-second clip cost **4 credits**. Pro-rated per-minute billing would have been
~0.34. So HeyGen charges an effective one-minute minimum per call.

| | per call | 3.5-min ad, per language |
|---|---|---|
| one call on the clean master | ~18 credits | **~18** |
| one call per clip (14 clips) | 4 credits each | ~56 |

**Per-clip is ~3x more expensive.** The clean-master approach in this plan is
confirmed, by measurement rather than assumption. (Per-clip would have been the
smaller diff — it reuses `assembleFinal` untouched — so this was a real fork.)

**Output properties** (input 496x864, 4.096s, 32 kHz stereo):

- resolution **preserved** (496x864) — HeyGen does not rescale.
- duration **4.096s -> 4.608s**, +12%. `enable_dynamic_duration` re-times the video to
  fit translated speech. This is the hard proof that captions must come from HeyGen:
  our English `transcript.json` timings would drift by seconds over a 3.5-minute ad.
- audio comes back **48 kHz stereo** — already matching the `AAC` preset in
  `assemble.ts`.
- -> the output carries an **embedded `mov_text` subtitle track** when
  `enable_caption: true`. Harmless but must be explicitly dropped when re-burning, or
  it rides along into the deliverable as a soft track.
- the returned SRT is **BOM-prefixed** and uses multi-line cues
  (`"Ahora trabajo\npor mi cuenta."`) — strip the BOM and re-chunk to house style.

**Timing:** ~100 seconds to translate a 4-second clip. A 3.5-minute master will take
considerably longer, which makes the 90-second heartbeat requirement below the single
most likely thing to break this feature in production.

**Lip-sync quality on stylised 3D characters: verified good.** Matched-moment frame
comparison shows mouth shapes changing while background, the second character, props
and clothing stay pixel-stable — HeyGen re-renders only the mouth region. Risk 2 is
retired. Two characters were in frame and `speaker_num` was left at `auto`.

**Account:** 2,451 API credits remaining after the probe.

## Approach

```
MASTER_clean.mp4  --presigned R2 URL-->  HeyGen /v3/video-translations
                                              |  (per language)
                                              +--> translated + lip-synced mp4
                                              +--> translated SRT (enable_caption)
                                                        |
                              scale -> burn captions + descriptor -> CTA outro
                                                        v
                                          FINAL_<lang>.mp4  -> R2 -> download
```

**One HeyGen call per language, on the whole master — not per clip.** Per-clip would
reuse `assembleFinal` unchanged and would be a smaller diff, but HeyGen bills per
minute and very likely rounds up per call: 14 clips of 4-15s each would bill as ~14
minutes instead of 3.5, roughly 4x the cost per language. **This rounding assumption
is unverified and is the first thing to check against the live API** (see Risks).

**Captions come from HeyGen, re-chunked to our style.** HeyGen's `enable_caption`
SRT is timed against the dubbed audio, which is the only thing that matches after
translation changes the speech length. Our own `transcript.json` timings are for the
English audio and would drift. We re-chunk HeyGen's cues to the existing <=3 words /
<=1.8s house style, interpolating within each cue, and burn with the same
`force_style` so localized cuts look identical to the English one.

**Disclaimer and CTA stay in English** (your choice of the three options). Noted as a
deliberate decision, not an oversight — flagging once that a legal disclaimer shown
in a non-English market may need a translated version later; the per-locale CTA
re-render already gives us the seam to do it without re-encoding the footage.

## Checkpoints

### 1. HeyGen client + live API verification

`lib/models/heygen.ts`, in the shape of `lib/models/replicate.ts`.

- `listLanguages()`, `createTranslation()`, `pollTranslation()`, `fetchCaptions()`.
- Uses `fetchRetry` (so it inherits the AbortController fix) with the `x-api-key`
  header.
- **Before writing the rest: hit the live API once** and confirm the endpoint
  version (docs show both a v2 `/v2/video_translate` and a v3
  `/v3/video-translations`), the real request/response field names, the billing
  granularity, and the max input duration. Adjust this plan if they differ.
- No `recordCost` yet — just the client.

### 2. App-wide settings

There is no settings table, no key/value store and no app-level API route today —
per-project config lives as columns on `projects`, which does not fit.

- `app_settings(key TEXT PRIMARY KEY, value TEXT, updated_at)` in `migrate()`, with
  `getSetting`/`setSetting` helpers next to the existing `getNote`/`setNote`.
- `GET/PUT /api/settings` (the first app-level route in the repo).
- Stores `localize.languages` as a JSON array of HeyGen language names.

### 3. Dynamic deliverables

`DELIVERABLES` is a static array consumed by `offloadDeliverables`,
`deliverableLocations` and the share-link allowlist. Per-language files are dynamic,
so all three break today.

- Replace with `deliverablesFor(projectId)` = the static list plus one
  `FINAL_<lang>.mp4` per language present on disk or in `remote_objects`.
- Update the three call sites, including `app/api/projects/[id]/share/route.ts`
  (an unlisted name currently 400s).
- The download route needs no change — it serves any file in the project dir by name.

### 4. The localize job

- Add `"localize"` to `JobKind`, to the `KINDS` allowlist in the jobs route, and to
  `KIND_LABEL` in the workspace.
- **Widen the jobs POST route to carry a payload beyond `sceneId`/`force`** — it
  drops every other field today, so `languages` would silently vanish.
- **Fix duplicate-coalescing**, which keys only on `kind` + `payload.sceneId`: two
  different languages would wrongly collapse onto one job. One job for all languages
  sidesteps this; do that, and keep the guard honest.
- **Count against `MAX_CONCURRENT_ASSEMBLE`, not just the project cap** — this job
  runs a full-length encode per language in a 1 GB container.
- **Heartbeat while polling HeyGen.** `recoverOrphanedJobs` requeues any `running`
  job silent for >90s. A translation takes minutes. Every poll must call
  `setProgress`/`log`, or the job gets yanked back to `queued` mid-flight and pays
  HeyGen twice.
- **Handle `MASTER_clean.mp4` being absent** — it is legitimately skipped when disk
  was tight at assembly time. Fail with a message that says "re-assemble to produce
  it", not a file-not-found.
- Per language, sequentially: presign master -> create translation -> poll ->
  download -> fetch captions -> re-chunk -> burn -> offload. One language failing
  must not abandon the others.

### 5. Re-burn entry point

`assembleFinal` takes a clip list; we need the same tail against one finished file.

- Extract the scale/burn/CTA tail into `burnAndFinish({ sourcePath, srtPath, outPath, ... })`,
  and have `assembleFinal` call it, so the English and localized paths cannot drift.
- Reuse `run()` for progress and its SIGKILL/out-of-disk diagnostics; respect
  `ENCODER_LIMITS` (an uncapped filter graph has hit exactly 1.000 GB and been
  SIGKILLed here before).
- Export `srtTime` from `captions.ts` for writing the re-chunked SRT.

### 6. Cost

- `recordCost({ provider: "heygen", operation: "translate-<lang>", usd, detail })` —
  HeyGen is not Gemini, so the automatic `AsyncLocalStorage` sink does not cover it.
- Charge against `PROJECT_BUDGET_USD` (raised 40 -> 50 on Railway, 2026-09-11). A
  3.5-minute ad x 5 languages at ~$2/min is ~$35, which still leaves a localization
  run as by far the largest single spend a project can make, so the UI must show the
  estimate **before** the button is pressed, and the budget guard must stop the run
  rather than discovering it halfway.

### 7. UI — Step 5

New `<Step n={5} title="Localization">` after the assembly section
(`ProjectWorkspace.tsx:871`), gated on a finished final cut.

- Language chips + an editor that writes the app setting (populated live from
  HeyGen's languages endpoint).
- Estimated cost line, then a `Localize` button.
- Per-language rows: status, progress, download link, `ShareLink`.
- Existing UI standards apply: instant press feedback, shaped shimmer while a
  language is rendering, no blanking of already-finished rows on the 4s refresh.

## QA (per `/qa`, cost-aware)

- Free first: `listLanguages()` against the live API; the settings round-trip; the
  re-chunker as a pure function over a fixture SRT; `deliverablesFor` with and
  without localized files; the jobs-route payload widening; the coalescing fix.
- Then **one** paid end-to-end run on the shortest available project, **one**
  language, verifying the actual output file: correct duration, 1080x1920, audio in
  the target language, captions present and readable, CTA intact — not merely "the
  job said done".
- Verify the 90s heartbeat by watching a real HeyGen poll survive past 90 seconds
  without being requeued.

## Risks

1. **HeyGen's billing granularity is unverified** — if it rounds per call rather than
   per minute, the per-clip alternative becomes cheaper and the architecture changes.
   Check in checkpoint 1.
2. **Lip-sync on stylised 3D characters, multi-speaker.** Confirmed 2026-09-11: the
   designer uses real lip-sync, not audio-dub-only, on this exact footage — so
   quality is a known quantity. Settled settings, all matching HeyGen's documented
   defaults except the caption flag:

   | Field | Value | Why |
   |---|---|---|
   | `mode` | `speed` | chosen 2026-09-11; revisit `precision` (2x cost, re-renders the mouth) only if quality disappoints |
   | `translate_audio_only` | `false` (default) | lip-sync on |
   | `speaker_num` | unset | documented default is `auto`; HeyGen gives no manual guidance, so do not second-guess it |
   | `enable_caption` | **`true`** | the only non-default — we need the translated SRT |
   | `enable_dynamic_duration` | `true` (default) | HeyGen may re-time the video to fit translated speech |

   `enable_dynamic_duration` is why captions must come from HeyGen rather than our
   own `transcript.json`: the localized cut can be a different length than the
   English one, so English timings would drift.
3. **Memory.** One more full-length encode per language in a 1 GB container. Mitigated
   by joining the assemble cap and reusing `ENCODER_LIMITS`, but it is the failure
   mode with the least forgiving symptom (SIGKILL).
4. **Disk.** Each language adds a full-length intermediate plus a final cut. Offload
   each language before starting the next.

## Blocking

**`HEYGEN_API_KEY` is not set** in this repo's `.env.local` or on Railway. The
decision (2026-09-11) is to reuse growli-spa's key — the same one behind AI Avatars,
env var `HEYGEN_API_KEY`, base `https://api.heygen.com`, `x-api-key` header, v3
endpoints (`lib/heygenService.ts` there is a working reference implementation and
corroborates the v3 API family this plan targets).

Open concern, not a blocker: one key shared between a user-facing product feature
and this internal tool means one credit pool. A ~$35 localization run could starve
Growli's avatar generation, and a runaway loop here would surface as a customer
incident there. A separate API key for this tool is cheap (HeyGen's API billing is
standalone pay-as-you-go) and keeps the blast radius contained. Recommend it;
proceeding on the shared key if you'd rather not wait.
