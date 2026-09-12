import { rm, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { db } from "../db";
import { projectDir, humanBytes } from "../paths";
import { exists } from "../media/ffmpeg";
import { r2Config, putFile, objectSize, presignGet, objectKey } from "./r2";

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

export type Deliverable = { name: string; contentType: string; label: string };

/** The finished outputs every project has, in the order the interface lists them. */
export const DELIVERABLES: Deliverable[] = [
  { name: "FINAL.mp4", contentType: "video/mp4", label: "Final cut" },
  { name: "MASTER_clean.mp4", contentType: "video/mp4", label: "Clean master" },
  { name: "transcript.srt", contentType: "text/plain; charset=utf-8", label: "Transcript" },
  { name: "transcript.json", contentType: "application/json", label: "Transcript JSON" },
  { name: "captions.srt", contentType: "text/plain; charset=utf-8", label: "Burned captions" },
];

/**
 * Localized filenames are derived from the language name, not stored, so that every
 * consumer agrees on them without a lookup: `Spanish (Spain)` -> `FINAL_spanish_spain.mp4`.
 * Lossy on purpose — the slug only has to be a stable, filesystem-safe key.
 */
export const localeSlug = (language: string) =>
  language
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export const localizedVideoName = (language: string) => `FINAL_${localeSlug(language)}.mp4`;
export const localizedCaptionName = (language: string) => `captions_${localeSlug(language)}.srt`;

/**
 * HeyGen's translated cut, kept rather than discarded.
 *
 * The same idea as MASTER_clean.mp4 one level down: translated audio and lip-sync,
 * no burned text. Keeping it means re-burning a localized cut — new CTA wording, a
 * corrected legal disclaimer, a caption tweak — costs an ffmpeg pass instead of
 * another paid translation. It used to be written to a scratch directory and deleted
 * in a `finally`, so every edit meant paying HeyGen again for byte-identical output.
 */
export const localizedMasterName = (language: string) => `MASTER_${localeSlug(language)}.mp4`;

/**
 * Every deliverable this project actually has, static plus localized.
 *
 * The static list alone was the single biggest structural obstacle to localization:
 * it drives uploads, the interface's file list AND the share-link allowlist, so a
 * per-language file that was not in it would never reach object storage and could
 * never be shared — while still appearing to exist, because the download route
 * serves anything in the project directory by name.
 *
 * Derived from what is on disk or already offloaded rather than from the configured
 * language list, so that changing the app-wide languages later never orphans the
 * files a project has already produced.
 */
export function deliverablesFor(projectId: string): Deliverable[] {
  const present = new Set<string>(remoteNames(projectId));
  for (const name of localFileNames(projectId)) present.add(name);

  const localized = [...present]
    .filter((n) => /^(FINAL_|captions_|MASTER_)/.test(n) && n !== "MASTER_clean.mp4")
    .sort()
    .map((name) => {
      const slug = name.replace(/^(FINAL_|captions_|MASTER_)/, "").replace(/\.(mp4|srt)$/, "");
      const language = slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const kind = name.startsWith("FINAL_")
        ? "Final cut"
        : name.startsWith("MASTER_")
          ? "Translated master"
          : "Captions";
      return {
        name,
        contentType: name.endsWith(".mp4") ? "video/mp4" : "text/plain; charset=utf-8",
        label: `${kind} — ${language}`,
      };
    });

  return [...DELIVERABLES, ...localized];
}

/** Filenames directly inside the project directory; [] when it does not exist yet. */
function localFileNames(projectId: string): string[] {
  try {
    return readdirSync(projectDir(projectId), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

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
  for (const { name, contentType } of deliverablesFor(projectId)) {
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

    const remoteBytes = await objectSize(c, key);
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

/** Where each deliverable currently is, for the interface to show. */
export function deliverableLocations(projectId: string) {
  const remote = new Set(remoteNames(projectId));
  return deliverablesFor(projectId).map(({ name, label }) => ({
    name,
    label,
    remote: remote.has(name),
    bytes: remote.has(name) ? (remoteRow(projectId, name)?.bytes ?? 0) : null,
  }));
}
