import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { db, uid } from "../db";
import { versionPath, currentPath, humanBytes } from "../paths";
import { exists } from "../media/ffmpeg";

/**
 * Generation history.
 *
 * Every attempt is written to its own immutable file and recorded here; the canonical
 * path the rest of the pipeline reads (scene_X_video.mp4) holds a promoted copy. A
 * re-roll therefore adds a take rather than replacing one, which is what the motion
 * designer asked for: "sometimes from two bad generations you can splice a good one."
 *
 * The promoted current file is a real copy, not a hard link, and that costs ~10 MB per
 * scene. It buys an invariant worth more than the disk: nothing that writes to the
 * canonical path can reach back and corrupt the history behind it. A link would make
 * every future writer of that path a silent destroyer of the record — precisely the
 * failure this feature exists to prevent.
 */

export type Version = {
  id: string;
  project_id: string;
  kind: string;
  scene_id: string | null;
  version: number;
  file_path: string;
  prompt: string | null;
  verdict: string | null;
  summary: string | null;
  suggested_note: string | null;
  bytes: number;
  is_current: number;
  created_at: string;
};

/** The next version number for this artifact — 1 when nothing has been generated. */
export function nextVersion(projectId: string, kind: string, sceneId: string | null): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions
        WHERE project_id=? AND kind=? AND scene_id IS ?`
    )
    .get(projectId, kind, sceneId) as { v: number };
  return row.v + 1;
}

/** Where the next attempt should be written. Callers generate straight into this. */
export async function allocateVersion(projectId: string, kind: string, sceneId: string | null) {
  const version = nextVersion(projectId, kind, sceneId);
  const file = versionPath(projectId, kind, sceneId, version);
  await mkdir(path.dirname(file), { recursive: true });
  return { version, file };
}

/** Records an attempt that has been written to disk. */
export async function recordVersion(opts: {
  projectId: string;
  kind: string;
  sceneId: string | null;
  version: number;
  filePath: string;
  prompt?: string | null;
  verdict?: string | null;
  summary?: string | null;
}) {
  const bytes = await stat(opts.filePath).then((s) => s.size).catch(() => 0);
  db()
    .prepare(
      `INSERT INTO artifact_versions
         (id, project_id, kind, scene_id, version, file_path, prompt, verdict, summary, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, kind, scene_id, version) DO UPDATE SET
         verdict=excluded.verdict, summary=excluded.summary, bytes=excluded.bytes`
    )
    .run(
      uid(), opts.projectId, opts.kind, opts.sceneId, opts.version, opts.filePath,
      opts.prompt ?? null, opts.verdict ?? null, opts.summary ?? null, bytes
    );
}

/** Attaches the critic's verdict to a take after the fact. */
export function annotateVersion(
  projectId: string, kind: string, sceneId: string | null, version: number,
  verdict: string, summary: string
) {
  db()
    .prepare(
      `UPDATE artifact_versions SET verdict=?, summary=?
        WHERE project_id=? AND kind=? AND scene_id IS ? AND version=?`
    )
    .run(verdict, summary, projectId, kind, sceneId, version);
}

/**
 * Attaches the repair agent's diagnosis to a take that failed review, for a human to
 * read and optionally carry into a manual re-roll's note — see the video generation
 * stage, which stopped auto-applying this the same way the image stages still do.
 */
export function saveSuggestion(
  projectId: string, kind: string, sceneId: string | null, version: number, note: string
) {
  db()
    .prepare(
      `UPDATE artifact_versions SET suggested_note=?
        WHERE project_id=? AND kind=? AND scene_id IS ? AND version=?`
    )
    .run(note, projectId, kind, sceneId, version);
}

/**
 * Makes one take the current one: copies it over the canonical path and moves the
 * pointer. Everything downstream (assembly, transcription, the critics) keeps reading
 * the canonical path and needs no knowledge of versions at all.
 */
export async function promoteVersion(projectId: string, kind: string, sceneId: string | null, version: number) {
  const row = db()
    .prepare(
      `SELECT * FROM artifact_versions WHERE project_id=? AND kind=? AND scene_id IS ? AND version=?`
    )
    .get(projectId, kind, sceneId, version) as Version | undefined;
  if (!row) throw new Error(`No version ${version} for ${kind} ${sceneId ?? ""}`.trim());
  if (!(await exists(row.file_path))) throw new Error(`Version ${version} file is missing: ${row.file_path}`);

  const target = currentPath(projectId, kind, sceneId);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(row.file_path, target);

  db()
    .prepare(`UPDATE artifact_versions SET is_current=0 WHERE project_id=? AND kind=? AND scene_id IS ?`)
    .run(projectId, kind, sceneId);
  db().prepare(`UPDATE artifact_versions SET is_current=1 WHERE id=?`).run(row.id);

  // Keep the artifacts row's file_path and attempt in step, since the interface and
  // the bulk "skip what already exists" logic both read from there.
  //
  // Approval is cleared, because approval is of a specific image or clip and is not
  // tracked per take. Carrying it across a switch would mean a storyboard nobody
  // approved still counted as approved - and for storyboards that flag is the gate
  // standing between a re-roll and a paid video render.
  db()
    .prepare(
      `UPDATE artifacts SET file_path=?, attempt=?, approved=0
        WHERE project_id=? AND kind=? AND scene_id IS ?`
    )
    .run(target, version, projectId, kind, sceneId);

  return { target, version };
}

export const listVersions = (projectId: string, kind?: string, sceneId?: string | null): Version[] =>
  (kind === undefined
    ? db().prepare(`SELECT * FROM artifact_versions WHERE project_id=? ORDER BY kind, scene_id, version`).all(projectId)
    : db()
        .prepare(
          `SELECT * FROM artifact_versions WHERE project_id=? AND kind=? AND scene_id IS ?
            ORDER BY version`
        )
        .all(projectId, kind, sceneId ?? null)) as Version[];

/**
 * Deletes every take except the current one.
 *
 * Manual only, never automatic. Retention was a deliberate product decision: the
 * point of this feature is that nothing disappears unless the operator asks, so an
 * age or count cap would quietly reintroduce the loss it was built to stop.
 */
export async function pruneVersions(projectId: string, log: (m: string) => void = () => {}) {
  const rows = db()
    .prepare(`SELECT * FROM artifact_versions WHERE project_id=? AND is_current=0`)
    .all(projectId) as Version[];

  let freed = 0;
  for (const row of rows) {
    await rm(row.file_path, { force: true });
    db().prepare(`DELETE FROM artifact_versions WHERE id=?`).run(row.id);
    freed += row.bytes;
  }
  log(`Pruned ${rows.length} superseded take(s), ${humanBytes(freed)} freed.`);
  return { removed: rows.length, bytes: freed };
}

/**
 * Backfills history for artifacts generated before versioning existed.
 *
 * Without this, the first re-roll of an existing project would show "v2" with no v1 to
 * compare against, and the take already on disk — the one the operator may prefer —
 * would still be lost the moment it was overwritten.
 */
export async function backfillVersions(projectId: string, log: (m: string) => void = () => {}) {
  // The interface polls this route every few seconds, so the common case - everything
  // already versioned - must cost one query rather than a stat() per artifact.
  const counts = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM artifacts
           WHERE project_id=? AND kind IN ('video','storyboard','character_card')) AS eligible,
         (SELECT COUNT(DISTINCT kind || '|' || COALESCE(scene_id,'')) FROM artifact_versions
           WHERE project_id=?) AS versioned`
    )
    .get(projectId, projectId) as { eligible: number; versioned: number };
  if (counts.versioned >= counts.eligible) return { added: 0 };

  const rows = db()
    .prepare(`SELECT kind, scene_id, file_path, prompt, attempt FROM artifacts WHERE project_id=?`)
    .all(projectId) as { kind: string; scene_id: string | null; file_path: string | null; prompt: string | null; attempt: number }[];

  let added = 0;
  for (const row of rows) {
    if (!["video", "storyboard", "character_card"].includes(row.kind)) continue;
    if (!row.file_path || !(await exists(row.file_path))) continue;
    if (listVersions(projectId, row.kind, row.scene_id).length > 0) continue;

    const { version, file } = await allocateVersion(projectId, row.kind, row.scene_id);
    await copyFile(row.file_path, file);
    await recordVersion({
      projectId, kind: row.kind, sceneId: row.scene_id, version, filePath: file,
      prompt: row.prompt, summary: "generated before version history existed",
    });
    db()
      .prepare(`UPDATE artifact_versions SET is_current=1 WHERE project_id=? AND kind=? AND scene_id IS ? AND version=?`)
      .run(projectId, row.kind, row.scene_id, version);
    added++;
  }
  if (added) log(`Backfilled ${added} existing take(s) into version history.`);
  return { added };
}
