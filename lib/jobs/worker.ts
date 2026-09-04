import { db, uid, recordCost } from "../db";
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
  // Poll rather than event-drive: the loop is the only consumer and a 1s tick is
  // irrelevant next to job durations measured in minutes.
  timer = setInterval(() => void tick(), 1000);
  if (typeof timer.unref === "function") timer.unref();
}

function appendProgress(jobId: string, line: string) {
  const row = db().prepare(`SELECT progress FROM jobs WHERE id = ?`).get(jobId) as { progress: string | null } | undefined;
  const next = `${row?.progress ?? ""}${line}\n`;
  // Cap the log so a pathological run cannot grow a row without bound.
  const trimmed = next.length > 40_000 ? next.slice(-40_000) : next;
  db().prepare(`UPDATE jobs SET progress = ? WHERE id = ?`).run(trimmed, jobId);
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
  db().prepare(`UPDATE jobs SET status='running', started_at=datetime('now') WHERE id = ?`).run(job.id);
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

const setStatus = (projectId: string, status: string) =>
  db().prepare(`UPDATE projects SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, projectId);

async function execute(
  _jobId: string,
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
      for (const scene of scenario.scenes) {
        log(`--- scene ${scene.id} ---`);
        const r = await runStoryboard({ projectId, scenario, scene, log });
        log(`  ${r.report.verdict}: ${r.report.summary}`);
      }
      return;
    }

    case "storyboard_one": {
      const scene = scenario.scenes.find((s) => s.id === payload.sceneId);
      if (!scene) throw new Error(`Scene ${payload.sceneId} not found`);
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
      for (const scene of scenario.scenes) {
        if (!approved.has(scene.id)) {
          log(`--- scene ${scene.id}: SKIPPED, storyboard not approved ---`);
          continue;
        }
        log(`--- scene ${scene.id} ---`);
        const r = await runSceneVideo({ projectId, scenario, scene, log });
        log(`  ${r.report.verdict}: ${r.report.summary}`);
      }
      return;
    }

    case "video_one": {
      const scene = scenario.scenes.find((s) => s.id === payload.sceneId);
      if (!scene) throw new Error(`Scene ${payload.sceneId} not found`);
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
