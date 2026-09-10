import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchRetry, readJson } from "./http";

const BASE = "https://api.replicate.com/v1";

export const VIDEO_MODEL = process.env.SEEDANCE_MODEL ?? "bytedance/seedance-2.0-mini";
/**
 * Transcription model, pinned by version.
 *
 * Two reasons it is not `openai/whisper`. That model is community-owned, so
 * `POST /models/{owner}/{name}/predictions` returns 404 — only models with an
 * official default version answer there, and a version-pinned `POST /predictions`
 * is required instead. More importantly its input schema has no word-timestamp
 * option at all, and the caption aligner needs word-level timings; this one takes
 * `timestamp: "word"`.
 */
export const WHISPER_VERSION =
  process.env.WHISPER_VERSION ??
  "3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c";

export type VideoResolution = "480p" | "720p";
/** From the live model schema: resolution is an enum of exactly these two. */
export const VIDEO_RESOLUTIONS: VideoResolution[] = ["480p", "720p"];

/**
 * Per-second cost by resolution, for the spend ledger and the budget guard.
 *
 * The 720p figure is the measured one carried over from the proof of concept. The
 * 480p figure is an ESTIMATE — Replicate does not expose per-resolution pricing
 * through its API, so this is configurable rather than asserted. Set
 * SEEDANCE_USD_PER_SEC_480 once you can read the real rate off an invoice.
 */
export const SEEDANCE_USD_PER_SEC_BY_RES: Record<VideoResolution, number> = {
  "720p": Number(process.env.SEEDANCE_USD_PER_SEC ?? 0.073),
  "480p": Number(process.env.SEEDANCE_USD_PER_SEC_480 ?? 0.033),
};
export const SEEDANCE_480_RATE_IS_ESTIMATE = !process.env.SEEDANCE_USD_PER_SEC_480;

/** Kept for callers that do not care about resolution; 720p is the pessimistic rate. */
export const SEEDANCE_USD_PER_SEC = SEEDANCE_USD_PER_SEC_BY_RES["720p"];

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

const TERMINAL = ["succeeded", "failed", "canceled"];

/**
 * A prediction that was created and billed but never observed reaching a terminal
 * state before we stopped waiting.
 *
 * Distinct from a prediction that genuinely failed, and the distinction is worth a
 * whole error class: the compute is paid for either way, and if it later succeeds the
 * output is still sitting on Replicate waiting to be downloaded for free. Losing the
 * id — which is what happened before this existed, since the id lived only inside
 * `runPrediction`'s closure — makes that unrecoverable and invisible in the ledger.
 */
export class PredictionTimeoutError extends Error {
  /**
   * Read by `repairLoop`, which otherwise retries a thrown generate(). Retrying this
   * one means creating a second paid prediction while the first may still be about to
   * succeed — the exact double-charge this class exists to prevent. Kept as a plain
   * property rather than an `instanceof` check there so the retry policy does not
   * have to import a provider module.
   */
  readonly retryable = false;

  constructor(
    readonly predictionId: string,
    readonly lastStatus: string,
    readonly waitedSeconds: number
  ) {
    super(
      `Prediction ${predictionId} still ${lastStatus} after ${Math.round(waitedSeconds)}s — ` +
        `it is billed regardless and may still finish; recoverable by id.`
    );
    this.name = "PredictionTimeoutError";
  }
}

/** One authoritative read of a prediction's current state. */
export async function fetchPrediction(id: string, onLog?: (m: string) => void): Promise<Prediction> {
  const res = await fetchRetry(
    `${BASE}/predictions/${id}`,
    { headers: { Authorization: `Bearer ${apiKey()}` } },
    4,
    "read prediction",
    onLog
  );
  return readJson<Prediction>(res, "Prediction read");
}

