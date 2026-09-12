import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchRetry, readJson } from "./http";

/**
 * HeyGen video translation — translated voiceover plus lip-sync, per language.
 *
 * Every shape below was verified against the live API on 2026-09-11 with a real
 * 4-second translation, because the published documentation is wrong in three
 * places that would each have failed at runtime:
 *
 *   - create returns `{data:{video_translation_ids:[...]}}` — a LIST, one id per
 *     requested language, each suffixed with the language code ("<id>-es"). The docs
 *     describe a single `translation_id`.
 *   - a finished job reports status `completed`. The docs say `success`.
 *   - the finished payload also carries `audio_url` (the translated audio on its
 *     own), which the docs do not mention at all.
 *
 * This tool sends ONE whole master per language rather than one call per clip. The
 * original reason given was cost, from a single 4-second probe that looked like a
 * per-call minute floor; a second, longer run showed billing is roughly prorated per
 * second instead, so per-clip would cost about the same. That argument was wrong.
 *
 * The reasons that do hold, and are the actual justification:
 *   - `enable_dynamic_duration` re-times each translated video to fit its speech
 *     (+12% on the probe). Applied per clip, each would stretch by a different
 *     amount and the concatenated cut would drift out of sync with its own
 *     storyboard; applied once to the whole master, the re-timing is coherent and
 *     HeyGen's returned captions describe it exactly.
 *   - voice consistency: one translation pass keeps one voice across the ad, where
 *     fourteen independent passes can drift between clips.
 *   - fourteen times fewer calls to poll, fail and pay for twice.
 */

const BASE = "https://api.heygen.com";

/**
 * Speed mode, matching the motion designer's manual HeyGen settings. `precision`
 * re-renders the mouth with avatar inference and costs roughly double; revisit only
 * if speed-mode lip-sync disappoints on real footage.
 */
export const TRANSLATE_MODE = process.env.HEYGEN_MODE ?? "speed";

/**
 * API credits per minute of translated video, and what an API credit costs.
 *
 * ESTIMATES, deliberately configurable, the same treatment as SEEDANCE_USD_PER_SEC_480
 * — and here the uncertainty is worse than usual, for a reason worth stating:
 *
 * HeyGen's API reports no price for a call and offers no usage-itemisation endpoint
 * (every plausible path 404s), so the only way to measure a call's cost is the
 * balance before and after. On a key SHARED with another product that is not a
 * measurement, it is a difference of two numbers that anything on the account can
 * move — and on this key it demonstrably does: 44 credits disappeared during a
 * window in which this tool made no calls at all. Both figures below should be
 * replaced from an invoice, or measured again on a key only this tool uses.
 *
 * Two confounded data points, for whoever revisits this: 4.1 seconds cost ~4 credits
 * and ~44.5 seconds cost ~36, i.e. roughly 0.8 credits/second with no per-call
 * minute floor. Their product below works out to ~$2/min, which is what HeyGen
 * publishes for API video translation.
 *
 * Note that "5 credits per minute" appears in HeyGen's own material and is NOT this
 * number: that is their WEB PLAN credit system, a different unit from API credits.
 * Setting HEYGEN_CREDITS_PER_MIN to 5 would under-report spend roughly tenfold.
 */
export const HEYGEN_CREDITS_PER_MIN = Number(process.env.HEYGEN_CREDITS_PER_MIN ?? 50);
export const HEYGEN_USD_PER_CREDIT = Number(process.env.HEYGEN_USD_PER_CREDIT ?? 0.04);
export const HEYGEN_RATE_IS_ESTIMATE =
  !process.env.HEYGEN_CREDITS_PER_MIN || !process.env.HEYGEN_USD_PER_CREDIT;

/**
 * What one language of a given length will cost, in USD.
 *
 * Rounded up to a whole minute. Billing looks prorated per second rather than floored
 * at a minute, so this deliberately over-estimates — a budget guard that guesses low
 * waves through the run it exists to stop, and the error is largest on short test
 * clips where the absolute amount is trivial anyway.
 */
export function estimateUsd(seconds: number): number {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes * HEYGEN_CREDITS_PER_MIN * HEYGEN_USD_PER_CREDIT;
}

function apiKey(): string {
  const k = process.env.HEYGEN_API_KEY;
  if (!k) throw new Error("HEYGEN_API_KEY is not set");
  return k;
}

const headers = () => ({ "x-api-key": apiKey() });

export const heygenConfigured = () => Boolean(process.env.HEYGEN_API_KEY);

/** The 190 target languages HeyGen accepts, by display name ("Spanish (Spain)"). */
export async function listLanguages(onLog?: (m: string) => void): Promise<string[]> {
  const res = await fetchRetry(
    `${BASE}/v3/video-translations/languages`,
    { headers: headers() },
    3,
    "heygen languages",
    onLog
  );
  const json = await readJson<{ data?: { languages?: string[] } }>(res, "HeyGen languages");
  return json.data?.languages ?? [];
}

