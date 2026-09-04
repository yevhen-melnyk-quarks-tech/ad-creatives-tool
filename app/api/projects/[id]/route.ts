import { NextResponse } from "next/server";
import { db, projectSpendUsd, recordCost } from "@/lib/db";
import { projectDir, dirSizeBytes, humanBytes, pruneIntermediates } from "@/lib/paths";
import { ScenarioSchema } from "@/lib/pipeline/types";
import { normalizeScenario } from "@/lib/pipeline/normalize";
import { parseBrief } from "@/lib/agents/briefParser";
import { RATES_ARE_DEFAULTS } from "@/lib/models/pricing";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = db().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const artifacts = db()
    .prepare(`SELECT kind, scene_id, file_path, attempt, approved, prompt_additions FROM artifacts WHERE project_id = ?`)
    .all(id);
  const jobs = db()
    .prepare(`SELECT id, kind, status, error, created_at, finished_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`)
    .all(id);

  // Disk usage is surfaced deliberately: the brief for this tool asked for visible
  // work-in-progress files and control over how large the folder gets.
  const bytes = await dirSizeBytes(projectDir(id));

  // Broken out by provider+operation so the number is inspectable rather than one
  // opaque total — image generation and agent calls used to be missing entirely.
  const spendBreakdown = db()
    .prepare(
      `SELECT provider, operation, COUNT(*) AS calls, SUM(usd) AS usd
       FROM costs WHERE project_id = ?
       GROUP BY provider, operation ORDER BY usd DESC`
    )
    .all(id);

  return NextResponse.json({
    project,
    artifacts,
    jobs,
    spendUsd: projectSpendUsd(id),
    spendBreakdown,
    spendRatesAreDefaults: RATES_ARE_DEFAULTS,
    diskBytes: bytes,
    diskHuman: humanBytes(bytes),
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { scenario?: unknown; title?: string; brief?: string }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  let warnings: string[] = [];

  // Explicit scenario JSON wins over a brief re-parse if both are somehow sent —
  // that path is the deliberate manual override, so it should never be silently
  // clobbered by a re-parse of stale brief text.
  if (body.scenario !== undefined) {
    const parsed = ScenarioSchema.safeParse(body.scenario);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "scenario failed validation", issues: parsed.error.issues.slice(0, 10) },
        { status: 400 }
      );
    }
    const normalized = normalizeScenario(parsed.data);
    warnings = normalized.warnings;
    db()
      .prepare(`UPDATE projects SET scenario_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(normalized.scenario), id);
  } else if (body.brief !== undefined) {
    // Re-parsing overwrites the scenario. This is the "tweak the Notion text and
    // regenerate" flow, so any per-artifact approvals from the old scenario are now
    // meaningless — clear them rather than leave a video generating from a storyboard
    // whose scene no longer matches the new scenario.
    if (!body.brief.trim()) {
      return NextResponse.json({ error: "brief cannot be empty" }, { status: 400 });
    }
    try {
      const result = await parseBrief(body.brief);
      warnings = result.warnings;
      if (result.usd > 0) {
        recordCost({ projectId: id, provider: "gemini", operation: "brief-parse", usd: result.usd });
      }
      db()
        .prepare(`UPDATE projects SET brief=?, scenario_json=?, updated_at=datetime('now') WHERE id=?`)
        .run(body.brief, JSON.stringify(result.scenario), id);
      db().prepare(`DELETE FROM artifacts WHERE project_id=?`).run(id);
    } catch (err) {
      return NextResponse.json({ error: `Could not parse brief: ${(err as Error).message}` }, { status: 422 });
    }
  }

  if (body.title) {
    db().prepare(`UPDATE projects SET title=?, updated_at=datetime('now') WHERE id=?`).run(body.title, id);
  }
  return NextResponse.json({ ok: true, warnings });
}

/** Reclaims disk without destroying the deliverable: drops working/diagnostic files only. */
export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  const url = new URL(req.url);
  if (url.searchParams.get("mode") !== "intermediates") {
    return NextResponse.json(
      { error: "only ?mode=intermediates is supported; deleting a whole project is not exposed" },
      { status: 400 }
    );
  }
  await pruneIntermediates(id);
  const bytes = await dirSizeBytes(projectDir(id));
  return NextResponse.json({ ok: true, diskBytes: bytes, diskHuman: humanBytes(bytes) });
}
