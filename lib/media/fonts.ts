import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * What the bundled fonts can actually draw.
 *
 * This exists because ffmpeg fails silently here. `drawtext` and `subtitles` do not
 * error on a character the font has no glyph for — they render an empty box, so a
 * Japanese localization produced a finished, correct-looking video whose captions
 * were rows of tofu, after HeyGen had already been paid for the translation.
 * Verified by rendering six scripts through the real pipeline: Latin, Cyrillic and
 * Greek came out clean; Japanese, Chinese and Arabic came out as boxes.
 *
 * Two guards, at different distances from the problem. `renderableLanguage` keeps
 * unsupported markets out of the picker so the situation does not arise; `missingGlyphs`
 * checks the actual bytes about to be burned, which is the one that cannot be fooled.
 */

const ASSETS = path.join(process.cwd(), "assets", "fonts");

/** Scripts the bundled Roboto covers. Everything else needs a font we do not ship. */
const SUPPORTED_SCRIPTS = new Set(["Latn", "Cyrl", "Grek"]);

let glyphCache: Set<number> | null = null;

/**
 * Every code point the font has a glyph for, read from its `cmap` table.
 *
 * Parsed here rather than shelled out to fontconfig: `fc-query` is not installed in
 * the container image, and a missing tool would turn this guard into a silent no-op —
 * exactly the failure mode it exists to prevent.
 */
function glyphs(): Set<number> {
  if (glyphCache) return glyphCache;
  const out = new Set<number>();
  try {
    const d = readFileSync(path.join(ASSETS, "Roboto-Bold.ttf"));
    const numTables = d.readUInt16BE(4);
    let cmapOff = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + 16 * i;
      if (d.toString("latin1", rec, rec + 4) === "cmap") cmapOff = d.readUInt32BE(rec + 8);
    }
    if (!cmapOff) throw new Error("no cmap table");

    const n = d.readUInt16BE(cmapOff + 2);
    let best = 0;
    for (let i = 0; i < n; i++) {
      const p = cmapOff + 4 + 8 * i;
      const pid = d.readUInt16BE(p);
      const eid = d.readUInt16BE(p + 2);
      // Unicode subtables only, preferring the full-range (3,10) over BMP-only (3,1).
      if ((pid === 3 && (eid === 1 || eid === 10)) || (pid === 0 && (eid === 3 || eid === 4))) {
        best = cmapOff + d.readUInt32BE(p + 4);
      }
    }
    if (!best) throw new Error("no unicode cmap subtable");

    const format = d.readUInt16BE(best);
    if (format === 4) {
      const segX2 = d.readUInt16BE(best + 6);
      const seg = segX2 / 2;
      for (let i = 0; i < seg; i++) {
        const end = d.readUInt16BE(best + 14 + 2 * i);
        const start = d.readUInt16BE(best + 16 + segX2 + 2 * i);
        if (start === 0xffff) continue;
        for (let c = start; c <= Math.min(end, 0xffff); c++) out.add(c);
      }
    } else if (format === 12) {
      const groups = d.readUInt32BE(best + 12);
      for (let i = 0; i < groups; i++) {
        const g = best + 16 + 12 * i;
        const start = d.readUInt32BE(g);
        const end = d.readUInt32BE(g + 4);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  } catch {
    /* Fall through to an empty set; see the guard in missingGlyphs. */
  }
  glyphCache = out;
  return out;
}

/**
 * Characters in `text` the font cannot draw, deduplicated.
 *
 * Returns empty when the font could not be read at all, rather than declaring every
 * character missing: a parsing failure here must not block a render that would have
 * been perfectly fine. The picker-level guard still applies in that case.
 */
export function missingGlyphs(text: string): string[] {
  const g = glyphs();
  if (g.size === 0) return [];
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Whitespace and control characters are laid out, never drawn from the cmap.
    if (cp <= 0x20) continue;
    if (!g.has(cp)) missing.add(ch);
  }
  return [...missing];
}

let nameToCode: Map<string, string> | null = null;

/**
 * The ISO script code for a HeyGen language name ("Spanish (Spain)" -> "Latn").
 *
 * Uses ICU's own data via Intl rather than a hand-written table: HeyGen offers 190
 * languages and a list maintained by hand would be wrong the first time one was
 * added. Returns null for a name ICU does not recognise, which callers treat as
 * unsupported — refusing an unknown beats burning boxes into a paid render.
 */
export function scriptOf(language: string): string | null {
  if (!nameToCode) {
    nameToCode = new Map();
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    for (let a = 97; a <= 122; a++) {
      for (let b = 97; b <= 122; b++) {
        const code = String.fromCharCode(a) + String.fromCharCode(b);
        try {
          const name = display.of(code);
          if (name && name !== code) nameToCode.set(name.toLowerCase(), code);
        } catch {
          /* not a language code */
        }
      }
    }
  }
  // HeyGen names are "Language" or "Language (Region)"; the region never changes script
  // for the ones we support, and ICU resolves the base language's default script.
  const base = language.split("(")[0].trim().toLowerCase();
  const code = nameToCode.get(base);
  if (!code) return null;
  try {
    return new Intl.Locale(code).maximize().script ?? null;
  } catch {
    return null;
  }
}

/** Whether a localized cut in this language can be rendered with the bundled fonts. */
export function renderableLanguage(language: string): boolean {
  const s = scriptOf(language);
  return s !== null && SUPPORTED_SCRIPTS.has(s);
}

export const SUPPORTED_SCRIPT_NAMES = "Latin, Cyrillic and Greek";
