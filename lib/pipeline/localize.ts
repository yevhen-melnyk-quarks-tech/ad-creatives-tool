import { rm } from "node:fs/promises";
import path from "node:path";
import { artifact, projectDir, safeSceneId } from "../paths";
import { recordCost, projectSpendUsd, reserveSpend, releaseSpend, setProgress } from "../db";
import { burnAndFinish } from "../media/assemble";
import { durationOf, exists } from "../media/ffmpeg";
import { MAX_CHUNK_WORDS, MAX_CHUNK_SECONDS, srtTime } from "./captions";
import {
  createTranslations, awaitTranslation, download, estimateUsd, heygenConfigured,
} from "../models/heygen";
import { localizedVideoName, localizedCaptionName, offloadDeliverables } from "../storage/deliverables";
import { r2Config, presignGet, objectKey, putFile } from "../storage/r2";
import { remoteRow } from "../storage/deliverables";
import { uid } from "../db";

const PROJECT_BUDGET_USD = Number(process.env.PROJECT_BUDGET_USD ?? 40);

/** One subtitle cue. */
export type Cue = { start: number; end: number; text: string };

/**
 * Parses an SRT into cues.
 *
 * Tolerant of the two things HeyGen's captions actually do, both observed live: a
 * UTF-8 BOM on the first cue index (which makes a naive `Number()` parse return NaN
 * and silently drop the cue), and multi-line cue text.
 */
export function parseSrt(srt: string): Cue[] {
  const clean = srt.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const out: Cue[] = [];
  for (const block of clean.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(timeLine);
    if (!m) continue;
    const n = m.slice(1).map(Number);
    const start = n[0] * 3600 + n[1] * 60 + n[2] + n[3] / 1000;
    const end = n[4] * 3600 + n[5] * 60 + n[6] + n[7] / 1000;
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ start, end, text });
  }
  return out;
}

/**
 * Re-chunks translated cues into this tool's on-screen caption style.
 *
 * HeyGen returns sentence-length, multi-line cues ("Ahora trabajo\npor mi cuenta.").
 * The English cuts burn at most 3 words and 1.8 seconds per cue, and a localized cut
 * that looks different from the English one defeats the point of producing it here
 * rather than by hand.
 *
 * Word timings inside a cue are interpolated proportionally to word length, not split
 * evenly: even splitting visibly lags on cues mixing very short and very long words.
 * This is an approximation either way — the true per-word timings are not available
 * without re-transcribing the dubbed audio — but it is bounded by the cue's own
 * start and end, so error can never accumulate across the video.
 */
export function rechunkCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];

  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const span = Math.max(0.05, cue.end - cue.start);
    const totalChars = words.reduce((a, w) => a + w.length, 0) || words.length;
    let t = cue.start;
    const timed = words.map((w) => {
      const dur = (w.length / totalChars) * span;
      const word = { word: w, start: t, end: t + dur };
      t += dur;
      return word;
    });

    let cur: typeof timed = [];
    const flush = () => {
      if (!cur.length) return;
      out.push({
        start: cur[0].start,
        // Same floor the English chunker applies: a cue shorter than 0.4s flashes.
        end: Math.max(cur[cur.length - 1].end, cur[0].start + 0.4),
        text: cur.map((x) => x.word).join(" "),
      });
      cur = [];
    };
    for (const w of timed) {
      cur.push(w);
      const endsSentence = /[.?!]$/.test(w.word);
      const tooLong = cur.length >= MAX_CHUNK_WORDS;
      const tooSlow = cur[cur.length - 1].end - cur[0].start >= MAX_CHUNK_SECONDS;
      if (endsSentence || tooLong || tooSlow) flush();
    }
    flush();
  }

  return out;
}

export const cuesToSrt = (cues: Cue[]): string =>
  cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");

/**
 * A URL HeyGen can fetch the clean master from.
 *
 * Their direct upload path caps at 32 MB and a master runs to ~160 MB, so a reachable
 * URL is the only viable input. Prefers a presigned object-storage URL; falls back to
 * uploading the local file first when the master has not been offloaded yet.
 */
async function publicMasterUrl(projectId: string, log: (m: string) => void): Promise<string> {
  const c = r2Config();
  if (!c) {
    throw new Error(
      "Localization needs object storage: HeyGen fetches the master over the network, and R2 is not configured."
    );
  }

  const name = "MASTER_clean.mp4";
  const existing = remoteRow(projectId, name);
  if (existing) return presignGet(c, existing.object_key, 6 * 3600);

  const local = artifact.cleanMaster(projectId);
  if (!(await exists(local))) {
    throw new Error(
      "No MASTER_clean.mp4 for this project. It is skipped when the volume is low on space at assembly time — " +
        "free some space and assemble again to produce it, then localize."
    );
  }
  log("  uploading the clean master so HeyGen can fetch it...");
  const key = objectKey(projectId, name);
  await putFile(c, key, local, "video/mp4");
  // Six hours: long enough for a slow translation to start, short enough that an
  // unreleased creative is not readable indefinitely by anyone who saw the URL.
  return presignGet(c, key, 6 * 3600);
}

export type LocalizeOutcome = { language: string; ok: boolean; file?: string; error?: string };

/**
 * Translates a finished ad into each language and re-renders a full localized cut.
 *
 * Sequential, deliberately. Each language runs a full-length 1080x1920 encode, and
 * this container has 1 GB total — two at once is how the encoder gets SIGKILLed. It
 * also keeps peak disk to one language's intermediates rather than all of them.
 */
