import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Human approval gate. Video generation only runs against storyboards marked here,
 * so this is the control that stands between a questionable sheet and paid renders.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { kind?: string; sceneId?: string | null; approved?: boolean }
    | null;
  if (!body?.kind) return NextResponse.json({ error: "kind is required" }, { status: 400 });

  const res = db()
    .prepare(
      `UPDATE artifacts SET approved=?
       WHERE project_id=? AND kind=? AND scene_id IS ?`
    )
    .run(body.approved === false ? 0 : 1, id, body.kind, body.sceneId ?? null);

  if (res.changes === 0) {
    return NextResponse.json({ error: "no matching artifact — generate it first" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
