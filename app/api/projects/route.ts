import { NextResponse } from "next/server";
import { db, uid } from "@/lib/db";
import { ensureProjectDirs } from "@/lib/paths";
import { ScenarioSchema } from "@/lib/pipeline/types";
import { ensureWorker } from "@/lib/jobs/worker";

// Every route touches SQLite and the artifact volume, so none of this can be
// statically rendered or cached.
export const dynamic = "force-dynamic";

export async function GET() {
  ensureWorker();
  const rows = db()
    .prepare(`SELECT id, title, status, created_at, updated_at FROM projects ORDER BY created_at DESC`)
    .all();
  return NextResponse.json({ projects: rows });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { title?: string; brief?: string; scenario?: unknown }
    | null;
  if (!body?.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  // A scenario may be supplied up-front (pasted JSON) or authored later.
  let scenarioJson: string | null = null;
  if (body.scenario) {
    const parsed = ScenarioSchema.safeParse(body.scenario);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "scenario failed validation", issues: parsed.error.issues.slice(0, 10) },
        { status: 400 }
      );
    }
    scenarioJson = JSON.stringify(parsed.data);
  }

  const id = uid();
  db()
    .prepare(`INSERT INTO projects (id, title, brief, scenario_json) VALUES (?, ?, ?, ?)`)
    .run(id, body.title.trim(), body.brief ?? "", scenarioJson);
  await ensureProjectDirs(id);
  ensureWorker();

  return NextResponse.json({ id }, { status: 201 });
}
