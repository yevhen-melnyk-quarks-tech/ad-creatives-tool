import { writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { artifact, ensureProjectDirs, safeSceneId } from "../paths";
import { db, uid, recordCost, projectSpendUsd, getNote, reserveSpend, releaseSpend, setProgress } from "../db";
import { generateImage } from "../models/gemini";
import {
  generateVideo, transcribe, uploadForTranscription,
  SEEDANCE_USD_PER_SEC_BY_RES, SEEDANCE_PROMPT_LIMIT, VIDEO_RESOLUTIONS,
  type VideoResolution,
} from "../models/replicate";
import { buildContactSheet, extractFrames, extractAudio, durationOf, exists } from "../media/ffmpeg";
import { assembleFinal } from "../media/assemble";
import { checkAssembly } from "../agents/assemblyCheck";
import { critiqueCharacterCard, critiqueStoryboard, critiqueVideoScene } from "../agents/critics";
import { repairLoop } from "../agents/repair";
import { generateCharacterCardPrompt, generateStoryboardPrompt, generateSeedanceVideoPrompt, detectByName } from "./prompts";
import { buildCaptions, coverageFindings, transcriptSrt, type SceneTranscript } from "./captions";
import { clampDuration } from "./timing";
import { DESCRIPTORS, descriptorText, splitDescriptor, isDescriptorType, type DescriptorType } from "./descriptors";
import type { Scenario, Scene, Character } from "./types";
import type { CriticReport } from "../agents/types";

type Log = (m: string) => void;

// Cheap stages iterate freely; the paid one does not. This asymmetry is the whole
// point of gating storyboards before video: a bad sheet costs cents to re-roll, the
// clip generated from it costs real money.
const MAX_ATTEMPTS_IMAGE = Number(process.env.MAX_ATTEMPTS_IMAGE ?? 3);
const MAX_ATTEMPTS_VIDEO = Number(process.env.MAX_ATTEMPTS_VIDEO ?? 2);
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
      await generateImage({ prompt, outPath, onLog: opts.log });
      return outPath;
    },
    critique: (_r, prompt, attempt) => {
      upsertArtifact({ projectId: opts.projectId, kind: "character_card", filePath: outPath, prompt, attempt });
      return critiqueCharacterCard({
        projectId: opts.projectId,
        cardPath: outPath,
        characters: opts.scenario.characters,
        attempt,
        onLog: opts.log,
      });
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
      await generateImage({ prompt, outPath, referencePaths: [cardPath], onLog: opts.log });
      return outPath;
    },
    critique: (_r, prompt, attempt) => {
      upsertArtifact({
        projectId: opts.projectId,
        kind: "storyboard",
        sceneId: opts.scene.id,
        filePath: outPath,
        prompt,
        attempt,
      });
      return critiqueStoryboard({
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
      let result;
      try {
        result = await generateVideo({
          prompt,
          referencePaths: [cardPath, sheetPath],
          durationSeconds: duration,
          outPath,
          resolution,
          onLog: opts.log,
        });
      } finally {
        releaseSpend(opts.projectId, costPerAttempt);
      }
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
        attempt,
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
      return critiqueVideoScene({
        projectId: opts.projectId,
        cardPath,
        framePaths: frames,
        scene,
        attempt,
        samples: 2,
        onLog: opts.log,
      });
    },
  });

  saveAdditions(opts.projectId, "video", opts.scene.id, outcome.appliedAdditions);

  if (outcome.stoppedBy === "budget") {
    opts.log(
      `  scene ${opts.scene.id}: stopped by budget guard ($${projectSpendUsd(opts.projectId).toFixed(2)} of $${PROJECT_BUDGET_USD} used)`
    );
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

    opts.log(`  transcribing scene ${scene.id}...`);
    const wav = path.join(artifact.transcripts(opts.projectId), `${safeSceneId(scene.id)}.wav`);
    await extractAudio(clip, wav);
    const url = await uploadForTranscription(wav, opts.log);
    const words = await transcribe({ audioUrl: url, onLog: opts.log });
    recordCost({
      projectId: opts.projectId,
      provider: "replicate",
      operation: "whisper",
      sceneId: scene.id,
      usd: 0.002,
    });
    transcripts.push({ sceneId: scene.id, durationSeconds: duration, words });
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

  return { cueCount: result.cueCount, findings: coverageFindings(result.coverage) };
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

  const { storyDurationSeconds, totalDurationSeconds, cleanPath } = await assembleFinal({
    clipPaths,
    srtPath: artifact.captions(opts.projectId),
    outPath,
    workDir: artifact.work(opts.projectId),
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

  return { report, path: outPath };
}
