/**
 * Cost estimation for the Gemini calls — image generation and every agent call
 * (critics, the repair planner, the brief parser).
 *
 * These were previously untracked, so a project's spend figure only ever showed
 * Seedance and Whisper and read far lower than the truth.
 *
 * Design: usage is MEASURED (token counts come back from the API, images are
 * counted), rates are CONFIGURABLE. Published per-token prices move and vary by
 * model, so hard-coding them would quietly go stale and present a wrong number as
 * fact. Set the env vars below to your account's actual rates; until then these are
 * clearly-labelled estimates and the UI says so.
 */

export type Usage = {
  promptTokens: number;
  outputTokens: number;
  images: number;
};

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const RATES = {
  /** USD per generated image (Nano Banana / gemini image models). */
  imageUsd: num(process.env.GEMINI_IMAGE_USD, 0.04),
  /** USD per 1M input tokens for text/vision agent calls. */
  inputUsdPerMillion: num(process.env.GEMINI_INPUT_USD_PER_M, 2.0),
  /** USD per 1M output tokens for text/vision agent calls. */
  outputUsdPerMillion: num(process.env.GEMINI_OUTPUT_USD_PER_M, 12.0),
};

/** True when every rate is still at its built-in default, i.e. nothing was configured. */
export const RATES_ARE_DEFAULTS =
  !process.env.GEMINI_IMAGE_USD &&
  !process.env.GEMINI_INPUT_USD_PER_M &&
  !process.env.GEMINI_OUTPUT_USD_PER_M;

export function estimateGeminiUsd(usage: Usage): number {
  return (
    usage.images * RATES.imageUsd +
    (usage.promptTokens / 1_000_000) * RATES.inputUsdPerMillion +
    (usage.outputTokens / 1_000_000) * RATES.outputUsdPerMillion
  );
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, outputTokens: 0, images: 0 });

export const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  images: a.images + b.images,
});
