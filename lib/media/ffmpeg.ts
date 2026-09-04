import { spawn, execFile } from "node:child_process";
import { mkdir, access, statfs } from "node:fs/promises";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

/**
 * Thread cap for every ffmpeg invocation.
 *
 * ffmpeg sizes its thread pool from the host's core count, which inside a container
 * is the *machine's* count, not the cgroup's allowance. On the deployed box that meant
 * x264 spinning up dozens of threads, each holding its own 1080x1920 frame buffers and
 * lookahead, and the container's memory ceiling arrived within seconds — the process
 * died by signal three seconds into a three-minute encode, which surfaced as the
 * uninformative "exit null".
 *
 * Two threads is deliberately conservative: a full-length encode is minutes either
 * way, and finishing slowly beats being killed. Raise FFMPEG_THREADS if the container
 * gets more headroom.
 */
const THREADS = process.env.FFMPEG_THREADS ?? "2";

export const exists = (p: string) => access(p).then(() => true).catch(() => false);

/** Free bytes on the filesystem holding `dir` (walking up to the nearest existing parent). */
export async function freeBytes(dir: string): Promise<number> {
  let probeDir = path.resolve(dir);
  for (;;) {
    try {
      const s = await statfs(probeDir);
      return s.bsize * s.bavail;
    } catch {
      const parent = path.dirname(probeDir);
      if (parent === probeDir) return Number.POSITIVE_INFINITY; // cannot tell; do not block
      probeDir = parent;
    }
  }
}

export type RunOptions = {
  timeoutMs?: number;
  /** Output duration in seconds. Supplying it turns on fractional progress reporting. */
  totalSeconds?: number;
  onProgress?: (fraction: number) => void;
};

/**
 * Runs ffmpeg, resolving on exit 0 and rejecting with a diagnosable message otherwise.
 *
 * Uses spawn rather than execFile because execFile buffers all output and kills the
 * child once maxBuffer is exceeded — a failure mode indistinguishable from the real
 * ones. Only the stderr tail is retained here, so output volume cannot kill a job.
 */
export function run(args: string[], label: string, options: RunOptions | number = {}): Promise<void> {
  const { timeoutMs = 900_000, totalSeconds, onProgress } =
    typeof options === "number" ? { timeoutMs: options } : options;

  // Global options, so they have to precede the first input.
  const full = ["-hide_banner", "-nostdin", "-threads", THREADS, "-filter_threads", THREADS, "-filter_complex_threads", THREADS];
  if (onProgress && totalSeconds) full.push("-progress", "pipe:1", "-nostats");
  full.push(...args);

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, full, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 64_000) err = err.slice(-32_000); // keep the tail, bound the memory
    });

    // `-progress` writes key=value lines; out_time_us is the timestamp already written.
    if (onProgress && totalSeconds) {
      let buf = "";
      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line);
          if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSeconds));
        }
      });
    } else {
      proc.stdout.resume();
    }

    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();

      const tail = err
        .split("\n")
        .filter((l) => !/^\s*(configuration:|lib|built with)/.test(l))
        .join("\n")
        .slice(-700);

      // A signal death says nothing about what went wrong unless it is named. These
      // three are the ones that actually happen, and each has a different fix.
      let why: string;
      if (timedOut) why = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      else if (signal === "SIGKILL")
        why = "killed by the OS (signal SIGKILL) — almost always the container running out of memory";
      else if (signal) why = `killed by signal ${signal}`;
      else if (/no space left on device/i.test(err)) why = "out of disk space";
      else why = `exit ${code}`;

      reject(new Error(`${label} failed (${why}): ${tail}`));
    });
  });
}

export const probe = (file: string, entries: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(FFPROBE, ["-v", "error", "-show_entries", entries, "-of", "default=nw=1:nk=1", file], (e, out) =>
      e ? reject(e) : resolve(out.trim())
    )
  );

export const durationOf = async (file: string) => parseFloat(await probe(file, "format=duration"));

/** Video track geometry and length, in one ffprobe call. */
export async function videoInfo(file: string): Promise<{ width: number; height: number; seconds: number }> {
  const out = await new Promise<string>((resolve, reject) =>
    execFile(
      FFPROBE,
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        file,
      ],
      (e, o) => (e ? reject(e) : resolve(o.trim()))
    )
  );
  const [w, h, d] = out.split("\n").map((v) => parseFloat(v));
  return { width: w, height: h, seconds: d };
}

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
