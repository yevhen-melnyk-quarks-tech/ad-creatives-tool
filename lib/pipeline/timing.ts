import type { Character, Frame, Scene } from "./types";
import { charactersInFrame } from "./prompts";

/**
 * Pacing math from the team's scene-splitting SOP (the Jake/Growli pipeline, 21
 * scenes, ~4.5 min, zero regenerations — every scene rendered clean on the first
 * attempt). Superseded once already: the previous numbers here (2.7/3.0/3.5) were
 * validated against an earlier shipped ad, but that ad's own pace is exactly what a
 * later project's motion designer flagged as noticeably rushed. The SOP is explicit
 * about why: Seedance delivers dialogue faster than the word count suggests, so
 * every one of these numbers already has margin baked in, and undercutting that
 * margin is what forces a paid regeneration when a clip comes back too fast.
 */
export const RATES = {
  /** The target every automatic estimate packs toward. Doc: "aim for the Ideal
   *  column, not Max — that is what stops regenerations happening at all." */
  ideal: 2.0,
  /** Upper edge of "sounds natural, but no margin left" — above this, a scene's own
   *  (author-set) duration is tight enough that the model needs to be told not to
   *  pad or slow down, or it will fill the clip's length with dead air instead. */
  comfortable: 2.2,
  /** Where the doc's own tiering calls a pace "risky, should have been split" — used
   *  only in the warning for a single line that cannot be split any further. */
  max: 2.7,
};

export const countWords = (text: string): number => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;

/**
 * Whether a named speaker reads as a child, from their character description.
 *
 * The schema has no age or role field, so this is a heuristic over free text rather
 * than a lookup — the SOP's calibration examples and every child character seen in
 * this pipeline so far describe age and relationship directly ("Theo, 8, son"),
 * which is exactly what this matches against. A missed child is not silently wrong
 * in a way that produces a bad clip on its own — it just leaves that line paced like
 * an adult's, which is the pre-existing behaviour, not a regression.
 */
function isChildVoice(characterName: string, characters: Character[]): boolean {
  const character = characters.find((c) => c.name === characterName);
  if (!character) return false;
  const text = character.description.toLowerCase();
  if (/\b(child|kid|toddler|boy|girl|son|daughter)\b/.test(text)) return true;
  const age = /\b(\d{1,2})\s*(?:-|\s)?\s*(?:years?[\s-]?old|yo\b|y\.o\.)/.exec(text);
  return age ? Number(age[1]) < 13 : false;
}

/**
 * The dialogue rate for one speaker: the SOP's ideal pace, or 20% slower for a child
 * voice — "children speak slower in the animation," per the doc, which needs MORE
 * seconds for the same words rather than fewer.
 */
function rateFor(characterName: string | undefined, characters: Character[]): number {
  if (characterName && isChildVoice(characterName, characters)) return RATES.ideal * 0.8;
  return RATES.ideal;
}

/**
 * Estimates a scene's duration from its frames when the source brief gives no
 * timing at all (the brief-parsing path). Dialogue drives the estimate at the SOP's
 * ideal pace (a child speaker slower still); a silent/establishing frame gets a flat
 * beat rather than zero seconds, since a shot with nothing to say still needs to
 * read on screen — the SOP calls this out explicitly as its own 2-4s budget, an
 * action beat is not "free."
 *
 * `characters` is optional and defaults to none, which collapses every line to the
 * adult rate — the same behaviour this had before the child-voice modifier existed.
 */
export function estimateSceneDuration(frames: Frame[], characters: Character[] = []): number {
  const dialogueSeconds = frames.reduce(
    (sum, f) => sum + (f.dialogue ? countWords(f.dialogue.line) / rateFor(f.dialogue.character, characters) : 0),
    0
  );
  const silentFrames = frames.filter((f) => !f.dialogue).length;

  const silentSeconds = silentFrames * 3.0;
  const perFrameFloor = frames.length * 1.5; // no frame reads at under ~1.5s

  const seconds = Math.max(dialogueSeconds + silentSeconds, perFrameFloor);
  return Math.max(MIN_UNIT_SECONDS, Math.round(seconds));
}

