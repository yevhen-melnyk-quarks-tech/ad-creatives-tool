import { execFile } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export const exists = (p: string) => access(p).then(() => true).catch(() => false);

export function run(args: string[], label: string, timeoutMs = 900_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(FFMPEG, args, { maxBuffer: 40 * 1024 * 1024, timeout: timeoutMs });
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : // Keep the tail of stderr AND strip ffmpeg's build banner, which otherwise
          // fills the whole excerpt and hides the actual error.
          reject(
            new Error(
              `${label} failed (exit ${code}): ${err
                .split("\n")
                .filter((l) => !/^\s*(configuration:|lib|built with)/.test(l))
                .join("\n")
                .slice(-700)}`
            )
          )
    );
    proc.on("error", reject);
  });
}

export const probe = (file: string, entries: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(FFPROBE, ["-v", "error", "-show_entries", entries, "-of", "default=nw=1:nk=1", file], (e, out) =>
      e ? reject(e) : resolve(out.trim())
    )
  );

export const durationOf = async (file: string) => parseFloat(await probe(file, "format=duration"));

/**
 * Frames sampled through a clip at NATIVE resolution, for the video-stage critic.
 *
 * Replaces a 400px-wide 2x2 contact sheet. That downscale (from a 720px source) was
 * actively causing false failures: at 400px a hand's curled fingers and a dark-clothed
 * crossed leg are genuinely ambiguous, and the model resolved the ambiguity by
 * asserting a defect — reporting "six digits" and "legs fused into a malformed mass"
 * on a clip that is fine at full size. Sampling more frames also lets a finding be
 * checked for persistence, which is what distinguishes a real defect from a
 * single-frame artifact nobody perceives at 24fps.
 */
export async function extractFrames(clipPath: string, outDir: string, count = 6): Promise<string[]> {
  const duration = await durationOf(clipPath);
  await mkdir(outDir, { recursive: true });

  // Evenly spaced, avoiding the exact ends which are often a fade or a
  // motion-blurred first frame.
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const frac = 0.1 + (0.8 * i) / Math.max(1, count - 1);
    const out = path.join(outDir, `f${i + 1}.png`);
    await run(
      ["-y", "-ss", (duration * frac).toFixed(2), "-i", clipPath, "-frames:v", "1", "-update", "1", out],
      `frame ${i + 1}`
    );
    paths.push(out);
  }
  return paths;
}

/**
 * 4-up contact sheet of frames sampled through a clip. Retained for diagnostics and
 * for anything that wants a single browsable image; the critic uses extractFrames.
 */
export async function buildContactSheet(clipPath: string, outPath: string): Promise<string> {
  const duration = await durationOf(clipPath);
  const tmpDir = path.join(path.dirname(outPath), `.tiles_${path.basename(outPath, ".jpg")}`);
  await mkdir(tmpDir, { recursive: true });

  const tiles: string[] = [];
  for (const [i, frac] of [0.12, 0.37, 0.62, 0.87].entries()) {
    const tile = path.join(tmpDir, `${i}.png`);
    await run(
      ["-y", "-ss", (duration * frac).toFixed(2), "-i", clipPath, "-frames:v", "1", "-vf", "scale=400:-1", "-update", "1", tile],
      `contact tile ${i}`
    );
    tiles.push(tile);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await run(
    [
      "-y",
      ...tiles.flatMap((t) => ["-i", t]),
      "-filter_complex",
      "[0][1]hstack=2[a];[2][3]hstack=2[b];[a][b]vstack=2[o]",
      "-map",
      "[o]",
      "-q:v",
      "2",
      outPath,
    ],
    "contact sheet"
  );
  return outPath;
}

/** Extracts a clip's audio as a standalone file for transcription. */
export async function extractAudio(clipPath: string, outPath: string) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await run(["-y", "-i", clipPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outPath], "extract audio");
}
