import path from "node:path";
import { mkdir, stat, readdir, rm } from "node:fs/promises";

// All artifacts live under one visible, prunable directory tree — the same shape the
// POC wrote to disk. This is deliberate: the brief for this tool was "store all
// temporary files inside the folder so I see work in progress and have control of the
// folder size", which rules out opaque blob storage as the primary location.
//
// In the container this is a mounted volume; locally it defaults to ./data so a
// developer sees exactly what the deployed instance would hold.
export const DATA_ROOT = process.env.DATA_ROOT ?? path.join(process.cwd(), "data");

export const projectDir = (projectId: string) => path.join(DATA_ROOT, "projects", projectId);
export const dbPath = () => path.join(DATA_ROOT, "app.db");

export const artifact = {
  characterCard: (id: string) => path.join(projectDir(id), "00_character_card.jpg"),
  storyboard: (id: string, sceneId: string) =>
    path.join(projectDir(id), `scene_${safeSceneId(sceneId)}_storyboard.jpg`),
  video: (id: string, sceneId: string) =>
    path.join(projectDir(id), `scene_${safeSceneId(sceneId)}_video.mp4`),
  captions: (id: string) => path.join(projectDir(id), "captions.srt"),
  final: (id: string) => path.join(projectDir(id), "FINAL.mp4"),
  // Localization set: the same cut with no burned text, plus the timed script.
  cleanMaster: (id: string) => path.join(projectDir(id), "MASTER_clean.mp4"),
  transcriptJson: (id: string) => path.join(projectDir(id), "transcript.json"),
  transcriptSrt: (id: string) => path.join(projectDir(id), "transcript.srt"),
  work: (id: string) => path.join(projectDir(id), "_work"),
  diag: (id: string) => path.join(projectDir(id), "_diag"),
  transcripts: (id: string) => path.join(projectDir(id), "_transcripts"),
  versions: (id: string) => path.join(projectDir(id), "_versions"),
};

// Scene ids are user-facing strings like "5-3"; keep them filename-safe without
// collapsing distinct ids together.
export const safeSceneId = (sceneId: string) => sceneId.replace(/[^\w-]/g, "_");

export async function ensureProjectDirs(projectId: string) {
  for (const dir of [projectDir(projectId), artifact.work(projectId), artifact.diag(projectId), artifact.transcripts(projectId), artifact.versions(projectId)]) {
    await mkdir(dir, { recursive: true });
  }
}

export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // directory removed mid-walk, or never created
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += (await stat(p)).size;
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

// Intermediate files dwarf the deliverable (a 15-scene project holds ~1.5 GB of clips
// and sheets against an ~80 MB final cut), so the UI needs a way to reclaim space
// without destroying the thing the user actually wanted.
export async function pruneIntermediates(projectId: string) {
  // Note _versions is deliberately absent: generation history is not scratch.
  for (const dir of [artifact.work(projectId), artifact.diag(projectId), artifact.transcripts(projectId)]) {
    await rm(dir, { recursive: true, force: true });
  }
  await ensureProjectDirs(projectId);
}

export const humanBytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Path for one immutable generation attempt.
 *
 * Every take is written here and never touched again. The canonical path above
 * (`artifact.video`, `artifact.storyboard`, ...) holds a copy promoted from one of
 * these — see `lib/pipeline/versions.ts` for why that is a copy and not a link.
 */
export function versionPath(projectId: string, kind: string, sceneId: string | null, version: number): string {
  const ext = kind === "video" ? "mp4" : "jpg";
  const stem = sceneId ? `scene_${safeSceneId(sceneId)}_${kind}` : kind;
  return path.join(projectDir(projectId), "_versions", `${stem}_v${version}.${ext}`);
}

/** Canonical (current) path for a kind, matching what the rest of the pipeline reads. */
export function currentPath(projectId: string, kind: string, sceneId: string | null): string {
  if (kind === "video" && sceneId) return artifact.video(projectId, sceneId);
  if (kind === "storyboard" && sceneId) return artifact.storyboard(projectId, sceneId);
  if (kind === "character_card") return artifact.characterCard(projectId);
  throw new Error(`No canonical path for kind ${kind} (scene ${sceneId ?? "-"})`);
}
