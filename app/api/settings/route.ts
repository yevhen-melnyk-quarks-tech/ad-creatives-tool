import { NextResponse } from "next/server";
import { getSetting, setSetting, LOCALIZE_LANGUAGES_KEY } from "@/lib/db";
import { listLanguages, heygenConfigured, remainingCredits } from "@/lib/models/heygen";

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

  return NextResponse.json({ languages, available, credits, configured: heygenConfigured(), error });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { languages?: unknown } | null;
  if (!Array.isArray(body?.languages)) {
    return NextResponse.json({ error: "languages must be an array of strings" }, { status: 400 });
  }

  // Normalised on write, not on read: duplicates would each start their own paid
  // translation of the same video.
  const languages = Array.from(
    new Set(body.languages.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim()))
  );

  setSetting(LOCALIZE_LANGUAGES_KEY, languages);
  return NextResponse.json({ languages });
}
