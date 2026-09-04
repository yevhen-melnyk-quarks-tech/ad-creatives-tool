import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dbPath, DATA_ROOT } from "./paths";

// SQLite on the container's volume rather than a managed Postgres: this is a
// single-container internal tool with one writer (the in-process worker), so an
// external database would add an operational dependency without buying anything.
let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(DATA_ROOT, { recursive: true });
  const d = new Database(dbPath());
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      brief         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'draft',
      scenario_json TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per generated artifact (character card, a scene's storyboard, a scene's
    -- clip). Keeps the approval state the UI gates on, plus the exact prompt used, so
    -- a bad output is always traceable to the text that produced it.
    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,          -- 'character_card' | 'storyboard' | 'video' | 'captions' | 'final'
      scene_id    TEXT,                   -- null for project-wide artifacts
      file_path   TEXT,
      prompt      TEXT,
      attempt     INTEGER NOT NULL DEFAULT 1,
      approved    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, kind, scene_id)
    );

    -- Every critic run, kept even when it passes: the audit trail is what makes an
    -- auto-repair loop reviewable rather than a black box.
    CREATE TABLE IF NOT EXISTS qa_runs (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stage       TEXT NOT NULL,
      scene_id    TEXT,
      attempt     INTEGER NOT NULL DEFAULT 1,
      verdict     TEXT NOT NULL,          -- 'PASS' | 'REVIEW' | 'FAIL' | 'ERROR'
      report_json TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
      progress    TEXT,
      error       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      started_at  TEXT,
      finished_at TEXT
    );

    -- Spend ledger. Paid video re-rolls are the expensive failure mode, so every
    -- billable call is recorded against the project that caused it.
    CREATE TABLE IF NOT EXISTS costs (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider    TEXT NOT NULL,
      operation   TEXT NOT NULL,
      scene_id    TEXT,
      usd         REAL NOT NULL DEFAULT 0,
      detail      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Free-text corrections typed by the operator, fed into the prompt on the next
    -- generation. Kept in its own table rather than on the artifacts row so a note
    -- can be written before an artifact exists, and so it survives the artifact
    -- being replaced by a re-roll.
    CREATE TABLE IF NOT EXISTS artifact_notes (
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      scene_id    TEXT,
      note        TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, kind, scene_id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_qa_project     ON qa_runs(project_id, stage);
    CREATE INDEX IF NOT EXISTS idx_costs_project  ON costs(project_id);
  `);

  // Repair constraints the agent applied to produce this artifact, so a re-roll can
  // build on them and the UI can show what was actually changed.
  addColumnIfMissing(d, "artifacts", "prompt_additions", "TEXT");

  // Which scene a bulk job is on right now, so the UI can mark that row as
  // generating instead of only showing one banner at the top of a long page.
  addColumnIfMissing(d, "jobs", "active_scene", "TEXT");
  // Counts how many times a job has been picked up, to stop an orphaned job that
  // crashes the process from being requeued forever.
  addColumnIfMissing(d, "jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");

  // Render resolution for this project's clips. Defaults to 480p: it is markedly
  // cheaper and faster, which matters most while a project is still being iterated on.
  addColumnIfMissing(d, "projects", "video_resolution", "TEXT NOT NULL DEFAULT '480p'");
}

/**
 * Adds a column to an existing table if it is not already there.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot evolve a table that already has rows, and this
 * database lives on a mounted volume that survives redeploys — so new columns need an
 * explicit, idempotent migration rather than a schema edit.
 */
function addColumnIfMissing(d: Database.Database, table: string, column: string, definition: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const uid = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function recordCost(row: {
  projectId: string;
  provider: string;
  operation: string;
  sceneId?: string | null;
  usd: number;
  detail?: string;
}) {
  db()
    .prepare(
      `INSERT INTO costs (id, project_id, provider, operation, scene_id, usd, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(uid(), row.projectId, row.provider, row.operation, row.sceneId ?? null, row.usd, row.detail ?? null);
}

export const projectSpendUsd = (projectId: string): number =>
  (db().prepare(`SELECT COALESCE(SUM(usd), 0) AS t FROM costs WHERE project_id = ?`).get(projectId) as { t: number }).t;

/** Operator correction for one artifact, or null. */
export function getNote(projectId: string, kind: string, sceneId: string | null): string | null {
  const row = db()
    .prepare(`SELECT note FROM artifact_notes WHERE project_id=? AND kind=? AND scene_id IS ?`)
    .get(projectId, kind, sceneId) as { note: string } | undefined;
  return row?.note?.trim() ? row.note : null;
}

export function setNote(projectId: string, kind: string, sceneId: string | null, note: string) {
  if (!note.trim()) {
    db()
      .prepare(`DELETE FROM artifact_notes WHERE project_id=? AND kind=? AND scene_id IS ?`)
      .run(projectId, kind, sceneId);
    return;
  }
  db()
    .prepare(
      `INSERT INTO artifact_notes (project_id, kind, scene_id, note) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, kind, scene_id) DO UPDATE SET note=excluded.note, updated_at=datetime('now')`
    )
    .run(projectId, kind, sceneId, note.trim());
}

export const listNotes = (projectId: string) =>
  db()
    .prepare(`SELECT kind, scene_id, note FROM artifact_notes WHERE project_id=?`)
    .all(projectId) as { kind: string; scene_id: string | null; note: string }[];

/**
 * Requeues jobs left in `running` by a process that died mid-flight — a redeploy,
 * a crash, an OOM kill.
 *
 * Without this they are zombies: the status query only looks for `queued`, so nothing
 * ever touches them again and the UI shows them as perpetually in progress. Bulk jobs
 * skip work that is already done, so a requeued job resumes rather than starting over.
 *
 * Bounded by `attempts`: a job whose work reliably kills the process would otherwise
 * be picked up, crash, and be requeued in an endless loop.
 */
export function recoverOrphanedJobs(maxAttempts = 3): number {
  const res = db()
    .prepare(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
              error  = CASE WHEN attempts >= ? THEN 'Abandoned after repeated interruptions' ELSE error END,
              progress = COALESCE(progress, '') ||
                CASE WHEN attempts >= ? THEN 'Abandoned: interrupted too many times.' || char(10)
                     ELSE 'Interrupted (process restarted) — requeued to continue.' || char(10) END
        WHERE status = 'running'`
    )
    .run(maxAttempts, maxAttempts, maxAttempts);
  return res.changes;
}
