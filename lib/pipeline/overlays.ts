import { generateStructured, TEXT_MODEL } from "../models/gemini";
import { getSetting, setSetting } from "../db";
import { missingGlyphs } from "../media/fonts";

/**
 * The burned-in text on a localized cut: the legal descriptor and the CTA.
 *
 * Stored rather than translated per render, and that is the important part. The
 * descriptor is a legal statement ("AI-generated. Fictional story. Results not
 * typical and may vary."), and burning an unreviewed machine translation of it into
 * an ad running in another country is the one part of this pipeline that can cause a
 * problem no re-render fixes. Translating once into an editable record means a human
 * can correct it, the correction is what actually gets burned, and every later
 * project inherits it.
 *
 * The cache is also why this is nearly free: one cheap text call per language, ever,
 * instead of one per localized render.
 */

export const OVERLAYS_KEY = "localize.overlays";

export type Overlay = {
  bold: string;
  body: string;
  cta: string;
  /** True until a human has edited it — surfaced in the UI as "not yet reviewed". */
  machine: boolean;
};

export type OverlayMap = Record<string, Overlay>;

export const getOverlays = (): OverlayMap => getSetting<OverlayMap>(OVERLAYS_KEY, {});
export const setOverlays = (m: OverlayMap) => setSetting(OVERLAYS_KEY, m);

const SCHEMA = {
  type: "object",
  properties: {
    bold: { type: "string" },
    body: { type: "string" },
    cta: { type: "string" },
  },
  required: ["bold", "body", "cta"],
} as const;

/**
 * Translates the overlay text for one language, or returns what is already stored.
 *
 * `force` re-translates and discards a stored version, for when the English source
 * text itself has changed.
 */
export async function overlayFor(opts: {
  language: string;
  bold: string;
  body: string;
  cta: string;
  force?: boolean;
  onLog?: (m: string) => void;
}): Promise<Overlay> {
  const map = getOverlays();
  const existing = map[opts.language];
  if (existing && !opts.force) return existing;

  const prompt = [
    `Translate the on-screen text of a video advertisement into ${opts.language}.`,
    "",
    "TEXT:",
    `  bold (legal disclosure heading): ${opts.bold}`,
    `  body (legal disclaimer): ${opts.body}`,
    `  cta  (call-to-action button): ${opts.cta}`,
    "",
    "Rules:",
    `- bold and body are a REGULATORY DISCLOSURE. Translate them faithfully and completely. Do not soften, shorten, omit or embellish them — a viewer in a ${opts.language}-speaking market must receive exactly the same disclosure an English viewer does.`,
    "- cta is advertising copy, not a literal translation. Give the short, idiomatic phrase this market's own ads use for that action, in the register a brand would use. Keep it to at most three words, and return it in the same letter case as the source.",
    "- Keep the sentence structure of body: it is burned onto two lines and a much longer translation will not fit.",
    "- Return only the translated strings.",
  ].join("\n");

  const out = await generateStructured<{ bold: string; body: string; cta: string }>({
    prompt,
    schema: SCHEMA as unknown as Record<string, unknown>,
    model: TEXT_MODEL,
    // Its own ledger label so overlay translation is visible as a line item rather
    // than hidden inside the generic "agent" bucket.
    label: "translate-overlay",
    onLog: opts.onLog,
  });

  const overlay: Overlay = {
    bold: out.bold.trim(),
    body: out.body.trim(),
    cta: out.cta.trim(),
    machine: true,
  };

  // Refuse to store something the renderer would draw as empty boxes. The language
  // picker already keeps unsupported scripts out, so reaching here means either a
  // stray character in an otherwise-supported language or a gap in that guard —
  // either way the caller must hear about it rather than burn it.
  const missing = missingGlyphs(`${overlay.bold}${overlay.body}${overlay.cta}`);
  if (missing.length) {
    throw new Error(
      `The ${opts.language} overlay text uses characters the bundled font cannot draw (${missing.slice(0, 8).join(" ")}) — ` +
        `it would render as empty boxes. Edit the text, or pick a language in a supported script.`
    );
  }

  // The descriptor is centred on a 1080px frame at a fixed size, so an over-long
  // translation runs off both edges — and ffmpeg crops it silently rather than
  // complaining. Rendering the five European languages at the real geometry showed
  // roughly 100px of clearance each side, so there is headroom, but not unlimited:
  // a character count relative to the English source is a crude proxy for width and
  // a generous threshold only catches a translation that has genuinely run away.
  const OVERFLOW_RATIO = 1.8;
  if (overlay.body.length > opts.body.length * OVERFLOW_RATIO) {
    opts.onLog?.(
      `  warning: the ${opts.language} disclaimer is ${overlay.body.length} characters against ` +
        `${opts.body.length} in English and may not fit on one line — check it in the localization section.`
    );
  }

  setOverlays({ ...getOverlays(), [opts.language]: overlay });
  opts.onLog?.(`  overlay text translated: "${overlay.cta}" / "${overlay.bold}"`);
  return overlay;
}
