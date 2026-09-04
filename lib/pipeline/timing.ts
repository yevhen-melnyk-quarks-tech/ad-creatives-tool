import type { Frame } from "./types";

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
