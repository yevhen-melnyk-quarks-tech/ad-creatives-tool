import { execFile } from "node:child_process";
import { probe } from "../media/ffmpeg";
import type { CriticReport, Finding } from "./types";
import { verdictFromFindings } from "./types";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

/**
 * The final-assembly critic is deterministic on purpose.
 *
 * Everything it checks — resolution, duration, where the caption sits, whether the
 * logo's bolt is centred in its tile — is a measurement, and a vision model asked to
 * eyeball geometry gives a soft answer to a question with a hard one. Two real
 * defects in the POC were found exactly this way and would have been argued about
 * otherwise: captions rendered 64% oversized, and a logo whose bolt sat 10.5% off
 * centre because the source PNG asset itself was wrong.
 */

/** Decodes one frame to a raw RGB buffer, so no image-decoding dependency is needed. */
function rawFrame(file: string, atSeconds: number, w: number, h: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ["-v", "error", "-ss", atSeconds.toFixed(3), "-i", file, "-frames:v", "1",
       "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "pipe:1"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer))
    );
  });
}

const at = (buf: Buffer, w: number, x: number, y: number) => {
  const i = (y * w + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]] as const;
};

type Box = { x0: number; y0: number; x1: number; y1: number } | null;

/**
 * Largest solid blob matching `test`, as a bounding box.
 *
 * A plain bounding box over every matching pixel is not good enough here: the CTA's
 * chevrons are the same brand yellow as the logo tile, so a naive bbox swallowed both
 * and reported a correctly-centred logo as 7.6% off. Connected components separate
 * them, and the fill-ratio floor then picks the solid tile over the thin chevrons.
 */
function largestBlob(
  buf: Buffer,
  w: number,
  h: number,
  test: (r: number, g: number, b: number) => boolean,
  minFillRatio = 0.6
): Box {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(buf, w, x, y);
      if (test(r, g, b)) mask[y * w + x] = 1;
    }
  }

  let best: Box = null;
  let bestArea = 0;
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    stack.push(start);
    mask[start] = 2;

    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      if (x > 0 && mask[idx - 1] === 1) { mask[idx - 1] = 2; stack.push(idx - 1); }
      if (x < w - 1 && mask[idx + 1] === 1) { mask[idx + 1] = 2; stack.push(idx + 1); }
      if (y > 0 && mask[idx - w] === 1) { mask[idx - w] = 2; stack.push(idx - w); }
      if (y < h - 1 && mask[idx + w] === 1) { mask[idx + w] = 2; stack.push(idx + w); }
    }

    const boxArea = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (area > bestArea && area / boxArea >= minFillRatio) {
      bestArea = area;
      best = { x0, y0, x1, y1 };
    }
  }
  return best;
}

function bboxOf(buf: Buffer, w: number, h: number, test: (r: number, g: number, b: number) => boolean, region?: Box): Box {
  const rx0 = region?.x0 ?? 0, ry0 = region?.y0 ?? 0;
  const rx1 = region?.x1 ?? w - 1, ry1 = region?.y1 ?? h - 1;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const [r, g, b] = at(buf, w, x, y);
      if (test(r, g, b)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export async function checkAssembly(opts: {
  finalPath: string;
  expectedDurationSeconds: number;
  ctaStartSeconds: number;
  expectedWidth?: number;
  expectedHeight?: number;
}): Promise<CriticReport> {
  const findings: Finding[] = [];
  const expW = opts.expectedWidth ?? 1080;
  const expH = opts.expectedHeight ?? 1920;

  const dims = (await probe(opts.finalPath, "stream=width,height")).split("\n").map(Number);
  const [w, h] = [dims[0], dims[1]];
  if (w !== expW || h !== expH) {
    findings.push({
      blocking: true,
      category: "resolution",
      detail: `Final video is ${w}x${h}, expected ${expW}x${expH}.`,
    });
  }

  const duration = parseFloat(await probe(opts.finalPath, "format=duration"));
  const drift = Math.abs(duration - opts.expectedDurationSeconds);
  if (drift > 1.5) {
    findings.push({
      blocking: true,
      category: "duration",
      detail: `Final runs ${duration.toFixed(2)}s but the scene list totals ${opts.expectedDurationSeconds.toFixed(2)}s (drift ${drift.toFixed(2)}s) — a clip is probably missing or duplicated.`,
    });
  }

  // Logo centring, sampled mid-CTA. The bolt must sit centred inside its tile; the
  // shipped brand PNG had it 10.5% right and 12.2% low, which reads as a broken graphic.
  try {
    const t = opts.ctaStartSeconds + 2.5;
    const buf = await rawFrame(opts.finalPath, t, w, h);
    const isTile = (r: number, g: number, b: number) => r > 195 && g > 150 && b < 130 && r - b > 90;
    const tile = largestBlob(buf, w, h, isTile);

    if (!tile) {
      findings.push({ blocking: true, category: "cta", detail: "No logo tile found in the CTA frame." });
    } else {
      const tw = tile.x1 - tile.x0;
      const th = tile.y1 - tile.y0;
      // Inset past the rounded corners, or dark background bleeds in through them and
      // corrupts the measurement (this bit me repeatedly by hand).
      const m = Math.round(0.12 * tw);
      const inner: Box = { x0: tile.x0 + m, y0: tile.y0 + m, x1: tile.x1 - m, y1: tile.y1 - m };
      const bolt = bboxOf(buf, w, h, (r, g, b) => Math.max(r, g, b) < 110, inner);

      if (!bolt) {
        findings.push({ blocking: true, category: "cta", detail: "Logo tile found but the bolt mark is missing." });
      } else {
        const offX = ((bolt.x0 + bolt.x1) / 2 - (tile.x0 + tile.x1) / 2) / tw;
        const offY = ((bolt.y0 + bolt.y1) / 2 - (tile.y0 + tile.y1) / 2) / th;
        if (Math.abs(offX) > 0.04 || Math.abs(offY) > 0.06) {
          findings.push({
            blocking: true,
            category: "cta-logo",
            detail:
              `Logo mark is off-centre in its tile: x ${(offX * 100).toFixed(1)}%, y ${(offY * 100).toFixed(1)}% ` +
              `(tolerance 4%/6%). Check that the logo asset is rendered from the brand SVG, not a stale PNG export.`,
          });
        }
      }
    }
  } catch (err) {
    findings.push({
      blocking: false,
      category: "cta",
      detail: `Could not measure the CTA logo: ${(err as Error).message}`,
    });
  }

  return {
    stage: "assembly",
    verdict: verdictFromFindings(findings),
    summary: findings.length
      ? `${findings.filter((f) => f.blocking).length} blocking, ${findings.filter((f) => !f.blocking).length} advisory`
      : `Final is ${w}x${h}, ${duration.toFixed(2)}s, logo centred.`,
    findings,
  };
}