async function runPrediction(opts: {
  /** Owner/name, for models that expose a default version. */
  model?: string;
  /** Explicit version hash, for community models that do not. */
  version?: string;
  input: Record<string, unknown>;
  onLog?: (m: string) => void;
  pollSeconds?: number;
  maxPolls?: number;
}): Promise<Prediction> {
  if (!opts.model && !opts.version) throw new Error("runPrediction needs a model or a version");

  const createRes = await fetchRetry(
    opts.version ? `${BASE}/predictions` : `${BASE}/models/${opts.model}/predictions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(opts.version ? { version: opts.version, input: opts.input } : { input: opts.input }),
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

  let polls = 0;
  for (let i = 1; i <= maxPolls && !TERMINAL.includes(final.status); i++) {
    polls = i;
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

  // Ran out of polls without ever seeing a terminal state. Before giving up, spend a
  // grace period asking again — the compute is billed either way, so waiting is
  // strictly cheaper than abandoning it. Only when that also runs out is this a
  // timeout, reported as one and carrying the id, rather than as
  // `Prediction processing: {...}` — a message that reads like the provider failed
  // when in fact we stopped listening to a job we had already paid for.
  if (!TERMINAL.includes(final.status)) {
    const waited = (polls * pollMs) / 1000;
    opts.onLog?.(
      `  prediction ${created.id} still ${final.status} after ${Math.round(waited)}s — it is already billed, waiting rather than abandoning it`
    );
    const reclaimed = await awaitPrediction(created.id, opts.onLog);
    if (!reclaimed) throw new PredictionTimeoutError(created.id, final.status, waited);
    opts.onLog?.(`  reclaimed prediction ${created.id}`);
    final = reclaimed;
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
  resolution?: VideoResolution;
  onLog?: (m: string) => void;
}): Promise<{ predictionId: string; usd: number; resolution: VideoResolution }> {
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

  const resolution: VideoResolution = opts.resolution ?? "480p";

  /**
   * One documented incident: Seedance failed a prediction with "Error processing
   * image /tmp/tmp6hdcf9i3download for aspect ratio validation: unknown file
   * extension" — a temp path with NO extension at all. Traced this as far as it can
   * be traced from here: our own upload carries the right one end to end (verified
   * live against Replicate's Files API — the served URL keeps the `.jpg` we name the
   * multipart part with), so whatever stripped it happened after Replicate received
   * a well-formed request, somewhere in Bytedance's own file handling. Not something
   * this code can fix at the source — but it looks environmental rather than caused
   * by anything in the request, so it is worth one retry with fresh uploads before
   * giving up.
   *
   * Distinct from the QA repair loop this pairs with: that one is gone for video by
   * design (auto-regeneration on a critic's aesthetic verdict is the expensive
   * failure mode). This is a transport-level retry for a prediction that never
   * produced a video to critique at all, the same category as the HTTP-level
   * retries `fetchRetry` already does for a dropped connection - just one layer
   * deeper, because here the request succeeded and the provider's own processing
   * failed.
   */
  const TRANSIENT_FAILURE = /aspect ratio validation|unknown file extension/i;
  const MAX_GENERATION_ATTEMPTS = 3;

  let final: Prediction | undefined;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const reference_images: string[] = [];
    for (const p of opts.referencePaths) reference_images.push(await uploadFile(p, opts.onLog));

    try {
      final = await runPrediction({
        model: VIDEO_MODEL,
        input: {
          prompt: opts.prompt,
          reference_images,
          duration: opts.durationSeconds,
          resolution,
          aspect_ratio: "9:16",
          generate_audio: true,
        },
        onLog: opts.onLog,
      });
      break;
    } catch (err) {
      // A timeout is never retried here. runPrediction already spent its grace period
      // trying to reclaim it, and the prediction is billed: generating again would pay
      // a second time for a clip that may yet appear. Surface the id instead.
      if (err instanceof PredictionTimeoutError) throw err;
      const message = (err as Error).message;
      if (attempt === MAX_GENERATION_ATTEMPTS || !TRANSIENT_FAILURE.test(message)) throw err;
      opts.onLog?.(
        `  looks like a transient provider-side failure (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}), retrying with a fresh upload: ${message.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!final) throw new Error("generateVideo: exhausted retries without a result"); // unreachable — every exit above either returns, breaks with `final` set, or throws

  await downloadOutput(final, opts.outPath, opts.onLog);

  return {
    predictionId: final.id,
    usd: opts.durationSeconds * SEEDANCE_USD_PER_SEC_BY_RES[resolution],
    resolution,
  };
}

async function downloadOutput(p: Prediction, outPath: string, onLog?: (m: string) => void) {
  const url = Array.isArray(p.output) ? (p.output[0] as string) : (p.output as string);
  if (!url) throw new Error(`Prediction ${p.id} succeeded but carried no output URL`);
  const res = await fetchRetry(url, {}, 4, "download video", onLog);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

/**
 * Grace period for a prediction we stopped polling: keep asking until it reaches a
 * terminal state. Returns the succeeded prediction, or null if it failed or is still
 * running when the grace runs out.
 *
 * Deliberately generous — waiting is free and the alternative is either paying twice
 * or throwing away a finished clip.
 */
async function awaitPrediction(
  id: string,
  onLog?: (m: string) => void,
  graceSeconds = Number(process.env.PREDICTION_GRACE_SECONDS ?? 600)
): Promise<Prediction | null> {
  const deadline = Date.now() + graceSeconds * 1000;
  onLog?.(`  waiting up to ${graceSeconds}s to reclaim it rather than paying for another render`);
  for (let i = 1; Date.now() < deadline; i++) {
    const p = await fetchPrediction(id, onLog).catch(() => null);
    if (p && TERMINAL.includes(p.status)) {
      if (p.status === "succeeded") return p;
      onLog?.(`  prediction ${id} ended as ${p.status}`);
      return null;
    }
    if (i % 3 === 0) onLog?.(`  reclaim [${i}] status=${p?.status ?? "unreadable"}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
  onLog?.(`  gave up reclaiming ${id}; it can still be recovered later by id`);
  return null;
}

/**
 * Recovers an already-billed prediction instead of paying again. A transient network
 * drop during polling used to lose a completed generation; this reads it back.
 */
export async function recoverVideo(predictionId: string, outPath: string): Promise<boolean> {
  const p = await fetchPrediction(predictionId);
  if (p.status !== "succeeded") return false;
  await downloadOutput(p, outPath);
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
    version: WHISPER_VERSION,
    input: { audio: opts.audioUrl, timestamp: "word", batch_size: 24 },
    onLog: opts.onLog,
    pollSeconds: 5,
    // 25 minutes. Whisper is cheap but cold-starts unpredictably, and this budget was
    // 7.5 minutes - short enough that one cold start aborted a whole captions run and
    // discarded the transcriptions already paid for. Waiting costs nothing here.
    maxPolls: 300,
  });

  // This model returns `chunks: [{ timestamp: [start, end], text }]`. A trailing
  // chunk can carry a null end when the audio ends mid-word, so that is filled from
  // the start rather than becoming NaN and poisoning every downstream timing.
  const out = final.output as
    | { chunks?: { timestamp?: (number | null)[]; text?: string }[]; text?: string }
    | undefined;

  return (out?.chunks ?? []).flatMap((c) => {
    const word = (c.text ?? "").trim();
    const start = c.timestamp?.[0];
    if (!word || typeof start !== "number") return [];
    const end = typeof c.timestamp?.[1] === "number" ? c.timestamp[1] : start + 0.25;
    return [{ word, start, end }];
  });
}

export async function uploadForTranscription(filePath: string, onLog?: (m: string) => void) {
  return uploadFile(filePath, onLog);
}