/**
 * Hard ceiling on one generated clip. Not a stylistic choice: a request above this is
 * rejected by the API, so any scene longer than this MUST be split into separate
 * units before it reaches generation.
 */
export const MAX_UNIT_SECONDS = 15;

/**
 * Shortest clip the video model will accept. Not from the schema — see
 * SEEDANCE_MIN_DURATION in lib/models/replicate.ts for how this was found.
 */
export const MIN_UNIT_SECONDS = 4;

/** Forces a duration into the range the video model actually accepts. */
export const clampDuration = (seconds: number): number =>
  Math.min(MAX_UNIT_SECONDS, Math.max(MIN_UNIT_SECONDS, Math.round(seconds)));

const estimateFrameDuration = (frame: Frame, characters: Character[]): number =>
  frame.dialogue
    ? Math.max(1.5, countWords(frame.dialogue.line) / rateFor(frame.dialogue.character, characters))
    : 2.0;

/**
 * Splits one brief-level scene into generatable units of at most MAX_UNIT_SECONDS.
 *
 * This is the step the manual POC run did by hand — a long conversation scene became
 * `5-1` … `5-5`, each its own storyboard and its own clip — and the brief parser had
 * no equivalent, so it happily emitted 41s and 50s scenes that the video API would
 * have refused.
 *
 * Splits land on frame boundaries because a frame is one dialogue line and therefore
 * one shot; there is no coherent way to cut inside one. Packing is deterministic
 * rather than model-chosen: the constraint is hard and arithmetic, and frame
 * boundaries are already the natural beats a human would have cut on.
 */
