import { NextResponse } from "next/server";
import { db, projectSpendUsd, recordCost, listNotes } from "@/lib/db";
import { projectDir, dirSizeBytes, humanBytes, pruneIntermediates } from "@/lib/paths";
import { ScenarioSchema } from "@/lib/pipeline/types";
import { normalizeScenario } from "@/lib/pipeline/normalize";
import { parseBrief } from "@/lib/agents/briefParser";
import { RATES_ARE_DEFAULTS } from "@/lib/models/pricing";
import { VIDEO_RESOLUTIONS, SEEDANCE_480_RATE_IS_ESTIMATE, type VideoResolution } from "@/lib/models/replicate";
import { isDescriptorType, DESCRIPTORS } from "@/lib/pipeline/descriptors";
import { resolveDisclaimer } from "@/lib/pipeline/stages";

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
    .prepare(`SELECT id, kind, status, error, active_scene, payload, progress_step, progress_total, progress_label, progress, created_at, finished_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`)
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

  // What the final cut would actually burn right now, resolved the same way assembly
  // resolves it — so the UI cannot show something different from what ships.
  let disclaimer: unknown = null;
  const scenarioJson = project.scenario_json as string | null;
  if (scenarioJson) {
    const parsed = ScenarioSchema.safeParse(JSON.parse(scenarioJson));
    if (parsed.success) {
      const r = resolveDisclaimer(id, parsed.data);
      disclaimer = {
        ...r,
        text: [r.bold, r.body].filter(Boolean).join(" "),
        versions: parsed.data.versions,
        options: Object.entries(DESCRIPTORS).map(([type, d]) => ({ type: Number(type), name: d.name })),
      };
    }
  }

  return NextResponse.json({
    project,
    artifacts,
    jobs,
    disclaimer,
    spendUsd: projectSpendUsd(id),
    spendBreakdown,
    notes: listNotes(id),
    spendRatesAreDefaults: RATES_ARE_DEFAULTS,
    resolution480IsEstimate: SEEDANCE_480_RATE_IS_ESTIMATE,
    diskBytes: bytes,
    diskHuman: humanBytes(bytes),
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | {
        scenario?: unknown; title?: string; brief?: string; videoResolution?: string;
        descriptorType?: number | null; disclaimerText?: string | null;
      }
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

    // Repair constraints were inferred against the OLD scenario, so replacing it makes
    // them stale — and a stale one is not merely useless, it actively fights the new
    // scenario. One read "do not draw John ... even if mentioned in the frame
    // descriptions", which survived a cast repair and kept the protagonist out of his
    // own scene on every subsequent re-roll. Artifacts and approvals are deliberately
    // kept; only the inferred constraints are dropped.
    const cleared = db()
      .prepare(`UPDATE artifacts SET prompt_additions=NULL WHERE project_id=? AND prompt_additions IS NOT NULL`)
      .run(id);
    if (cleared.changes > 0) {
      warnings.push(
        `Cleared auto-repair constraints on ${cleared.changes} artifact(s) — they were inferred from the previous scenario. Approvals and generated files are untouched.`
      );
    }
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
      // Notes are written against specific scenes; a re-parse can renumber or merge
      // them, so a stale note would attach to the wrong shot.
      db().prepare(`DELETE FROM artifact_notes WHERE project_id=?`).run(id);
    } catch (err) {
      return NextResponse.json({ error: `Could not parse brief: ${(err as Error).message}` }, { status: 422 });
    }
  }

  if (body.title) {
    db().prepare(`UPDATE projects SET title=?, updated_at=datetime('now') WHERE id=?`).run(body.title, id);
  }
  if (body.descriptorType !== undefined) {
    if (body.descriptorType !== null && !isDescriptorType(body.descriptorType)) {
      return NextResponse.json({ error: "descriptorType must be 1, 2, 3 or null" }, { status: 400 });
    }
    // Null resets to whatever the brief's version block selected.
    db()
      .prepare(`UPDATE projects SET descriptor_type=?, updated_at=datetime('now') WHERE id=?`)
      .run(body.descriptorType, id);
  }
  if (body.disclaimerText !== undefined) {
    // Empty string clears the override so the descriptor's official wording is used.
    const text = body.disclaimerText?.trim() ? body.disclaimerText.trim() : null;
    db()
      .prepare(`UPDATE projects SET disclaimer_text=?, updated_at=datetime('now') WHERE id=?`)
      .run(text, id);
  }
  if (body.videoResolution !== undefined) {
    if (!VIDEO_RESOLUTIONS.includes(body.videoResolution as VideoResolution)) {
      return NextResponse.json(
        { error: `videoResolution must be one of ${VIDEO_RESOLUTIONS.join(", ")}` },
        { status: 400 }
      );
    }
    // Applies to clips generated from now on; existing clips keep whatever they
    // were rendered at, so a project can end up mixing resolutions.
    db()
      .prepare(`UPDATE projects SET video_resolution=?, updated_at=datetime('now') WHERE id=?`)
      .run(body.videoResolution, id);
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
