import { db, uid, recordCost, recoverOrphanedJobs } from "../db";
import { mapWithConcurrency } from "../util/concurrency";
import { setUsageSink } from "../models/usageTracker";
import { estimateGeminiUsd } from "../models/pricing";
import { ScenarioSchema, type Scenario } from "../pipeline/types";
import { runCharacterCard, runStoryboard, runSceneVideo, runCaptions, runAssembly } from "../pipeline/stages";

/**
 * In-process job runner.
 *
 * A single container with one writer does not need Redis or an external queue, and
 * adding one would be a second thing to operate for no benefit. Jobs are rows; this
 * loop claims them one at a time. Long-running work (a video generation is ~150s, a
 * full assembly several minutes) lives here rather than in a request handler, which
 * is precisely why this tool cannot be a set of serverless functions.
 */

// Bounded concurrency for bulk runs. Sequential generation was the dominant cost of a
// run: twenty clips at ~110s each is over half an hour of waiting. Both providers
// rate-limit, so these are caps rather than "as many as there are scenes", and
// Replicate queues anything over its own per-account limit rather than erroring.
const CONCURRENCY_IMAGE = Number(process.env.CONCURRENCY_IMAGE ?? 3);
const CONCURRENCY_VIDEO = Number(process.env.CONCURRENCY_VIDEO ?? 3);

export type JobKind =
  | "character_card"
  | "storyboards"      // every scene
  | "storyboard_one"   // a single scene, for a re-roll
  | "videos"
  | "video_one"
  | "captions"
  | "assemble";

let running = false;
let timer: NodeJS.Timeout | null = null;

export function enqueue(projectId: string, kind: JobKind, payload: Record<string, unknown> = {}): string {
  const id = uid();
  db()
    .prepare(`INSERT INTO jobs (id, project_id, kind, payload) VALUES (?, ?, ?, ?)`)
    .run(id, projectId, kind, JSON.stringify(payload));
  ensureWorker();
  return id;
}

