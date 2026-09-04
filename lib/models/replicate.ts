import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchRetry, readJson } from "./http";

const BASE = "https://api.replicate.com/v1";

export const VIDEO_MODEL = process.env.SEEDANCE_MODEL ?? "bytedance/seedance-2.0-mini";
export const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? "openai/whisper";

// Seedance 2.0 Mini, 720p. Used for the spend ledger and the auto-repair budget guard.
export const SEEDANCE_USD_PER_SEC = Number(process.env.SEEDANCE_USD_PER_SEC ?? 0.073);

// Confirmed from the live model schema, not guessed:
//   - reference_images (up to 9) CANNOT be combined with `image` (first frame), so the
//     storyboard goes in as a reference rather than a first frame.
//   - prompt hard limit 4000 chars.
//   - aspect_ratio defaults to 16:9, so vertical ads must set it explicitly.
export const SEEDANCE_PROMPT_LIMIT = 4000;

/**
 * Real duration bounds, learned from the API rather than its schema.
 *
 * The published schema says `minimum: -1, maximum: 15` — the -1 is a sentinel for
 * "let the model choose". The actual accepted range is 4-15, which only surfaced as a
 * runtime rejection: "Duration must be between 4 and 15 seconds, or -1 for
 * intelligent duration." A 3-second scene is therefore impossible to render, and
 * trusting the schema's minimum meant a short scene failed every single attempt.
 */
export const SEEDANCE_MIN_DURATION = 4;
export const SEEDANCE_MAX_DURATION = 15;

function apiKey(): string {
  const k = process.env.REPLICATE_API_TOKEN;
  if (!k) throw new Error("REPLICATE_API_TOKEN is not set");
  return k;
}

/**
 * Uploads via the Files API rather than inlining base64. Inlining reference images
 * produced payloads large enough to break JSON parsing on the provider side.
 */
async function uploadFile(filePath: string, onLog?: (m: string) => void): Promise<string> {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("content", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), path.basename(filePath));

  const res = await fetchRetry(
    `${BASE}/files`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey()}` }, body: form },
    4,
    `upload ${path.basename(filePath)}`,
    onLog
  );
  const json = await readJson<{ urls?: { get?: string; download?: string }; download_url?: string }>(
    res,
    `Upload of ${path.basename(filePath)}`
  );
  const url = json.urls?.get ?? json.urls?.download ?? json.download_url;
  if (!url) throw new Error(`No servable URL for ${path.basename(filePath)}`);
  return url;
}

type Prediction = {
  id: string;
  status: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
  metrics?: Record<string, unknown>;
};

async function runPrediction(opts: {
  model: string;
  input: Record<string, unknown>;
  onLog?: (m: string) => void;
  pollSeconds?: number;
  maxPolls?: number;
}): Promise<Prediction> {
  const createRes = await fetchRetry(
    `${BASE}/models/${opts.model}/predictions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: opts.input }),
    },
    4,
    "create prediction",
    opts.onLog
  );
  const created = await readJson<Prediction>(createRes, "Prediction create");

  const getUrl = created.urls?.get ?? `${BASE}/predictions/${created.id}`;
  let final = created;
  const maxPolls = opts.maxPolls ?? 120;
  const pollMs = (opts.pollSeconds ?? 10) * 1000;

  for (let i = 1; i <= maxPolls && !["succeeded", "failed", "canceled"].includes(final.status); i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pollRes = await fetchRetry(
      getUrl,
      { headers: { Authorization: `Bearer ${apiKey()}` } },
      4,
      "poll",
      opts.onLog
    );
    final = await readJson<Prediction>(pollRes, "Prediction poll");
    if (i % 3 === 0) opts.onLog?.(`  [${i}] status=${final.status}`);
  }

  if (final.status !== "succeeded") {
    throw new Error(
      `Prediction ${final.status}: ${JSON.stringify(final.error ?? final).slice(0, 400)}`
    );
  }
  return final;
}

/** Generates one scene's clip. Returns the prediction id so a crashed run can recover it. */
export async function generateVideo(opts: {
  prompt: string;
  referencePaths: string[];
  durationSeconds: number;
  outPath: string;
  onLog?: (m: string) => void;
}): Promise<{ predictionId: string; usd: number }> {
  if (opts.prompt.length > SEEDANCE_PROMPT_LIMIT) {
    throw new Error(
      `Prompt exceeds Seedance's ${SEEDANCE_PROMPT_LIMIT}-char limit by ${opts.prompt.length - SEEDANCE_PROMPT_LIMIT}`
    );
  }
  // The model's schema caps duration at 15s. Checked here as well as at scenario
  // ingest so an over-long scene can never reach a paid call and fail there — the
  // error names the fix rather than surfacing a raw provider validation message.
  if (opts.durationSeconds < SEEDANCE_MIN_DURATION || opts.durationSeconds > SEEDANCE_MAX_DURATION) {
    throw new Error(
      `Scene duration ${opts.durationSeconds}s is outside the model's ` +
        `${SEEDANCE_MIN_DURATION}-${SEEDANCE_MAX_DURATION}s range.`
    );
  }

  const reference_images: string[] = [];
  for (const p of opts.referencePaths) reference_images.push(await uploadFile(p, opts.onLog));

  const final = await runPrediction({
    model: VIDEO_MODEL,
    input: {
      prompt: opts.prompt,
      reference_images,
      duration: opts.durationSeconds,
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: true,
    },
    onLog: opts.onLog,
  });

  const outputUrl = Array.isArray(final.output) ? (final.output[0] as string) : (final.output as string);
  const videoRes = await fetchRetry(outputUrl, {}, 4, "download video", opts.onLog);
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, Buffer.from(await videoRes.arrayBuffer()));

  return { predictionId: final.id, usd: opts.durationSeconds * SEEDANCE_USD_PER_SEC };
}

/**
 * Recovers an already-billed prediction instead of paying again. A transient network
 * drop during polling used to lose a completed generation; this reads it back.
 */
export async function recoverVideo(predictionId: string, outPath: string): Promise<boolean> {
  const res = await fetchRetry(
    `${BASE}/predictions/${predictionId}`,
    { headers: { Authorization: `Bearer ${apiKey()}` } },
    4,
    "recover prediction"
  );
  const p = await readJson<Prediction>(res, "Prediction recover");
  if (p.status !== "succeeded") return false;
  const url = Array.isArray(p.output) ? (p.output[0] as string) : (p.output as string);
  if (!url) return false;
  const videoRes = await fetchRetry(url, {}, 4, "download recovered video");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(await videoRes.arrayBuffer()));
  return true;
}

export type WhisperWord = { word: string; start: number; end: number };

/**
 * Transcription runs on Replicate rather than a local Whisper install. Bundling
 * torch + Whisper into the image would add multiple GB and make CPU transcription of
 * fifteen clips painfully slow for no accuracy gain — and the transcript is only used
 * for caption *timing*, since the wording comes from the script.
 */
export async function transcribe(opts: {
  audioUrl: string;
  onLog?: (m: string) => void;
}): Promise<WhisperWord[]> {
  const final = await runPrediction({
    model: WHISPER_MODEL,
    input: { audio: opts.audioUrl, word_timestamps: true, model: "small" },
    onLog: opts.onLog,
    pollSeconds: 5,
    maxPolls: 90,
  });

  const out = final.output as { segments?: { words?: WhisperWord[] }[] } | undefined;
  return (out?.segments ?? []).flatMap((s) => s.words ?? []);
}

export async function uploadForTranscription(filePath: string, onLog?: (m: string) => void) {
  return uploadFile(filePath, onLog);
}
