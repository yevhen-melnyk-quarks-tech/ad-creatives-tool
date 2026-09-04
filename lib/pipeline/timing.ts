import type { Character, Frame, Scene } from "./types";
import { charactersInFrame } from "./prompts";

// Pacing math from the team's own SOP, validated against a real shipped ad (10
// scenes, avg 2.77 words/sec) — not an arbitrary formula.
export const RATES = {
  comfortable: 2.7, // best-sounding working range
  working: 3.0,     // upper edge of the working range, used as the default target
  max: 3.5,         // maximum before words start blurring together
};

export const countWords = (text: string): number => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;

/**
 * Estimates a scene's duration from its frames when the source brief gives no
 * timing at all (the brief-parsing path). Dialogue drives the estimate at the
 * SOP's "working" pace; a silent/establishing frame gets a flat beat rather than
 * zero seconds, since a shot with nothing to say still needs to read on screen.
 */
export function estimateSceneDuration(frames: Frame[]): number {
  const dialogueWords = frames.reduce(
    (sum, f) => sum + (f.dialogue ? countWords(f.dialogue.line) : 0),
    0
  );
  const silentFrames = frames.filter((f) => !f.dialogue).length;

  const dialogueSeconds = dialogueWords / RATES.working;
  const silentSeconds = silentFrames * 2.0;
  const perFrameFloor = frames.length * 1.5; // no frame reads at under ~1.5s

  const seconds = Math.max(dialogueSeconds + silentSeconds, perFrameFloor);
  return Math.max(3, Math.round(seconds));
}

/**
 * Hard ceiling on one generated clip, from the video model's own schema
 * (`duration` is `integer, minimum -1, maximum 15`). Not a stylistic choice: a
 * request above this is rejected by the API, so any scene longer than this MUST be
 * split into separate units before it reaches generation.
 */
export const MAX_UNIT_SECONDS = 15;

const estimateFrameDuration = (frame: Frame): number =>
  frame.dialogue ? Math.max(1.5, countWords(frame.dialogue.line) / RATES.working) : 2.0;

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
  if (scene.durationSeconds >= 1 && scene.durationSeconds <= MAX_UNIT_SECONDS) {
    return { units: [scene], warnings };
  }

  // Aim for evenly-sized units rather than packing each to the brim, which leaves a
  // stub at the end. The ceiling is still absolute; the target only balances.
  const total = estimateSceneDuration(scene.frames);
  const unitCount = Math.max(1, Math.ceil(total / MAX_UNIT_SECONDS));
  const target = total / unitCount;

  const groups: Frame[][] = [];
  let current: Frame[] = [];

  for (const frame of scene.frames) {
    const wouldExceedCeiling =
      current.length > 0 && estimateSceneDuration([...current, frame]) > MAX_UNIT_SECONDS;
    const pastTargetWithGroupsLeft =
      current.length > 0 &&
      estimateSceneDuration(current) >= target &&
      groups.length < unitCount - 1;

    if (wouldExceedCeiling || pastTargetWithGroupsLeft) {
      groups.push(current);
      current = [];
    }
    current.push(frame);

    // A single frame that alone exceeds the ceiling cannot be split further without
    // rewriting the dialogue. The SOP rule is explicit that dialogue is never
    // shortened automatically, so this is surfaced rather than silently trimmed.
    if (current.length === 1 && estimateFrameDuration(frame) > MAX_UNIT_SECONDS) {
      const words = frame.dialogue ? countWords(frame.dialogue.line) : 0;
      warnings.push(
        `Scene ${scene.id} "${frame.label}": one line is ${words} words, which needs ` +
          `${(words / RATES.working).toFixed(1)}s but a clip caps at ${MAX_UNIT_SECONDS}s. It will be ` +
          `spoken at ${(words / MAX_UNIT_SECONDS).toFixed(1)} words/sec (above the ${RATES.max} limit) — ` +
          `split this line into two in the brief.`
      );
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);

  if (groups.length === 1) {
    // Unsplit scenes keep their plain id, matching the manual convention where only
    // scenes that actually needed splitting gained a `-n` suffix.
    //
    // Still clamped: a scene of one un-splittable over-long line lands here, and
    // without the clamp it kept its 27s estimate and would have been refused by the
    // API despite the warning above.
    return {
      units: [{ ...scene, durationSeconds: Math.min(MAX_UNIT_SECONDS, estimateSceneDuration(scene.frames)) }],
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
      durationSeconds: Math.min(MAX_UNIT_SECONDS, estimateSceneDuration(frames)),
      // An empty cast would strip the identity lock entirely, so fall back to the
      // full scene cast rather than emitting a unit with nobody in it.
      charactersInScene: cast.length ? cast : scene.charactersInScene,
      frames,
    };
  });

  return { units, warnings };
}
