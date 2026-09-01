import { NextResponse } from "next/server";
import { db, projectSpendUsd } from "@/lib/db";
import { projectDir, dirSizeBytes, humanBytes, pruneIntermediates } from "@/lib/paths";
import { ScenarioSchema } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = db().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const artifacts = db()
    .prepare(`SELECT kind, scene_id, file_path, attempt, approved FROM artifacts WHERE project_id = ?`)
    .all(id);
  const jobs = db()
    .prepare(`SELECT id, kind, status, error, created_at, finished_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`)
    .all(id);

  // Disk usage is surfaced deliberately: the brief for this tool asked for visible
  // work-in-progress files and control over how large the folder gets.
  const bytes = await dirSizeBytes(projectDir(id));

  return NextResponse.json({
    project,
    artifacts,
    jobs,
    spendUsd: projectSpendUsd(id),
    diskBytes: bytes,
    diskHuman: humanBytes(bytes),
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { scenario?: unknown; title?: string } | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  if (body.scenario !== undefined) {
    const parsed = ScenarioSchema.safeParse(body.scenario);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "scenario failed validation", issues: parsed.error.issues.slice(0, 10) },
        { status: 400 }
      );
    }
    db()
      .prepare(`UPDATE projects SET scenario_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(parsed.data), id);
  }
  if (body.title) {
    db().prepare(`UPDATE projects SET title=?, updated_at=datetime('now') WHERE id=?`).run(body.title, id);
  }
  return NextResponse.json({ ok: true });
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
