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

export type SceneTranscript = {
  sceneId: string;
  durationSeconds: number;
  words: WhisperWord[];
  /**
   * Set when transcription could not be obtained for this scene.
   *
   * It has to be distinguishable from "transcribed and found nothing": a failed scene
   * must contribute its duration to the running offset but emit no cues, because
   * inventing evenly-spread timings for a line nobody timed produces captions that are
   * confidently wrong, and omitting the scene entirely shifts every cue after it.
   */
  failed?: boolean;
};

/**
 * One spoken line, timed against the assembled video.
 *
 * Line-level rather than the 3-word chunks captions use, because this is the
 * localization artifact: a translator works line by line, and a text-to-speech pass
 * needs the whole utterance with the window it has to fit inside.
 */
export type TranscriptLine = {
  sceneId: string;
  character: string;
  text: string;
  /** Absolute seconds in the assembled story, not relative to the scene. */
  start: number;
  end: number;
  words: { word: string; start: number; end: number }[];
};

export type CaptionResult = {
  srt: string;
  cueCount: number;
  /** Per-scene alignment coverage. A low ratio means the clip did not say the script. */
  coverage: { sceneId: string; matched: number; total: number; ratio: number }[];
  transcript: TranscriptLine[];
  /** First cue of each scene, relative to that scene's own start. */
  timing: { sceneId: string; firstCueRelative: number }[];
};

export function buildCaptions(scenes: Scene[], transcripts: SceneTranscript[]): CaptionResult {
  const byScene = new Map(transcripts.map((t) => [t.sceneId, t]));
  const cues: { start: number; end: number; text: string }[] = [];
  const coverage: CaptionResult["coverage"] = [];
  const transcript: TranscriptLine[] = [];
  const timing: CaptionResult["timing"] = [];
  let offset = 0;

  for (const scene of scenes) {
    const t = byScene.get(scene.id);
    if (!t) continue;

    const spoken = scene.frames.filter((f) => f.dialogue).map((f) => f.dialogue!);
    const scriptLines = spoken.map((d) => d.line);
    if (t.failed) {
      // Keep the timeline honest and leave this scene uncaptioned.
      offset += t.durationSeconds;
      continue;
    }
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
    const sceneCues = chunk(scriptWords, times);
    if (sceneCues.length) timing.push({ sceneId: scene.id, firstCueRelative: sceneCues[0].start });
    for (const c of sceneCues) {
      cues.push({ start: c.start + offset, end: c.end + offset, text: c.text });
    }

    // Walk the same word timings back into whole lines. The word list is the lines
    // joined, so each line owns a contiguous slice of it.
    let cursor = 0;
    for (const d of spoken) {
      const count = d.line.split(/\s+/).filter(Boolean).length;
      const slice = times.slice(cursor, cursor + count);
      const words = d.line
        .split(/\s+/)
        .filter(Boolean)
        .map((word, k) => ({
          word,
          start: (slice[k]?.start ?? 0) + offset,
          end: (slice[k]?.end ?? 0) + offset,
        }));
      cursor += count;
      if (!words.length) continue;
      transcript.push({
        sceneId: scene.id,
        character: d.character,
        text: d.line,
        start: words[0].start,
        end: Math.max(words[words.length - 1].end, words[0].start + 0.4),
        words,
      });
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
  transcript.sort((a, b) => a.start - b.start);
  return { srt, cueCount: cues.length, coverage, transcript, timing };
}

/**
 * The transcript as an SRT of whole lines, each prefixed with who says it.
 *
 * Separate from captions.srt on purpose: that one is chunked to 2-3 words to match the
 * reference ad's on-screen style, which is the wrong shape to hand a translator or a
 * voice model.
 */
export function transcriptSrt(lines: TranscriptLine[]): string {
  return lines
    .map(
      (l, i) =>
        `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.character}: ${l.text}\n`
    )
    .join("\n");
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

/**
 * Repairs the leading word timestamp of a transcription.
 *
 * `incredibly-fast-whisper` reports the FIRST word of an audio file at 0.00 regardless
 * of when speech actually starts. Because every clip is transcribed separately, that
 * hit every scene: 17 of this project's 20 scenes had their first caption cue pinned to
 * the very first frame while the line was not spoken for another 0.15-4.69 seconds, so
 * subtitles ran ahead of the voiceover for the whole ad.
 *
 * The tell is a gap the words themselves cannot explain - scene 1-1 read
 * `Dad,@0.00  are@1.10`, a 1.1 s pause inside "Dad, are we really going". So the
 * leading timestamp is discarded and re-derived backwards from the first word that is
 * trustworthy, using the speaking rate measured from the rest of the line, then floored
 * at the clip's real audio onset because nothing can be spoken before there is sound.
 *
 * On the same scene the two independent methods agree to 10 ms (interpolation 0.75 s,
 * measured onset 0.74 s), which is what makes this a correction rather than a guess.
 */
export function repairLeadingWordTiming(words: WhisperWord[], onsetSeconds: number | null): WhisperWord[] {
  if (words.length < 2) return words;

  const [first, second] = words;
  const gap = second.start - first.start;

  // Rate from the words after the first, which carry sound timestamps.
  const tail = words.slice(1);
  const span = tail[tail.length - 1].end - tail[0].start;
  const chars = tail.reduce((n, w) => n + w.word.length, 0);
  const secondsPerChar = span > 0 && chars > 0 ? span / chars : 0.06;
  const estimated = Math.max(0.12, first.word.length * secondsPerChar);

  // Only intervene when the reported gap is far larger than the word could occupy.
  // A correctly timed leading word sits snug against the next one and is left alone.
  if (gap <= estimated * 2) return words;

  const floor = onsetSeconds ?? 0;
  const start = Math.max(floor, second.start - estimated);
  return [{ ...first, start, end: Math.max(start + estimated * 0.8, Math.min(first.end, second.start)) }, ...tail];
}

/**
 * Scenes whose first cue precedes any sound in the clip.
 *
 * Advisory rather than blocking, by decision: it proves the cue is wrong (no speech can
 * precede the first audio sample) but not by how much a viewer would notice, and a hard
 * stop mid-assembly is worse than a visible warning. The reverse case - a cue later
 * than the first sound - is NOT reported, because ambience or music before the first
 * line makes that legitimate.
 */
export function timingFindings(
  checks: { sceneId: string; firstCueRelative: number; onsetSeconds: number | null }[],
  toleranceSeconds = 0.3
) {
  return checks.flatMap(({ sceneId, firstCueRelative, onsetSeconds }) => {
    if (onsetSeconds === null) return [];
    const lead = onsetSeconds - firstCueRelative;
    if (lead <= toleranceSeconds) return [];
    return [
      {
        blocking: false,
        category: "caption-timing",
        subject: `scene ${sceneId}`,
        detail:
          `Scene ${sceneId}: the first subtitle appears ${lead.toFixed(2)}s before any sound in the clip ` +
          `(cue at ${firstCueRelative.toFixed(2)}s, audio starts at ${onsetSeconds.toFixed(2)}s). ` +
          `Captions will read ahead of the voiceover. Re-run captions for this scene.`,
      },
    ];
  });
}
