import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { artifact, ensureProjectDirs, safeSceneId } from "../paths";
import { db, uid, recordCost, projectSpendUsd } from "../db";
import { generateImage } from "../models/gemini";
import { generateVideo, transcribe, uploadForTranscription, SEEDANCE_USD_PER_SEC } from "../models/replicate";
import { buildContactSheet, extractAudio, durationOf, exists } from "../media/ffmpeg";
import { assembleFinal } from "../media/assemble";
import { checkAssembly } from "../agents/assemblyCheck";
import { critiqueCharacterCard, critiqueStoryboard, critiqueVideoScene } from "../agents/critics";
import { repairLoop } from "../agents/repair";
import { generateCharacterCardPrompt, generateStoryboardPrompt, generateSeedanceVideoPrompt } from "./prompts";
import { buildCaptions, coverageFindings, type SceneTranscript } from "./captions";
import type { Scenario, Scene } from "./types";
import type { CriticReport } from "../agents/types";

type Log = (m: string) => void;

// Cheap stages iterate freely; the paid one does not. This asymmetry is the whole
// point of gating storyboards before video: a bad sheet costs cents to re-roll, the
// clip generated from it costs real money.
const MAX_ATTEMPTS_IMAGE = Number(process.env.MAX_ATTEMPTS_IMAGE ?? 3);
const MAX_ATTEMPTS_VIDEO = Number(process.env.MAX_ATTEMPTS_VIDEO ?? 2);
const PROJECT_BUDGET_USD = Number(process.env.PROJECT_BUDGET_USD ?? 25);

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

export async function runCharacterCard(opts: {
  projectId: string;
  scenario: Scenario;
  log: Log;
}): Promise<{ report: CriticReport; accepted: boolean; path: string }> {
  await ensureProjectDirs(opts.projectId);
  const outPath = artifact.characterCard(opts.projectId);
  const basePrompt = generateCharacterCardPrompt(opts.scenario.characters);

  const outcome = await repairLoop<string>({
    stage: "character card",
    projectId: opts.projectId,
    basePrompt,
    maxAttempts: MAX_ATTEMPTS_IMAGE,
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
  const basePrompt = generateStoryboardPrompt(opts.scene, opts.scenario.characters);

  const outcome = await repairLoop<string>({
    stage: "storyboard",
    projectId: opts.projectId,
    sceneId: opts.scene.id,
    basePrompt,
    maxAttempts: MAX_ATTEMPTS_IMAGE,
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
        scene: opts.scene,
        attempt,
        // Two samples on the pre-spend gate: this verdict decides whether money gets
        // spent, and single-sample critic judgement is not reproducible on borderline
        // detail even at temperature 0.
        samples: 2,
        onLog: opts.log,
      });
    },
  });

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
  const basePrompt = generateSeedanceVideoPrompt(opts.scene, opts.scenario.characters);
  const costPerAttempt = opts.scene.durationSeconds * SEEDANCE_USD_PER_SEC;

  const outcome = await repairLoop<string>({
    stage: "video",
    projectId: opts.projectId,
    sceneId: opts.scene.id,
    basePrompt,
    maxAttempts: MAX_ATTEMPTS_VIDEO,
    costPerAttemptUsd: costPerAttempt,
    budgetUsd: PROJECT_BUDGET_USD,
    onLog: opts.log,
    generate: async (prompt) => {
      const { predictionId, usd } = await generateVideo({
        prompt,
        referencePaths: [cardPath, sheetPath],
        durationSeconds: opts.scene.durationSeconds,
        outPath,
        onLog: opts.log,
      });
      recordCost({
        projectId: opts.projectId,
        provider: "replicate",
        operation: "seedance-video",
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
      const sheet = await buildContactSheet(
        outPath,
        path.join(artifact.diag(opts.projectId), `vaudit_${safeSceneId(opts.scene.id)}.jpg`)
      );
      return critiqueVideoScene({
        projectId: opts.projectId,
        cardPath,
        contactSheetPath: sheet,
        scene: opts.scene,
        attempt,
        samples: 2,
        onLog: opts.log,
      });
    },
  });

  if (outcome.stoppedBy === "budget") {
    opts.log(
      `  scene ${opts.scene.id}: stopped by budget guard ($${projectSpendUsd(opts.projectId).toFixed(2)} of $${PROJECT_BUDGET_USD} used)`
    );
  }

  return { report: outcome.finalReport, accepted: outcome.accepted, path: outPath };
}

export async function runCaptions(opts: {
  projectId: string;
  scenario: Scenario;
  log: Log;
}): Promise<{ cueCount: number; findings: ReturnType<typeof coverageFindings> }> {
  const transcripts: SceneTranscript[] = [];
  await mkdir(artifact.transcripts(opts.projectId), { recursive: true });

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
  }

  const result = buildCaptions(opts.scenario.scenes, transcripts);
  await writeFile(artifact.captions(opts.projectId), result.srt, "utf-8");
  opts.log(`  ${result.cueCount} caption cues`);

  return { cueCount: result.cueCount, findings: coverageFindings(result.coverage) };
}

export async function runAssembly(opts: {
  projectId: string;
  scenario: Scenario;
  log: Log;
}): Promise<{ report: CriticReport; path: string }> {
  const clipPaths: string[] = [];
  for (const scene of opts.scenario.scenes) {
    const p = artifact.video(opts.projectId, scene.id);
    if (await exists(p)) clipPaths.push(p);
    else opts.log(`  (skipping missing clip for scene ${scene.id})`);
  }
  if (!clipPaths.length) throw new Error("No scene clips available to assemble");

  const outPath = artifact.final(opts.projectId);
  const { storyDurationSeconds, totalDurationSeconds } = await assembleFinal({
    clipPaths,
    srtPath: artifact.captions(opts.projectId),
    outPath,
    workDir: artifact.work(opts.projectId),
    onLog: opts.log,
  });

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
