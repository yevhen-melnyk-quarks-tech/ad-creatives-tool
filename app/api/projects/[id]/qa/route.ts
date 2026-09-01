import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Latest QA report per (stage, scene) — the audit trail behind every auto-repair. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const all = new URL(req.url).searchParams.get("all") === "1";

  const rows = db()
    .prepare(
      all
        ? `SELECT * FROM qa_runs WHERE project_id=? ORDER BY created_at DESC`
        : `SELECT r.* FROM qa_runs r
           JOIN (SELECT stage, COALESCE(scene_id,'') k, MAX(created_at) m
                 FROM qa_runs WHERE project_id=? GROUP BY stage, k) latest
             ON r.stage=latest.stage AND COALESCE(r.scene_id,'')=latest.k AND r.created_at=latest.m
           ORDER BY r.stage, r.scene_id`
    )
    .all(id) as { report_json: string }[];

  return NextResponse.json({
    reports: rows.map((r) => ({ ...r, report: JSON.parse(r.report_json) })),
  });
}