export function splitSceneIntoUnits(scene: Scene): { units: Scene[]; warnings: string[] } {
  const warnings: string[] = [];

  if (!scene.frames.length) return { units: [scene], warnings };

  // An existing, legal duration is left strictly alone. It is a deliberate authoring
  // decision — the POC's scenes were hand-timed — and re-deriving it here would both
  // overwrite that intent and, when the estimate came out slightly higher, split a
  // perfectly good 15s scene into a 14s unit plus a 3s fragment.
  if (scene.durationSeconds >= MIN_UNIT_SECONDS && scene.durationSeconds <= MAX_UNIT_SECONDS) {
    return { units: [scene], warnings };
  }

  const sceneCast = scene.charactersInScene;

  // Aim for evenly-sized units rather than packing each to the brim, which leaves a
  // stub at the end. The ceiling is still absolute; the target only balances.
  const total = estimateSceneDuration(scene.frames, sceneCast);
  const unitCount = Math.max(1, Math.ceil(total / MAX_UNIT_SECONDS));
  const target = total / unitCount;

  const groups: Frame[][] = [];
  let current: Frame[] = [];

  for (const frame of scene.frames) {
    const wouldExceedCeiling =
      current.length > 0 && estimateSceneDuration([...current, frame], sceneCast) > MAX_UNIT_SECONDS;
    const pastTargetWithGroupsLeft =
      current.length > 0 &&
      estimateSceneDuration(current, sceneCast) >= target &&
      groups.length < unitCount - 1;

    if (wouldExceedCeiling || pastTargetWithGroupsLeft) {
      groups.push(current);
      current = [];
    }
    current.push(frame);

    // A single frame that alone exceeds the ceiling cannot be split further without
    // rewriting the dialogue. The SOP rule is explicit that dialogue is never
    // shortened automatically, so this is surfaced rather than silently trimmed.
    if (current.length === 1 && estimateFrameDuration(frame, sceneCast) > MAX_UNIT_SECONDS) {
      const words = frame.dialogue ? countWords(frame.dialogue.line) : 0;
      const rate = rateFor(frame.dialogue?.character, sceneCast);
      warnings.push(
        `Scene ${scene.id} "${frame.label}": one line is ${words} words, which needs ` +
          `${(words / rate).toFixed(1)}s but a clip caps at ${MAX_UNIT_SECONDS}s. It will be ` +
          `spoken at ${(words / MAX_UNIT_SECONDS).toFixed(1)} words/sec (above the ${RATES.max} limit) — ` +
          `split this line into two in the brief.`
      );
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);

  // Fold any group that would render shorter than the model's minimum into its
  // neighbour. Balanced packing still leaves a short tail sometimes, and a 3s tail is
  // both unrenderable and dramatically pointless — better one slightly longer unit.
  for (let i = groups.length - 1; i > 0; i--) {
    if (estimateSceneDuration(groups[i], sceneCast) >= MIN_UNIT_SECONDS) continue;
    const merged = [...groups[i - 1], ...groups[i]];
    if (estimateSceneDuration(merged, sceneCast) <= MAX_UNIT_SECONDS) {
      groups[i - 1] = merged;
      groups.splice(i, 1);
    }
  }

  if (groups.length === 1) {
    // Unsplit scenes keep their plain id, matching the manual convention where only
    // scenes that actually needed splitting gained a `-n` suffix.
    //
    // Still clamped: a scene of one un-splittable over-long line lands here, and
    // without the clamp it kept its 27s estimate and would have been refused by the
    // API despite the warning above.
    return {
      units: [{ ...scene, durationSeconds: clampDuration(estimateSceneDuration(scene.frames, sceneCast)) }],
      warnings,
    };
  }

  const units = groups.map((frames, i) => {
    // Narrow the cast to who is actually in this unit. This matters beyond tidiness:
    // the identity-lock prompt names absent characters explicitly ("X does NOT appear
    // — never use their face"), which was the fix for characters being swapped, and
    // that only works if the per-unit cast is accurate.
    const cast: Character[] = [];
    for (const frame of frames) {
      const inFrame = charactersInFrame(frame, scene.charactersInScene);
      const speaker = frame.dialogue
        ? scene.charactersInScene.find((c) => c.name === frame.dialogue!.character)
        : undefined;
      for (const c of [...inFrame, ...(speaker ? [speaker] : [])]) {
        if (!cast.some((x) => x.id === c.id)) cast.push(c);
      }
    }

    return {
      ...scene,
      id: `${scene.id}-${i + 1}`,
      title: `${scene.title} (${i + 1}/${groups.length})`,
      // The narrowed per-unit cast, not the whole scene's: it already includes
      // this unit's speaker (see above), which is all rateFor needs.
      durationSeconds: clampDuration(estimateSceneDuration(frames, cast)),
      // An empty cast would strip the identity lock entirely, so fall back to the
      // full scene cast rather than emitting a unit with nobody in it.
      charactersInScene: cast.length ? cast : scene.charactersInScene,
      frames,
    };
  });

  return { units, warnings };
}

/**
 * The SOP's pacing directive, emitted only when a scene's dialogue is dense enough to
 * need it.
 *
 * Ported from the manual pipeline, where one scene carried this by hand. Without it a
 * dense scene comes back with stretched words and inserted pauses as the model pads
 * the dialogue to fill the clip's duration.
 *
 * Skipped entirely when every dialogue frame in the scene is a child's line: telling
 * the model to deliver "brisk, fast and alive" would directly contradict the child
 * modifier in `rateFor`, which asks for slower delivery in the same breath. A scene
 * that mixes an adult and a child speaker still gets the override if the adult's
 * lines alone are dense enough — this only backs off for an all-child scene.
 */
export function pacingOverrideFor(frames: Frame[], durationSeconds: number, characters: Character[] = []): string | null {
  const dialogueFrames = frames.filter((f) => f.dialogue);
  if (dialogueFrames.length && dialogueFrames.every((f) => isChildVoice(f.dialogue!.character, characters))) {
    return null;
  }

  const words = frames.reduce((sum, f) => sum + (f.dialogue ? countWords(f.dialogue.line) : 0), 0);
  if (!words || durationSeconds <= 0) return null;
  const wordsPerSecond = words / durationSeconds;
  if (wordsPerSecond < RATES.comfortable) return null;

  return (
    "PACING PRIORITY — CRITICAL: dialogue runs continuously. Delivery is brisk, fast and alive — " +
    "do not stretch words, do not slow the speech down, do not insert pauses to fill time, no dead air " +
    "between lines. Cut on the last word of each line straight into the next shot."
  );
}