export async function runLocalize(opts: {
  projectId: string;
  languages: string[];
  log: (m: string) => void;
  jobId?: string;
  disclaimerBold?: string;
  disclaimerRegular?: string;
  ctaText?: string;
}): Promise<LocalizeOutcome[]> {
  const { projectId, languages, log } = opts;

  if (!heygenConfigured()) throw new Error("HEYGEN_API_KEY is not set — cannot localize.");
  if (languages.length === 0) throw new Error("No languages selected. Choose them in the localization section first.");

  const masterUrl = await publicMasterUrl(projectId, log);

  // Priced off the master's real duration when it is still on disk; otherwise off the
  // final cut, which is the same footage plus a 5-second outro. Either way the
  // estimate is rounded UP to a whole minute per language, because that is how HeyGen
  // actually bills — a 4-second probe clip was charged like a minute.
  const localMaster = artifact.cleanMaster(projectId);
  const seconds = (await exists(localMaster))
    ? await durationOf(localMaster)
    : (await exists(artifact.final(projectId)))
      ? await durationOf(artifact.final(projectId))
      : 0;
  const perLanguageUsd = estimateUsd(seconds);
  const totalUsd = perLanguageUsd * languages.length;

  const spent = projectSpendUsd(projectId);
  log(
    `Localizing into ${languages.length} language(s): ${languages.join(", ")}. ` +
      `Estimated $${totalUsd.toFixed(2)} ($${perLanguageUsd.toFixed(2)} each); $${spent.toFixed(2)} spent so far.`
  );
  if (spent + totalUsd > PROJECT_BUDGET_USD) {
    throw new Error(
      `Budget guard: $${spent.toFixed(2)} already spent and this run would add about $${totalUsd.toFixed(2)}, ` +
        `over the $${PROJECT_BUDGET_USD.toFixed(2)} project budget. Raise PROJECT_BUDGET_USD or localize fewer languages.`
    );
  }

  const results: LocalizeOutcome[] = [];

  for (const [i, language] of languages.entries()) {
    setProgress(opts.jobId ?? "", `Localizing: ${language}`, i, languages.length);
    log(`[${i + 1}/${languages.length}] ${language}`);

    // Reserved around the whole language so a concurrently running job sees this
    // spend in the budget guard rather than passing a stale check.
    reserveSpend(projectId, perLanguageUsd);
    try {
      const [id] = await createTranslations({
        videoUrl: masterUrl,
        languages: [language],
        title: `${projectId} — ${language}`,
        onLog: log,
      });
      log(`  translation ${id} started`);

      const done = await awaitTranslation({
        id,
        onLog: log,
        // Every poll writes progress. This is the load-bearing line of the whole
        // feature: recoverOrphanedJobs requeues a running job that has been silent
        // for 90 seconds, a translation takes minutes, and a requeued job would
        // start — and pay for — the translation all over again.
        onTick: (status, elapsed) => {
          setProgress(
            opts.jobId ?? "",
            `${language}: ${status} (${Math.round(elapsed)}s)`,
            i,
            languages.length
          );
        },
      });

      // Billed on completion rather than on submission: a translation that never
      // completes is reported by awaitTranslation's throw, which names the id.
      recordCost({
        projectId,
        provider: "heygen",
        operation: `translate-${safeSceneId(language)}`,
        usd: perLanguageUsd,
        detail: id,
      });

      if (!done.videoUrl) throw new Error(`HeyGen reported ${done.status} but returned no video URL`);

      const workDir = path.join(projectDir(projectId), "_work", `loc_${uid()}`);
      const translated = path.join(workDir, "translated.mp4");
      const srtPath = path.join(projectDir(projectId), localizedCaptionName(language));
      const outPath = path.join(projectDir(projectId), localizedVideoName(language));

      try {
        log("  downloading the translated cut...");
        await download(done.videoUrl, translated, "translated video", log);

        if (done.srtUrl) {
          const raw = path.join(workDir, "heygen.srt");
          await download(done.srtUrl, raw, "translated captions", log);
          const cues = rechunkCues(parseSrt(await readText(raw)));
          await writeText(srtPath, cuesToSrt(cues));
          log(`  captions: ${cues.length} cues re-chunked to house style`);
        } else {
          log("  no captions returned — the localized cut will carry the descriptor only");
          await rm(srtPath, { force: true });
        }

        await burnAndFinish({
          inputArgs: ["-i", translated],
          lastFrameSource: translated,
          storyDurationSeconds: done.durationSeconds ?? seconds,
          srtPath,
          outPath,
          workDir: path.join(workDir, "burn"),
          disclaimerBold: opts.disclaimerBold,
          disclaimerRegular: opts.disclaimerRegular,
          ctaText: opts.ctaText,
          onLog: log,
          onProgress: (f) =>
            setProgress(opts.jobId ?? "", `${language}: burning (${Math.round(f * 100)}%)`, i, languages.length),
        });
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }

      // Offloaded per language rather than once at the end, so peak disk is one
      // localized cut rather than all of them.
      await offloadDeliverables(projectId, log).catch((e) =>
        log(`  could not move ${language} to object storage (${(e as Error).message}) — it is still on the volume`)
      );

      results.push({ language, ok: true, file: localizedVideoName(language) });
      log(`  ${language} done`);
    } catch (e) {
      // One language failing must not abandon the rest: they are independent, and the
      // ones that succeeded are finished ads the designer can use today.
      const error = (e as Error).message;
      results.push({ language, ok: false, error });
      log(`  ${language} FAILED: ${error}`);
    } finally {
      releaseSpend(projectId, perLanguageUsd);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  log(`Localization finished: ${ok}/${languages.length} succeeded.`);
  return results;
}

// Small local helpers, kept here rather than in paths.ts: nothing else needs them.
async function readText(p: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(p, "utf-8");
}
async function writeText(p: string, s: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, s, "utf-8");
}
