import { writeFile, mkdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { artifact, ensureProjectDirs, safeSceneId } from "../paths";
import { db, uid, recordCost, projectSpendUsd, getNote, reserveSpend, releaseSpend, setProgress } from "../db";
import { generateImage } from "../models/gemini";
import {
  generateVideo, transcribe, uploadForTranscription,
  SEEDANCE_USD_PER_SEC_BY_RES, SEEDANCE_PROMPT_LIMIT, VIDEO_RESOLUTIONS,
  type VideoResolution,
} from "../models/replicate";
import { buildContactSheet, extractFrames, extractAudio, durationOf, exists, audioOnset } from "../media/ffmpeg";
import { assembleFinal } from "../media/assemble";
import { offloadDeliverables } from "../storage/deliverables";
import { allocateVersion, recordVersion, annotateVersion, promoteVersion, saveSuggestion } from "./versions";
import { checkAssembly } from "../agents/assemblyCheck";
import { critiqueCharacterCard, critiqueStoryboard, critiqueVideoScene } from "../agents/critics";
import { repairLoop, planRepair } from "../agents/repair";
import { generateCharacterCardPrompt, generateStoryboardPrompt, generateSeedanceVideoPrompt, detectByName } from "./prompts";
import {
  buildCaptions, coverageFindings, transcriptSrt, repairLeadingWordTiming, timingFindings,
  type SceneTranscript,
} from "./captions";
import { clampDuration } from "./timing";
import { DESCRIPTORS, descriptorText, splitDescriptor, isDescriptorType, type DescriptorType } from "./descriptors";
import type { Scenario, Scene, Character } from "./types";
import type { CriticReport } from "../agents/types";

type Log = (m: string) => void;

// Cheap stages iterate freely; the paid one does not. This asymmetry is the whole
// point of gating storyboards before video: a bad sheet costs cents to re-roll, the
// clip generated from it costs real money.
const MAX_ATTEMPTS_IMAGE = Number(process.env.MAX_ATTEMPTS_IMAGE ?? 3);
// Not env-configurable like MAX_ATTEMPTS_IMAGE, deliberately: an automatic second
// attempt is exactly the cost this fixes. A FAIL or REVIEW still gets a full critic
// report and a suggested fix (see runSceneVideo) - a human decides whether a re-roll
// is worth paying for, with or without adopting that suggestion into their own note.
const MAX_ATTEMPTS_VIDEO = 1;
const PROJECT_BUDGET_USD = Number(process.env.PROJECT_BUDGET_USD ?? 25);
// Frames the video critic inspects. More frames make persistence judgeable (a defect
// in one frame is an artifact, across several it is real) at a few cents per audit.
const VIDEO_CRITIC_FRAMES = Number(process.env.VIDEO_CRITIC_FRAMES ?? 6);

function upsertArtifact(row: {
  projectId: string;
  kind: string;
  sceneId?: string | null;
  filePath: string;
  prompt: string;
  attempt: number;
}) {
  db()
    .prepare(
      `INSERT INTO artifacts (id, project_id, kind, scene_id, file_path, prompt, attempt)
       VALUES (@id, @projectId, @kind, @sceneId, @filePath, @prompt, @attempt)
       ON CONFLICT(project_id, kind, scene_id) DO UPDATE SET
         file_path = excluded.file_path,
         prompt    = excluded.prompt,
         attempt   = excluded.attempt,
         approved  = 0`
    )
    .run({ id: uid(), sceneId: row.sceneId ?? null, ...row });
}

/**
 * Constraints the repair agent applied last time this artifact was generated.
 *
 * This is what makes a re-roll better than a reshuffle: without it, every re-roll
 * started from the untouched base prompt, re-discovered the same defect, and burned
 * its attempts re-deriving fixes the previous run had already worked out.
 */
/**
 * Widens a scene's cast with anyone the operator's note names.
 *
 * If a human writes "put Mia and Liam a few steps ahead", those characters are in the
 * scene — full stop. Without this the note and the cast disagree, and the machinery
 * turns on itself: the critic reports the children as uncast intruders and the repair
 * agent writes constraints to remove the very people that were just asked for.
 *
 * Applied at generation time rather than at ingest, because a note can be written or
 * changed long after the scenario was stored.
 */
function widenCastForNote(scene: Scene, note: string | null, allCharacters: Character[]): Scene {
  if (!note) return scene;
  const named = detectByName(note, allCharacters);
  const missing = named.filter((c) => !scene.charactersInScene.some((x) => x.id === c.id));
  if (!missing.length) return scene;

  const ordered = allCharacters.filter((c) =>
    [...scene.charactersInScene, ...missing].some((x) => x.id === c.id)
  );
  return { ...scene, charactersInScene: ordered };
}

/** The project's chosen render resolution, defaulting to the cheaper 480p. */
function projectResolution(projectId: string): VideoResolution {
  const row = db()
    .prepare(`SELECT video_resolution FROM projects WHERE id = ?`)
    .get(projectId) as { video_resolution: string | null } | undefined;
  const value = row?.video_resolution as VideoResolution | undefined;
  return value && VIDEO_RESOLUTIONS.includes(value) ? value : "480p";
}

function previousAdditions(projectId: string, kind: string, sceneId: string | null): string[] {
  const row = db()
    .prepare(`SELECT prompt_additions FROM artifacts WHERE project_id=? AND kind=? AND scene_id IS ?`)
    .get(projectId, kind, sceneId) as { prompt_additions: string | null } | undefined;
  if (!row?.prompt_additions) return [];
  try {
    const parsed = JSON.parse(row.prompt_additions);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function saveAdditions(projectId: string, kind: string, sceneId: string | null, additions: string[]) {
  db()
    .prepare(`UPDATE artifacts SET prompt_additions=? WHERE project_id=? AND kind=? AND scene_id IS ?`)
    .run(additions.length ? JSON.stringify(additions) : null, projectId, kind, sceneId);
}

/**
 * Appends the operator's own correction to a prompt.
 *
 * Placed last and marked as overriding, because it is a human looking at the actual
 * output and saying what is wrong — it should win over both the generic template and
 * anything the repair agent inferred. This is the only feedback channel for scenes the
 * QA critic cannot assess at all (any scene whose cast includes a child), so it has to
 * work with no critic report present.
 */
function operatorNoteBlock(
  basePrompt: string,
  projectId: string,
  kind: string,
  sceneId: string | null,
  log: Log,
  maxChars?: number
): string | null {
  const note = getNote(projectId, kind, sceneId);
  if (!note) return null;

  const header =
    "OPERATOR CORRECTIONS — CRITICAL, these come from a human reviewing the previous " +
    "attempt and override any conflicting instruction above:\n";

  let body = note;
  if (maxChars) {
    // The video model rejects prompts over a hard character limit, so a long note
    // would otherwise fail the whole run. Trim it, but say so loudly rather than
    // quietly dropping half of what the operator asked for.
    const room = maxChars - basePrompt.length - header.length - 2;
    if (room <= 0) {
      log(`  WARNING: no room left in the video prompt for your note — it was NOT applied. Shorten the scene's dialogue or action text.`);
      return null;
    }
    if (body.length > room) {
      log(`  WARNING: your note is ${body.length} chars but only ${room} fit in the video prompt — it was trimmed. Shorten it to be sure nothing is lost.`);
      body = body.slice(0, room);
    }
  }

  log(`  applying your note: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`);
  return `${header}${body}`;
}

export async function runCharacterCard(opts: {
  projectId: string;
  scenario: Scenario;
  log: Log;
}): Promise<{ report: CriticReport; accepted: boolean; path: string }> {
  await ensureProjectDirs(opts.projectId);
  const outPath = artifact.characterCard(opts.projectId);
  const basePrompt = generateCharacterCardPrompt(opts.scenario.characters);
  const note = operatorNoteBlock(basePrompt, opts.projectId, "character_card", null, opts.log);
  // Which take the current attempt produced, shared between generate and critique.
  let takeVersion = 0;

  const outcome = await repairLoop<string>({
    stage: "character card",
    projectId: opts.projectId,
    basePrompt,
    maxAttempts: MAX_ATTEMPTS_IMAGE,
    repairOnReview: true,
    seedAdditions: previousAdditions(opts.projectId, "character_card", null),
    trailingInstruction: note,
    onLog: opts.log,
    generate: async (prompt) => {
      // Generated into its own immutable file, then promoted onto the canonical path.
      // A re-roll adds a take instead of destroying the one already there.
      const take = await allocateVersion(opts.projectId, "character_card", null);
      await generateImage({ prompt, outPath: take.file, onLog: opts.log });
      await recordVersion({
        projectId: opts.projectId, kind: "character_card", sceneId: null,
        version: take.version, filePath: take.file, prompt,
      });
      await promoteVersion(opts.projectId, "character_card", null, take.version);
      takeVersion = take.version;
      return outPath;
    },
    critique: async (_r, prompt, attempt) => {
      upsertArtifact({
        projectId: opts.projectId, kind: "character_card", filePath: outPath, prompt,
        attempt: takeVersion,
      });
      const report = await critiqueCharacterCard({
        projectId: opts.projectId,
        cardPath: outPath,
        characters: opts.scenario.characters,
        attempt,
        onLog: opts.log,
      });
      annotateVersion(opts.projectId, "character_card", null, takeVersion, report.verdict, report.summary);
      return report;
    },
  });

  saveAdditions(opts.projectId, "character_card", null, outcome.appliedAdditions);
  return { report: outcome.finalReport, accepted: outcome.accepted, path: outPath };
}

export async function runStoryboard(opts: {
  projectId: string;
  scenario: Scenario;
  scene: Scene;
  log: Log;
}): Promise<{ report: CriticReport; accepted: boolean; path: string }> {
  const cardPath = artifact.characterCard(opts.projectId);
  if (!(await exists(cardPath))) throw new Error("Character card must exist and be approved before storyboards");

  const outPath = artifact.storyboard(opts.projectId, opts.scene.id);
  const rawNote = getNote(opts.projectId, "storyboard", opts.scene.id);
  // The widened scene is used for the prompt AND the critic, so both agree on who
  // belongs here; otherwise the critic reports the operator's own additions as intruders.
  const scene = widenCastForNote(opts.scene, rawNote, opts.scenario.characters);
  if (scene.charactersInScene.length !== opts.scene.charactersInScene.length) {
    opts.log(`  your note names ${scene.charactersInScene.map((c) => c.name).join(", ")} — added to this scene's cast`);
  }
  const basePrompt = generateStoryboardPrompt(scene, opts.scenario.characters);
  const note = operatorNoteBlock(basePrompt, opts.projectId, "storyboard", opts.scene.id, opts.log);

  let takeVersion = 0;

  const outcome = await repairLoop<string>({
    stage: "storyboard",
    projectId: opts.projectId,
    sceneId: opts.scene.id,
    basePrompt,
    maxAttempts: MAX_ATTEMPTS_IMAGE,
    // A storyboard re-roll is cheap, so a REVIEW is worth one more attempt rather
    // than bouncing straight back to the user with nothing tried.
    repairOnReview: true,
    seedAdditions: previousAdditions(opts.projectId, "storyboard", opts.scene.id),
    trailingInstruction: note,
    onLog: opts.log,
    generate: async (prompt) => {
      const take = await allocateVersion(opts.projectId, "storyboard", opts.scene.id);
      await generateImage({ prompt, outPath: take.file, referencePaths: [cardPath], onLog: opts.log });
      await recordVersion({
        projectId: opts.projectId, kind: "storyboard", sceneId: opts.scene.id,
        version: take.version, filePath: take.file, prompt,
      });
      await promoteVersion(opts.projectId, "storyboard", opts.scene.id, take.version);
      takeVersion = take.version;
      return outPath;
    },
    critique: async (_r, prompt, attempt) => {
      upsertArtifact({
        projectId: opts.projectId,
        kind: "storyboard",
        sceneId: opts.scene.id,
        filePath: outPath,
        prompt,
        attempt: takeVersion,
      });
      const report = await critiqueStoryboard({
        projectId: opts.projectId,
        cardPath,
        sheetPath: outPath,
        scene,
        attempt,
        // Two samples on the pre-spend gate: this verdict decides whether money gets
        // spent, and single-sample critic judgement is not reproducible on borderline
        // detail even at temperature 0.
        samples: 2,
        onLog: opts.log,
      });
      annotateVersion(opts.projectId, "storyboard", opts.scene.id, takeVersion, report.verdict, report.summary);
      return report;
    },
  });

  saveAdditions(opts.projectId, "storyboard", opts.scene.id, outcome.appliedAdditions);
  return { report: outcome.finalReport, accepted: outcome.accepted, path: outPath };
}

export async function runSceneVideo(opts: {
  projectId: string;
  scenario: Scenario;
  scene: Scene;
  log: Log;
}): Promise<{ report: CriticReport; accepted: boolean; path: string }> {
  const cardPath = artifact.characterCard(opts.projectId);
  const sheetPath = artifact.storyboard(opts.projectId, opts.scene.id);
  for (const p of [cardPath, sheetPath]) {
    if (!(await exists(p))) throw new Error(`Missing required reference: ${path.basename(p)}`);
  }

  const outPath = artifact.video(opts.projectId, opts.scene.id);
  // Clamped here as well as at ingest, so a scenario stored before the real minimum
  // was known still renders instead of failing every attempt.
  const resolution = projectResolution(opts.projectId);
  const duration = clampDuration(opts.scene.durationSeconds);
  if (duration !== opts.scene.durationSeconds) {
    opts.log(`  scene is ${opts.scene.durationSeconds}s, outside the model's range — rendering at ${duration}s`);
  }
  const rawNote = getNote(opts.projectId, "video", opts.scene.id);
  const scene = widenCastForNote(opts.scene, rawNote, opts.scenario.characters);
  const basePrompt = generateSeedanceVideoPrompt(scene, opts.scenario.characters);
  const note = operatorNoteBlock(
    basePrompt, opts.projectId, "video", opts.scene.id, opts.log, SEEDANCE_PROMPT_LIMIT
  );
  const costPerAttempt = duration * SEEDANCE_USD_PER_SEC_BY_RES[resolution];

  let takeVersion = 0;

  const outcome = await repairLoop<string>({
    stage: "video",
    projectId: opts.projectId,
    sceneId: opts.scene.id,
    basePrompt,
    maxAttempts: MAX_ATTEMPTS_VIDEO,
    costPerAttemptUsd: costPerAttempt,
    budgetUsd: PROJECT_BUDGET_USD,
    // No repairOnReview here: this stage is billed per attempt, so an
    // uncorroborated finding goes to a human instead of spending again.
    seedAdditions: previousAdditions(opts.projectId, "video", opts.scene.id),
    trailingInstruction: note,
    onLog: opts.log,
    generate: async (prompt) => {
      // Reserved before the call and released after, so concurrent clips see each
      // other's in-flight cost in the budget guard instead of all passing the same
      // stale check and overshooting together.
      reserveSpend(opts.projectId, costPerAttempt);
      const take = await allocateVersion(opts.projectId, "video", opts.scene.id);
      let result;
      try {
        // Rendered into its own file, so a re-roll that comes back worse than the take
        // it replaced no longer destroys the better one.
        result = await generateVideo({
          prompt,
          referencePaths: [cardPath, sheetPath],
          durationSeconds: duration,
          outPath: take.file,
          resolution,
          onLog: opts.log,
        });
      } finally {
        releaseSpend(opts.projectId, costPerAttempt);
      }
      await recordVersion({
        projectId: opts.projectId, kind: "video", sceneId: opts.scene.id,
        version: take.version, filePath: take.file, prompt,
      });
      await promoteVersion(opts.projectId, "video", opts.scene.id, take.version);
      takeVersion = take.version;
      const { predictionId, usd } = result;
      recordCost({
        projectId: opts.projectId,
        provider: "replicate",
        operation: `seedance-video-${resolution}`,
        sceneId: opts.scene.id,
        usd,
        detail: predictionId,
      });
      return outPath;
    },
    critique: async (_r, prompt, attempt) => {
      upsertArtifact({
        projectId: opts.projectId,
        kind: "video",
        sceneId: opts.scene.id,
        filePath: outPath,
        prompt,
        attempt: takeVersion,
      });
      const safe = safeSceneId(opts.scene.id);
      // Native-resolution frames for the critic; the contact sheet is still written
      // alongside so a human has one browsable image to glance at.
      const frames = await extractFrames(
        outPath,
        path.join(artifact.diag(opts.projectId), `frames_${safe}`),
        VIDEO_CRITIC_FRAMES
      );
      await buildContactSheet(outPath, path.join(artifact.diag(opts.projectId), `vaudit_${safe}.jpg`)).catch(
        () => undefined
      );
      const report = await critiqueVideoScene({
        projectId: opts.projectId,
        cardPath,
        framePaths: frames,
        scene,
        attempt,
        samples: 2,
        onLog: opts.log,
      });
      annotateVersion(opts.projectId, "video", opts.scene.id, takeVersion, report.verdict, report.summary);
      return report;
    },
  });

  saveAdditions(opts.projectId, "video", opts.scene.id, outcome.appliedAdditions);

  if (outcome.stoppedBy === "budget") {
    opts.log(
      `  scene ${opts.scene.id}: stopped by budget guard ($${projectSpendUsd(opts.projectId).toFixed(2)} of $${PROJECT_BUDGET_USD} used)`
    );
  }

  // Advisory only: video no longer auto-regenerates on a FAIL or REVIEW (see
  // MAX_ATTEMPTS_VIDEO), so this is the one place that suggestion still gets made —
  // once, offered to a human rather than spent on a second render automatically.
  // Skipped when there is nothing to fix: PASS needs no suggestion, and an
  // UNAVAILABLE or empty-findings REVIEW is exactly what planRepair itself would
  // have nothing to work with either (repairLoop applies the same skip).
  if (!outcome.accepted && outcome.finalReport.findings.length > 0 && takeVersion > 0) {
    try {
      const plan = await planRepair({ stage: "video", currentPrompt: basePrompt, report: outcome.finalReport, onLog: opts.log });
      if (plan.promptAdditions.length) {
        saveSuggestion(opts.projectId, "video", opts.scene.id, takeVersion, plan.promptAdditions.join("\n"));
        opts.log(`  suggested fix (${plan.confidence}): ${plan.diagnosis}`);
      }
    } catch (err) {
      // Same reasoning as repairLoop's own guard on this call: a failing planner
      // must not take down a scene whose video generation actually succeeded in
      // producing something to review.
      opts.log(`  could not draft a suggested fix (${(err as Error).message})`);
    }
  }

  return { report: outcome.finalReport, accepted: outcome.accepted, path: outPath };
}

/**
 * Whether captions.srt is missing, or older than the newest clip.
 *
 * Staleness matters as much as absence. Caption timings are absolute offsets into the
 * concatenated story, so re-rolling any scene shifts every cue after it. A file built
 * before that re-roll is not slightly off — it is wrong for the whole remainder of the
 * ad, and nothing about it looks wrong on disk.
 */
export async function captionsAreStale(projectId: string, scenario: Scenario): Promise<string | null> {
  const srt = artifact.captions(projectId);
  if (!(await exists(srt))) return "none have been built yet";

  const srtTime = (await stat(srt)).mtimeMs;
  for (const scene of scenario.scenes) {
    const clip = artifact.video(projectId, scene.id);
    if (!(await exists(clip))) continue;
    if ((await stat(clip)).mtimeMs > srtTime) {
      return `scene ${scene.id}'s clip is newer than the captions, so every cue after it is out of sync`;
    }
  }
  return null;
}

export async function runCaptions(opts: {
  projectId: string;
  scenario: Scenario;
  log: Log;
  /** When given, per-scene transcription progress is published against this job. */
  jobId?: string;
}): Promise<{ cueCount: number; findings: ReturnType<typeof coverageFindings> }> {
  const transcripts: SceneTranscript[] = [];
  const onsets: { sceneId: string; onsetSeconds: number | null }[] = [];
  await mkdir(artifact.transcripts(opts.projectId), { recursive: true });

  // Total is the scenes with dialogue, since silent ones are skipped without a call.
  const needTranscribe = opts.scenario.scenes.filter((s) => s.frames.some((f) => f.dialogue));
  let transcribed = 0;
  if (opts.jobId) setProgress(opts.jobId, "transcribing", 0, needTranscribe.length);

  for (const scene of opts.scenario.scenes) {
    const clip = artifact.video(opts.projectId, scene.id);
    if (!(await exists(clip))) continue;

    const duration = await durationOf(clip);
    // Scenes with no scripted dialogue never need a transcript, and skipping them
    // avoids paying to transcribe ambience that only yields hallucinations.
    if (!scene.frames.some((f) => f.dialogue)) {
      transcripts.push({ sceneId: scene.id, durationSeconds: duration, words: [] });
      continue;
    }

    // Cached per scene, keyed on the clip that produced it. A captions run is twenty
    // network calls against a service that cold-starts, and re-running it used to
    // re-pay for and re-wait on every scene that had already succeeded.
    const cachePath = path.join(artifact.transcripts(opts.projectId), `${safeSceneId(scene.id)}.words.json`);
    const clipStat = await stat(clip);
    let rawWords: Awaited<ReturnType<typeof transcribe>> | null = null;
    if (await exists(cachePath)) {
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
          clipMtimeMs: number; clipBytes: number; words: Awaited<ReturnType<typeof transcribe>>;
        };
        // Only trust it for the same clip: a re-roll changes the audio entirely.
        if (cached.clipBytes === clipStat.size && cached.clipMtimeMs === Math.floor(clipStat.mtimeMs)) {
          rawWords = cached.words;
          opts.log(`  scene ${scene.id}: reusing the transcript already on disk`);
        }
      } catch {
        // A corrupt cache is not worth failing over; transcribe again.
      }
    }

    let failed = false;
    if (!rawWords) {
      opts.log(`  transcribing scene ${scene.id}...`);
      try {
        const wav = path.join(artifact.transcripts(opts.projectId), `${safeSceneId(scene.id)}.wav`);
        await extractAudio(clip, wav);
        const url = await uploadForTranscription(wav, opts.log);
        rawWords = await transcribe({ audioUrl: url, onLog: opts.log });
        await writeFile(
          cachePath,
          JSON.stringify({ clipMtimeMs: Math.floor(clipStat.mtimeMs), clipBytes: clipStat.size, words: rawWords })
        );
        recordCost({
          projectId: opts.projectId,
          provider: "replicate",
          operation: "whisper",
          sceneId: scene.id,
          usd: 0.002,
        });
      } catch (err) {
        // One scene's transcription must not discard the whole run. This is not
        // hypothetical: a single cold start aborted a 20-scene run at scene 17 and
        // threw away sixteen transcriptions that had already succeeded.
        failed = true;
        rawWords = [];
        opts.log(`  WARNING: scene ${scene.id} could not be transcribed (${(err as Error).message.slice(0, 160)})`);
        opts.log(`    it will have no subtitles; the rest of the ad is unaffected. Re-run captions to retry just this scene.`);
      }
    }

    // The model pins the first word of every audio file to 0.00; each clip is
    // transcribed on its own, so without this every scene's captions lead its audio.
    const onset = await audioOnset(clip);
    const words = failed ? [] : repairLeadingWordTiming(rawWords, onset);
    if (words[0] && rawWords[0] && words[0].start !== rawWords[0].start) {
      opts.log(
        `    first word "${rawWords[0].word}" reported at ${rawWords[0].start.toFixed(2)}s, ` +
          `corrected to ${words[0].start.toFixed(2)}s (audio starts at ${(onset ?? 0).toFixed(2)}s)`
      );
    }
    onsets.push({ sceneId: scene.id, onsetSeconds: onset });
    transcripts.push({ sceneId: scene.id, durationSeconds: duration, words, failed });
    if (opts.jobId) setProgress(opts.jobId, "transcribing", ++transcribed, needTranscribe.length);
  }

  const result = buildCaptions(opts.scenario.scenes, transcripts);
  await writeFile(artifact.captions(opts.projectId), result.srt, "utf-8");

  // The timed script, written alongside the captions since it comes from the same
  // alignment. Line-level and machine-readable, so a translation pass or a
  // text-to-speech pass has both the wording and the window it has to fit.
  await writeFile(
    artifact.transcriptJson(opts.projectId),
    JSON.stringify(
      {
        title: opts.scenario.title,
        storyDurationSeconds: Number(offsetTotal(transcripts).toFixed(2)),
        lines: result.transcript,
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(artifact.transcriptSrt(opts.projectId), transcriptSrt(result.transcript), "utf-8");
  opts.log(`  ${result.cueCount} caption cues, ${result.transcript.length} transcript line(s)`);

  // Two independent checks on the same output: coverage asks whether the clip says the
  // scripted words at all, timing asks whether the cues land on the sound. The timing
  // one exists because captions that are wrong in time still look perfectly fine on
  // disk - which is exactly how they shipped out of sync.
  const timed = result.timing.map((t) => ({
    ...t,
    onsetSeconds: onsets.find((o) => o.sceneId === t.sceneId)?.onsetSeconds ?? null,
  }));
  // A scene that could not be transcribed has no cues at all, which is invisible in a
  // 200-cue file - so it is reported rather than left for someone to notice.
  const untranscribed = transcripts
    .filter((t) => t.failed)
    .map((t) => ({
      blocking: false,
      category: "captions-missing",
      subject: `scene ${t.sceneId}`,
      detail:
        `This scene has no subtitles: transcription failed for it. The rest of the ad is ` +
        `correctly timed. Re-run captions to retry just this scene - the others are cached.`,
    }));

  const findings = [...coverageFindings(result.coverage), ...timingFindings(timed), ...untranscribed];
  const early = findings.filter((f) => f.category === "caption-timing");
  if (early.length) {
    opts.log(`  WARNING: ${early.length} scene(s) still have subtitles ahead of the audio:`);
    for (const f of early) opts.log(`    - ${f.detail}`);
  } else {
    opts.log(`  timing check: every scene's first cue lands on or after its audio onset.`);
  }

  return { cueCount: result.cueCount, findings };
}

const offsetTotal = (ts: SceneTranscript[]) => ts.reduce((sum, t) => sum + t.durationSeconds, 0);

/**
 * The descriptor this project's cut should carry, and the text to burn.
 *
 * Order of precedence: text the operator edited, then the type they chose, then the
 * type the brief's version block selected, then type 2 — the safest default, since it
 * is the one required when a person is shown and these ads always show people.
 */
export function resolveDisclaimer(
  projectId: string,
  scenario: Scenario
): { type: DescriptorType; bold: string; body: string; source: string } {
  const row = db()
    .prepare(`SELECT descriptor_type, disclaimer_text FROM projects WHERE id = ?`)
    .get(projectId) as { descriptor_type: number | null; disclaimer_text: string | null } | undefined;

  const fromBrief = scenario.versions.find((v) => isDescriptorType(v.descriptorType));
  const type: DescriptorType = isDescriptorType(row?.descriptor_type)
    ? row!.descriptor_type
    : fromBrief
      ? (fromBrief.descriptorType as DescriptorType)
      : 2;

  const source = isDescriptorType(row?.descriptor_type)
    ? "chosen in the app"
    : fromBrief
      ? `from the brief (${fromBrief.label}${fromBrief.name ? ` — ${fromBrief.name}` : ""})`
      : "default, the brief named no version";

  if (row?.disclaimer_text?.trim()) {
    return { type, ...splitDescriptor(row.disclaimer_text), source: "edited in the app" };
  }
  return { type, bold: DESCRIPTORS[type].bold, body: DESCRIPTORS[type].body, source };
}

export async function runAssembly(opts: {
  projectId: string;
  scenario: Scenario;
  log: Log;
  onProgress?: (fraction: number, label: string) => void;
}): Promise<{ report: CriticReport; path: string }> {
  const clipPaths: string[] = [];
  for (const scene of opts.scenario.scenes) {
    const p = artifact.video(opts.projectId, scene.id);
    if (await exists(p)) clipPaths.push(p);
    else opts.log(`  (skipping missing clip for scene ${scene.id})`);
  }
  if (!clipPaths.length) throw new Error("No scene clips available to assemble");

  const outPath = artifact.final(opts.projectId);
  const disclaimer = resolveDisclaimer(opts.projectId, opts.scenario);
  opts.log(
    `  descriptor type ${disclaimer.type} (${disclaimer.source}): ` +
      `"${[disclaimer.bold, disclaimer.body].filter(Boolean).join(" ")}"`
  );

  // The previously delivered cut is deliberately NOT deleted here.
  //
  // It used to be, to stop a stale signed URL outliving the file it named. But once a
  // project's deliverables are offloaded the local copies are gone, so deleting the
  // stored ones before the render left exactly one copy of the finished ad - the one
  // ffmpeg was about to write. A failed render (out of disk, out of memory, a killed
  // process, all of which have happened here) meant the finished ad existed nowhere.
  //
  // Nothing is lost by keeping it: the offload at the end writes to the same keys, so
  // the new cut replaces the old one atomically from a reader's point of view. Until it
  // does, a download link serves the previous cut, which beats serving nothing.

  const { storyDurationSeconds, totalDurationSeconds, cleanPath } = await assembleFinal({
    clipPaths,
    srtPath: artifact.captions(opts.projectId),
    outPath,
    // A fresh, unique scratch directory per attempt (see workAttempt in lib/paths.ts):
    // no two runs of this job, whatever caused there to be two, can delete or
    // overwrite each other's intermediate files.
    workDir: artifact.workAttempt(opts.projectId, uid()),
    disclaimerBold: disclaimer.bold,
    disclaimerRegular: disclaimer.body,
    onLog: opts.log,
    onProgress: opts.onProgress,
  });

  if (cleanPath) opts.log(`  clean master -> ${path.basename(cleanPath)}`);

  const report = await checkAssembly({
    finalPath: outPath,
    expectedDurationSeconds: totalDurationSeconds,
    ctaStartSeconds: storyDurationSeconds,
  });

  db()
    .prepare(`INSERT INTO qa_runs (id, project_id, stage, verdict, report_json) VALUES (?, ?, 'assembly', ?, ?)`)
    .run(uid(), opts.projectId, report.verdict, JSON.stringify(report));

  // After the critic, never before: it reads the finished file off the disk.
  //
  // A storage failure must not fail an assembly that succeeded. The deliverables are
  // correct and readable either way; where they are stored is an optimisation, and
  // reporting a completed render as failed because an upload timed out would be a
  // worse outcome than a full volume.
  opts.log("Moving deliverables to object storage...");
  try {
    await offloadDeliverables(opts.projectId, opts.log);
  } catch (e) {
    opts.log(`  offload failed, deliverables kept on the volume: ${(e as Error).message}`);
  }

  return { report, path: outPath };
}