export function ensureWorker() {
  if (timer) return;
  // A redeploy or crash leaves jobs stuck in `running`; nothing else would ever pick
  // them up again. Recovered once, at the point the worker first starts.
  const recovered = recoverOrphanedJobs();
  if (recovered > 0) console.log(`[worker] requeued ${recovered} interrupted job(s)`);
  // Poll rather than event-drive: the loop is the only consumer and a 1s tick is
  // irrelevant next to job durations measured in minutes.
  timer = setInterval(() => void tick(), 1000);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Appends one line to a job's log in a single statement.
 *
 * Was a SELECT followed by an UPDATE, which silently drops lines the moment two
 * scenes log concurrently — the second write overwrites whatever the first added.
 * Concatenating in SQL keeps every line, and the length cap is applied in the same
 * statement so the row still cannot grow without bound.
 */
function appendProgress(jobId: string, line: string) {
  db()
    .prepare(
      `UPDATE jobs
          SET progress = substr(COALESCE(progress, '') || ? || char(10), -40000)
        WHERE id = ?`
    )
    .run(line, jobId);
}

async function tick() {
  if (running) return;
  const job = db()
    .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`)
    .get() as
    | { id: string; project_id: string; kind: JobKind; payload: string }
    | undefined;
  if (!job) return;

  running = true;
  db()
    .prepare(
      `UPDATE jobs SET status='running', started_at=datetime('now'),
                       attempts = attempts + 1, active_scene = NULL
        WHERE id = ?`
    )
    .run(job.id);
  const log = (m: string) => appendProgress(job.id, m);

  // Bill every Gemini call made anywhere beneath this job — image generation and all
  // agent calls — to the project that caused it. Safe as ambient state only because
  // jobs are strictly serialized; see lib/models/usageTracker.ts.
  setUsageSink((usage, operation) => {
    const usd = estimateGeminiUsd(usage);
    if (usd <= 0 && usage.images === 0) return;
    recordCost({
      projectId: job.project_id,
      provider: "gemini",
      operation,
      usd,
      detail: `${usage.images} image(s), ${usage.promptTokens} in / ${usage.outputTokens} out tokens`,
    });
  });

  try {
    await execute(job.id, job.project_id, job.kind, JSON.parse(job.payload), log);
    db().prepare(`UPDATE jobs SET status='done', finished_at=datetime('now') WHERE id = ?`).run(job.id);
  } catch (err) {
    const msg = (err as Error).message;
    log(`ERROR: ${msg}`);
    db()
      .prepare(`UPDATE jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id = ?`)
      .run(msg, job.id);
  } finally {
    activeScenes.delete(job.id);
    db().prepare(`UPDATE jobs SET active_scene = NULL WHERE id = ?`).run(job.id);
    setUsageSink(null);
    running = false;
  }
}

function loadScenario(projectId: string): Scenario {
  const row = db().prepare(`SELECT scenario_json FROM projects WHERE id = ?`).get(projectId) as
    | { scenario_json: string | null }
    | undefined;
  if (!row?.scenario_json) throw new Error("Project has no scenario yet");
  return ScenarioSchema.parse(JSON.parse(row.scenario_json));
}

/**
 * Tracks every scene currently being worked, not just one.
 *
 * Stored as a JSON array because parallel generation means several scenes are active
 * simultaneously and the UI badges each of them. Kept in memory per job and flushed
 * to the row, so a concurrent add and remove cannot clobber each other.
 */
const activeScenes = new Map<string, Set<string>>();

function flushActive(jobId: string) {
  const set = activeScenes.get(jobId);
  const value = set && set.size ? JSON.stringify([...set]) : null;
  db().prepare(`UPDATE jobs SET active_scene = ? WHERE id = ?`).run(value, jobId);
}

function markActive(jobId: string, sceneId: string) {
  if (!activeScenes.has(jobId)) activeScenes.set(jobId, new Set());
  activeScenes.get(jobId)!.add(sceneId);
  flushActive(jobId);
}

function clearActive(jobId: string, sceneId?: string) {
  const set = activeScenes.get(jobId);
  if (!set) return;
  if (sceneId) set.delete(sceneId);
  else set.clear();
  flushActive(jobId);
}

/** Scene ids that already have an artifact of this kind. */
const existingScenes = (projectId: string, kind: string): Set<string> =>
  new Set(
    (
      db()
        .prepare(`SELECT scene_id FROM artifacts WHERE project_id=? AND kind=? AND scene_id IS NOT NULL`)
        .all(projectId, kind) as { scene_id: string }[]
    ).map((r) => r.scene_id)
  );

const setStatus = (projectId: string, status: string) =>
  db().prepare(`UPDATE projects SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, projectId);

async function execute(
  jobId: string,
  projectId: string,
  kind: JobKind,
  payload: Record<string, unknown>,
  log: (m: string) => void
) {
  const scenario = loadScenario(projectId);

  switch (kind) {
    case "character_card": {
      setStatus(projectId, "character_card");
      const r = await runCharacterCard({ projectId, scenario, log });
      log(r.accepted ? "Character card PASSED automated review." : `Character card needs review: ${r.report.summary}`);
      return;
    }

    case "storyboards": {
      setStatus(projectId, "storyboards");
      // Only generate what is missing. Regenerating everything would overwrite
      // sheets already reviewed and clear their approval (upsertArtifact resets
      // `approved`), throwing away work — so this button resumes rather than restarts.
      // `force` is available over the API for a deliberate full redo.
      const done = payload.force ? new Set<string>() : existingScenes(projectId, "storyboard");
      const todo = scenario.scenes.filter((s) => !done.has(s.id));
      if (done.size) log(`Keeping ${done.size} existing sheet(s); generating ${todo.length}.`);

      log(`Generating ${todo.length} sheet(s), ${Math.min(CONCURRENCY_IMAGE, todo.length)} at a time.`);

      // Scene-prefixed logging, because parallel scenes interleave and an unprefixed
      // line would be impossible to attribute.
      const outcomes = await mapWithConcurrency(todo, CONCURRENCY_IMAGE, async (scene) => {
        markActive(jobId, scene.id);
        const slog = (m: string) => log(`[${scene.id}] ${m.trim()}`);
        try {
          const r = await runStoryboard({ projectId, scenario, scene, log: slog });
          slog(`${r.report.verdict}: ${r.report.summary}`);
          return r;
        } finally {
          clearActive(jobId, scene.id);
        }
      });

      // One scene failing must not abandon the rest. Image generation is refused
      // outright for some scenes (PROHIBITED_CONTENT), which previously aborted the
      // whole run and left every later scene ungenerated.
      let failed = 0;
      outcomes.forEach((o, i) => {
        if (!o.ok) {
          failed++;
          log(`[${todo[i].id}] FAILED: ${o.error.message}`);
        }
      });
      clearActive(jobId);
      // Deliberately not "press Generate again": a scene that produced a sheet
      // before failing already has an artifact, so the missing-only pass skips it.
      if (failed) log(`${failed} scene(s) failed — re-roll those individually.`);
      return;
    }

    case "storyboard_one": {
      const scene = scenario.scenes.find((s) => s.id === payload.sceneId);
      if (!scene) throw new Error(`Scene ${payload.sceneId} not found`);
      markActive(jobId, scene.id);
      const r = await runStoryboard({ projectId, scenario, scene, log });
      log(`  ${r.report.verdict}: ${r.report.summary}`);
      return;
    }

    case "videos": {
      setStatus(projectId, "videos");
      // Only generate from sheets a human approved. This is the gate that keeps the
      // expensive stage downstream of the cheap one.
      const approved = new Set(
        (
          db()
            .prepare(`SELECT scene_id FROM artifacts WHERE project_id=? AND kind='storyboard' AND approved=1`)
            .all(projectId) as { scene_id: string }[]
        ).map((r) => r.scene_id)
      );
      // Never re-render a clip that already exists unless explicitly forced: this
      // stage is billed per attempt, so silently redoing finished work costs money.
      const haveClip = payload.force ? new Set<string>() : existingScenes(projectId, "video");
      let failedVideos = 0;

      const toRender = scenario.scenes.filter((scene) => {
        if (!approved.has(scene.id)) {
          log(`--- scene ${scene.id}: SKIPPED, storyboard not approved ---`);
          return false;
        }
        if (haveClip.has(scene.id)) {
          log(`--- scene ${scene.id}: SKIPPED, clip already generated (re-roll it individually to replace) ---`);
          return false;
        }
        return true;
      });
      log(`Rendering ${toRender.length} clip(s), ${Math.min(CONCURRENCY_VIDEO, toRender.length)} at a time.`);

      const videoOutcomes = await mapWithConcurrency(toRender, CONCURRENCY_VIDEO, async (scene) => {
        markActive(jobId, scene.id);
        const slog = (m: string) => log(`[${scene.id}] ${m.trim()}`);
        try {
          const r = await runSceneVideo({ projectId, scenario, scene, log: slog });
          slog(`${r.report.verdict}: ${r.report.summary}`);
          return r;
        } finally {
          clearActive(jobId, scene.id);
        }
      });

      videoOutcomes.forEach((o, i) => {
        if (!o.ok) {
          failedVideos++;
          log(`[${toRender[i].id}] FAILED: ${o.error.message}`);
        }
      });
      clearActive(jobId);
      if (failedVideos) log(`${failedVideos} scene(s) failed — re-roll those individually.`);
      return;
    }

    case "video_one": {
      const scene = scenario.scenes.find((s) => s.id === payload.sceneId);
      if (!scene) throw new Error(`Scene ${payload.sceneId} not found`);
      markActive(jobId, scene.id);
      const r = await runSceneVideo({ projectId, scenario, scene, log });
      log(`  ${r.report.verdict}: ${r.report.summary}`);
      return;
    }

    case "captions": {
      setStatus(projectId, "captions");
      const r = await runCaptions({ projectId, scenario, log });
      for (const f of r.findings) log(`  ${f.blocking ? "BLOCKING" : "note"}: ${f.detail}`);
      return;
    }

    case "assemble": {
      setStatus(projectId, "assembling");
      const r = await runAssembly({ projectId, scenario, log });
      for (const f of r.report.findings) log(`  ${f.blocking ? "BLOCKING" : "note"}: ${f.detail}`);
      log(`Assembly ${r.report.verdict}: ${r.report.summary}`);
      setStatus(projectId, r.report.verdict === "PASS" ? "complete" : "needs_review");
      return;
    }

    default:
      throw new Error(`Unknown job kind: ${kind}`);
  }
}
