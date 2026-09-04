import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "../db";
import { projectDir, humanBytes } from "../paths";
import { exists } from "../media/ffmpeg";
import { r2Config, putFile, headObject, deleteObject, presignGet, objectKey } from "./r2";

/**
 * Moving finished deliverables off the container volume.
 *
 * The volume is a working area, not a library: a project's finished files are ~285 MB
 * and never change again, so keeping them there means the volume grows with every ad
 * while the space that actually matters — room to render the next one — shrinks.
 * Object storage holds them instead, and the file route redirects to a signed URL, so
 * nothing in the interface has to know where a given file currently lives.
 *
 * Sources are deliberately NOT offloaded. Clips and storyboards are inputs to
 * re-rolls and to the next assembly, ffmpeg reads them from disk, and round-tripping
 * them through the network on every render would buy nothing.
 */

/** The finished outputs, in the order the interface lists them. */
export const DELIVERABLES: { name: string; contentType: string; label: string }[] = [
  { name: "FINAL.mp4", contentType: "video/mp4", label: "Final cut" },
  { name: "MASTER_clean.mp4", contentType: "video/mp4", label: "Clean master" },
  { name: "transcript.srt", contentType: "text/plain; charset=utf-8", label: "Transcript" },
  { name: "transcript.json", contentType: "application/json", label: "Transcript JSON" },
  { name: "captions.srt", contentType: "text/plain; charset=utf-8", label: "Burned captions" },
];

export type RemoteRow = { project_id: string; name: string; object_key: string; bytes: number; content_type: string };

export const remoteRow = (projectId: string, name: string): RemoteRow | undefined =>
  db().prepare(`SELECT * FROM remote_objects WHERE project_id=? AND name=?`).get(projectId, name) as
    | RemoteRow
    | undefined;

export const remoteNames = (projectId: string): string[] =>
  (db().prepare(`SELECT name FROM remote_objects WHERE project_id=?`).all(projectId) as { name: string }[]).map(
    (r) => r.name
  );

export const storageIsConfigured = () => r2Config() !== null;

/**
 * A time-limited URL for one offloaded deliverable, or null if it is not offloaded.
 *
 * `download` switches the URL to one that makes the browser save the file rather than
 * play it, which is signed into the URL rather than set as a response header — the
 * redirect target is R2, so this process never sees the response.
 */
export function remoteUrl(projectId: string, name: string, opts: { download?: boolean; ttlSeconds?: number } = {}) {
  const c = r2Config();
  const row = remoteRow(projectId, name);
  if (!c || !row) return null;
  return presignGet(c, row.object_key, opts.ttlSeconds ?? 3600, opts.download ? name : undefined);
}

/**
 * Uploads every deliverable that is still local, then deletes the local copy.
 *
 * The order matters and is the whole safety argument: upload, read the size back from
 * storage, record the row, and only then delete. A failed upload therefore leaves the
 * file exactly where it was, and a crash between any two steps leaves a file that is
 * still readable — never a row pointing at an object that does not exist.
 */
export async function offloadDeliverables(projectId: string, log: (m: string) => void = () => {}) {
  const c = r2Config();
  if (!c) {
    log("  object storage is not configured — deliverables stay on the volume");
    return { moved: 0, bytes: 0 };
  }

  let moved = 0;
  let bytes = 0;
  for (const { name, contentType } of DELIVERABLES) {
    const local = path.join(projectDir(projectId), name);
    if (!(await exists(local))) continue;
    if (remoteRow(projectId, name)) {
      // Already offloaded and somehow written again — the local copy is the newer one,
      // so replace the object rather than trusting the stale row.
      log(`  ${name} already offloaded; replacing the stored copy`);
    }

    const key = objectKey(projectId, name);
    const localBytes = (await stat(local)).size;
    log(`  uploading ${name} (${humanBytes(localBytes)})...`);
    await putFile(c, key, local, contentType);

    const remoteBytes = await headObject(c, key);
    if (remoteBytes !== localBytes) {
      // Do not record, do not delete. Leaving the local file intact is the point.
      throw new Error(
        `${name} uploaded as ${remoteBytes ?? 0} bytes but is ${localBytes} locally — keeping the local copy`
      );
    }

    db()
      .prepare(
        `INSERT INTO remote_objects (project_id, name, object_key, bytes, content_type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, name) DO UPDATE SET
           object_key=excluded.object_key, bytes=excluded.bytes,
           content_type=excluded.content_type, uploaded_at=datetime('now')`
      )
      .run(projectId, name, key, localBytes, contentType);

    await rm(local, { force: true });
    moved++;
    bytes += localBytes;
  }

  if (moved) log(`  moved ${moved} file(s), ${humanBytes(bytes)} freed from the volume`);
  else log("  nothing to move");
  return { moved, bytes };
}

/**
 * Removes a project's stored objects. Used when its deliverables are about to be
 * rebuilt, so a stale row can never outlive the file it describes.
 */
export async function dropRemoteDeliverables(projectId: string) {
  const c = r2Config();
  const rows = db().prepare(`SELECT * FROM remote_objects WHERE project_id=?`).all(projectId) as RemoteRow[];
  for (const row of rows) {
    if (c) await deleteObject(c, row.object_key).catch(() => {});
  }
  db().prepare(`DELETE FROM remote_objects WHERE project_id=?`).run(projectId);
}

/** Where each deliverable currently is, for the interface to show. */
export function deliverableLocations(projectId: string) {
  const remote = new Set(remoteNames(projectId));
  return DELIVERABLES.map(({ name, label }) => ({
    name,
    label,
    remote: remote.has(name),
    bytes: remote.has(name) ? (remoteRow(projectId, name)?.bytes ?? 0) : null,
  }));
}
