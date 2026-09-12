import { NextResponse } from "next/server";
import { getSetting, setSetting, LOCALIZE_LANGUAGES_KEY } from "@/lib/db";
import { listLanguages, heygenConfigured, remainingCredits } from "@/lib/models/heygen";
import { getOverlays, setOverlays } from "@/lib/pipeline/overlays";
import { renderableLanguage, missingGlyphs, SUPPORTED_SCRIPT_NAMES } from "@/lib/media/fonts";

export const dynamic = "force-dynamic";

/**
 * App-wide settings — the first route in this tool that is not scoped to a project.
 *
 * Only the localization language list lives here so far. It is app-wide rather than
 * per-project because the set of markets an advertiser scales into is a property of
 * the business, not of one ad: the motion designer picks it once and every project
 * reuses it.
 */
export async function GET() {
  const languages = getSetting<string[]>(LOCALIZE_LANGUAGES_KEY, []);
  const overlays = getOverlays();

  // The catalogue and the credit balance are fetched live, and both are best-effort:
  // the settings page must still render its saved selection when HeyGen is
  // unreachable or unconfigured, otherwise a provider outage would look like data loss.
  let available: string[] = [];
  let credits: number | null = null;
  let error: string | null = null;
  if (heygenConfigured()) {
    try {
      [available, credits] = await Promise.all([listLanguages(), remainingCredits()]);
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    error = "HEYGEN_API_KEY is not set";
  }

  // Split rather than filtered, so the interface can say WHY a market is missing.
  // Silently dropping Japanese from a 190-language list looks like a bug; saying the
  // tool ships no font for it is a fact someone can act on.
  const renderable = available.filter((l) => renderableLanguage(l));
  const unsupported = available.filter((l) => !renderableLanguage(l));

  return NextResponse.json({
    languages,
    available: renderable,
    unsupported,
    supportedScripts: SUPPORTED_SCRIPT_NAMES,
    overlays,
    credits,
    configured: heygenConfigured(),
    error,
  });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { languages?: unknown; overlay?: { language?: string; bold?: string; body?: string; cta?: string } }
    | null;

  // An overlay edit is the human review step for machine-translated legal text, so it
  // is stored exactly as typed and marked as no longer machine-generated.
  if (body?.overlay) {
    const { language, bold, body: text, cta } = body.overlay;
    if (!language || typeof bold !== "string" || typeof text !== "string" || typeof cta !== "string") {
      return NextResponse.json({ error: "overlay needs language, bold, body and cta" }, { status: 400 });
    }
    const missing = missingGlyphs(`${bold}${text}${cta}`);
    if (missing.length) {
      return NextResponse.json(
        { error: `Those characters cannot be drawn by the bundled font (${missing.slice(0, 8).join(" ")}) — they would burn in as empty boxes.` },
        { status: 400 }
      );
    }
    setOverlays({
      ...getOverlays(),
      [language]: { bold: bold.trim(), body: text.trim(), cta: cta.trim(), machine: false },
    });
    return NextResponse.json({ overlays: getOverlays() });
  }

  if (!Array.isArray(body?.languages)) {
    return NextResponse.json({ error: "languages must be an array of strings" }, { status: 400 });
  }

  // Normalised on write, not on read: duplicates would each start their own paid
  // translation of the same video.
  const languages = Array.from(
    new Set(body.languages.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim()))
  );

  // Refused here as well as at render time. Saving an unrenderable language would
  // leave a setting that fails every future run for a reason not visible at the point
  // it was chosen.
  const bad = languages.filter((l) => !renderableLanguage(l));
  if (bad.length) {
    return NextResponse.json(
      { error: `${bad.join(", ")} cannot be rendered: this tool bundles fonts for ${SUPPORTED_SCRIPT_NAMES} only.` },
      { status: 400 }
    );
  }

  setSetting(LOCALIZE_LANGUAGES_KEY, languages);
  return NextResponse.json({ languages });
}
