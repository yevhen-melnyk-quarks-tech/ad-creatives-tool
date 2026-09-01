import type { Scene } from "./types";
import type { WhisperWord } from "../models/replicate";

/**
 * Captions are built by force-aligning the KNOWN script text against the transcript's
 * word timings — transcript supplies timing, the scenario supplies wording.
 *
 * Using the transcript's own text is not acceptable in a brand ad: it mis-heard the
 * product name, turned "fake documents" into "fake knowingments", dropped words, and
 * hallucinated speech ("Mm-hmm", a stray "I") over ambience in scenes with no dialogue
 * at all. Scenes with no scripted dialogue therefore emit no captions, which also
 * kills the hallucinations.
 */

// The reference ad keeps every caption to a single line of 2-3 words. Four words at
// this font size wrapped to two lines, which the reference never does.
const MAX_CHUNK_WORDS = 3;
const MAX_CHUNK_SECONDS = 1.8;

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Needleman-Wunsch word alignment, so one substitution, insertion or deletion in the
 * transcript doesn't shift every subsequent timing.
 */
function alignWords(scriptWords: string[], asrWords: WhisperWord[]): (WhisperWord | null)[] {
  const n = scriptWords.length;
  const m = asrWords.length;
  const D: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const P: string[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(""));

  for (let i = 1; i <= n; i++) { D[i][0] = i; P[i][0] = "del"; }
  for (let j = 1; j <= m; j++) { D[0][j] = j; P[0][j] = "ins"; }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const a = norm(scriptWords[i - 1]);
      const b = norm(asrWords[j - 1].word);
      // Partial credit for near-misses, which is how most transcript errors look.
      const similar = a === b || a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4));
      const sub = D[i - 1][j - 1] + (a === b ? 0 : similar ? 0.3 : 1);
      const del = D[i - 1][j] + 1;
      const ins = D[i][j - 1] + 1;
      const best = Math.min(sub, del, ins);
      D[i][j] = best;
      P[i][j] = best === sub ? "sub" : best === del ? "del" : "ins";
    }
  }

  const mapped: (WhisperWord | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const op = P[i][j];
    if (op === "sub") { mapped[i - 1] = asrWords[j - 1]; i--; j--; }
    else if (op === "del") i--;
    else j--;
  }
  return mapped;
}

/** Script words with no aligned transcript word get a timing interpolated between neighbours. */
function fillGaps(
  scriptWords: string[],
  mapped: (WhisperWord | null)[],
  fallbackStart: number,
  fallbackEnd: number
): { start: number; end: number }[] {
  const times: ({ start: number; end: number } | null)[] = mapped.map((w) =>
    w ? { start: w.start, end: w.end } : null
  );
  const firstIdx = times.findIndex(Boolean);

  if (firstIdx === -1) {
    const step = (fallbackEnd - fallbackStart) / scriptWords.length;
    return scriptWords.map((_, k) => ({ start: fallbackStart + k * step, end: fallbackStart + (k + 1) * step }));
  }

  for (let k = 0; k < times.length; k++) {
    if (times[k]) continue;
    const prev = times.slice(0, k).reduce<{ start: number; end: number } | null>((acc, t) => (t ? t : acc), null);
    const nextOffset = times.slice(k + 1).findIndex(Boolean);
    const next = nextOffset === -1 ? null : times[k + 1 + nextOffset];
    if (prev && next) {
      const span = next.start - prev.end;
      times[k] = { start: prev.end + span * 0.25, end: prev.end + span * 0.75 };
    } else if (prev) {
      times[k] = { start: prev.end + 0.05, end: prev.end + 0.3 };
    } else if (next) {
      times[k] = { start: Math.max(fallbackStart, next.start - 0.3), end: next.start - 0.05 };
    }
  }
  return times as { start: number; end: number }[];
}

function chunk(scriptWords: string[], times: { start: number; end: number }[]) {
  const out: { word: string; start: number; end: number }[][] = [];
  let cur: { word: string; start: number; end: number }[] = [];

  for (let k = 0; k < scriptWords.length; k++) {
    cur.push({ word: scriptWords[k], ...times[k] });
    const endsSentence = /[.?!]$/.test(scriptWords[k]);
    const tooLong = cur.length >= MAX_CHUNK_WORDS;
    const tooSlow = cur[cur.length - 1].end - cur[0].start >= MAX_CHUNK_SECONDS;
    if (endsSentence || tooLong || tooSlow) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);

  return out
    .filter((c) => c.length && Number.isFinite(c[0].start))
    .map((c) => ({
      start: c[0].start,
      end: Math.max(c[c.length - 1].end, c[0].start + 0.4),
      text: c.map((x) => x.word).join(" "),
    }));
}

const srtTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
};

export type SceneTranscript = { sceneId: string; durationSeconds: number; words: WhisperWord[] };

export type CaptionResult = {
  srt: string;
  cueCount: number;
  /** Per-scene alignment coverage. A low ratio means the clip did not say the script. */
  coverage: { sceneId: string; matched: number; total: number; ratio: number }[];
};

export function buildCaptions(scenes: Scene[], transcripts: SceneTranscript[]): CaptionResult {
  const byScene = new Map(transcripts.map((t) => [t.sceneId, t]));
  const cues: { start: number; end: number; text: string }[] = [];
  const coverage: CaptionResult["coverage"] = [];
  let offset = 0;

  for (const scene of scenes) {
    const t = byScene.get(scene.id);
    if (!t) continue;

    const scriptLines = scene.frames.filter((f) => f.dialogue).map((f) => f.dialogue!.line);
    if (scriptLines.length === 0) {
      // No scripted dialogue: emit nothing, so hallucinated ASR text cannot leak in.
      offset += t.durationSeconds;
      continue;
    }

    const scriptWords = scriptLines.join(" ").split(/\s+/).filter(Boolean);
    const mapped = t.words.length ? alignWords(scriptWords, t.words) : new Array(scriptWords.length).fill(null);
    const matched = mapped.filter(Boolean).length;
    coverage.push({
      sceneId: scene.id,
      matched,
      total: scriptWords.length,
      ratio: scriptWords.length ? matched / scriptWords.length : 0,
    });

    const times = fillGaps(scriptWords, mapped, 0.6, Math.max(1.2, t.durationSeconds - 0.3));
    for (const c of chunk(scriptWords, times)) {
      cues.push({ start: c.start + offset, end: c.end + offset, text: c.text });
    }
    offset += t.durationSeconds;
  }

  // Never let one cue overlap the next.
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) {
      cues[i].end = Math.max(cues[i].start + 0.3, cues[i + 1].start - 0.02);
    }
  }

  const srt = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
  return { srt, cueCount: cues.length, coverage };
}

/**
 * Low alignment coverage means the clip's audio did not actually say the scripted
 * line — a wrong-dialogue defect a purely visual critic cannot see.
 */
export function coverageFindings(coverage: CaptionResult["coverage"]) {
  return coverage
    .filter((c) => c.ratio < 0.8)
    .map((c) => ({
      blocking: c.ratio < 0.5,
      category: "dialogue-mismatch",
      subject: `scene ${c.sceneId}`,
      detail:
        `Only ${c.matched}/${c.total} scripted words (${Math.round(c.ratio * 100)}%) were found in the clip's audio. ` +
        (c.ratio < 0.5
          ? "The clip is probably not saying the scripted line."
          : "Captions may drift; check the audio against the script."),
    }));
}