/** Remaining API credits, for surfacing before a run rather than failing during one. */
export async function remainingCredits(onLog?: (m: string) => void): Promise<number | null> {
  try {
    // v2 is deprecated (HeyGen's own header says it is removed 2026-10-31) and has no
    // v3 equivalent published yet. Best-effort only: this is a courtesy reading for
    // the UI, never a gate, so a failure here must not break a localization run.
    const res = await fetchRetry(
      `${BASE}/v2/user/remaining_quota`,
      { headers: headers() },
      2,
      "heygen quota",
      onLog
    );
    const json = await readJson<{ data?: { details?: { api?: number } } }>(res, "HeyGen quota");
    return json.data?.details?.api ?? null;
  } catch {
    return null;
  }
}

export type TranslationResult = {
  id: string;
  status: string;
  videoUrl?: string;
  srtUrl?: string;
  audioUrl?: string;
  durationSeconds?: number;
};

const TERMINAL = ["completed", "failed", "success", "error"];
const SUCCESS = ["completed", "success"];

/**
 * Starts one translation per language and returns the ids, which are language-suffixed.
 *
 * `videoUrl` must be reachable by HeyGen from the public internet — their direct
 * upload path caps at 32 MB and our masters run to ~160 MB, so a presigned object
 * storage URL is the only viable input.
 */
export async function createTranslations(opts: {
  videoUrl: string;
  languages: string[];
  title: string;
  onLog?: (m: string) => void;
}): Promise<string[]> {
  const res = await fetchRetry(
    `${BASE}/v3/video-translations`,
    {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        video: { type: "url", url: opts.videoUrl },
        title: opts.title,
        output_languages: opts.languages,
        mode: TRANSLATE_MODE,
        // The only non-default flag. The translated SRT is the sole caption source
        // that matches the output: `enable_dynamic_duration` (on by default) re-times
        // the video to fit translated speech — a measured +12% on the probe clip — so
        // the project's own English timings would drift badly over a long ad.
        enable_caption: true,
        // speaker_num is deliberately NOT sent. Its documented default is "auto" and
        // HeyGen publishes no guidance for setting it by hand; auto handled a
        // two-character scene correctly in the probe.
      }),
    },
    3,
    "heygen create",
    opts.onLog
  );
  const json = await readJson<{ data?: { video_translation_ids?: string[] } }>(res, "HeyGen create");
  const ids = json.data?.video_translation_ids ?? [];
  if (ids.length === 0) throw new Error("HeyGen accepted the request but returned no translation ids");
  return ids;
}

export async function fetchTranslation(id: string, onLog?: (m: string) => void): Promise<TranslationResult> {
  const res = await fetchRetry(
    `${BASE}/v3/video-translations/${encodeURIComponent(id)}`,
    { headers: headers() },
    3,
    "heygen status",
    onLog
  );
  const json = await readJson<{
    data?: {
      id?: string;
      status?: string;
      video_url?: string;
      srt_caption_url?: string;
      audio_url?: string;
      duration?: number;
    };
  }>(res, "HeyGen status");
  const d = json.data ?? {};
  return {
    id: d.id ?? id,
    status: d.status ?? "unknown",
    videoUrl: d.video_url,
    srtUrl: d.srt_caption_url,
    audioUrl: d.audio_url,
    durationSeconds: d.duration,
  };
}

/**
 * Polls one translation to a terminal state.
 *
 * `onTick` fires on EVERY poll, not on an interval of them, and callers are expected
 * to use it to write job progress. That is not cosmetic: `recoverOrphanedJobs`
 * requeues any running job that has been silent for 90 seconds, and a translation
 * takes minutes — a silent poll loop would have its job yanked back to `queued` and
 * the whole translation paid for a second time.
 */
export async function awaitTranslation(opts: {
  id: string;
  onTick?: (status: string, elapsedSeconds: number) => void;
  onLog?: (m: string) => void;
  pollSeconds?: number;
  maxMinutes?: number;
}): Promise<TranslationResult> {
  const pollMs = (opts.pollSeconds ?? 20) * 1000;
  const deadline = Date.now() + (opts.maxMinutes ?? 90) * 60_000;
  const started = Date.now();

  for (;;) {
    const r = await fetchTranslation(opts.id, opts.onLog).catch((e) => {
      // A transient read failure must not abandon a translation that is already paid
      // for. Report it and keep waiting; only the deadline ends this loop.
      opts.onLog?.(`  could not read ${opts.id} (${(e as Error).message}) — still waiting`);
      return null;
    });
    const elapsed = (Date.now() - started) / 1000;
    opts.onTick?.(r?.status ?? "unreadable", elapsed);

    if (r && TERMINAL.includes(r.status)) {
      if (!SUCCESS.includes(r.status)) throw new Error(`HeyGen translation ${opts.id} ${r.status}`);
      return r;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `HeyGen translation ${opts.id} still ${r?.status ?? "unreadable"} after ${Math.round(elapsed / 60)} min — ` +
          `it is billed regardless and can be recovered by id`
      );
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/** Downloads a finished translation's artefact (video or captions) to disk. */
export async function download(url: string, outPath: string, label: string, onLog?: (m: string) => void) {
  const res = await fetchRetry(url, {}, 4, `download ${label}`, onLog);
  if (!res.ok) throw new Error(`Download of ${label} failed — HTTP ${res.status}`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}
