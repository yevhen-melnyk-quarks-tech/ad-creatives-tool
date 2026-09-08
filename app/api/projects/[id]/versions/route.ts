import { NextResponse } from "next/server";
import path from "node:path";
import { listVersions, promoteVersion, pruneVersions, backfillVersions } from "@/lib/pipeline/versions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const KINDS = ["character_card", "storyboard", "video"];

/**
 * Every take of every artifact in the project.
 *
 * Backfilled on read: artifacts generated before version history existed have no rows,
 * and without seeding them the first re-roll of an older project would show a "v2" with
 * no v1 to compare against — and would still lose the take already on disk.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await backfillVersions(id);

  const versions = listVersions(id).map((v) => ({
    kind: v.kind,
    sceneId: v.scene_id,
    version: v.version,
    verdict: v.verdict,
    summary: v.summary,
    bytes: v.bytes,
    isCurrent: v.is_current === 1,
    createdAt: v.created_at,
    // Version files live in _versions/, and the file route resolves names relative to
    // the project directory, so the subdirectory has to be part of the name.
    name: path.join("_versions", path.basename(v.file_path)),
  }));

  return NextResponse.json({ versions });
}

/**
 * Promotes an older take back to current, or prunes superseded ones.
 *
 * Promotion is the half that earns its keep: without it, preferring an earlier take
 * means re-rolling and hoping the model lands on it again, which costs money and may
 * never happen.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { action?: string; kind?: string; sceneId?: string | null; version?: number }
    | null;

  if (body?.action === "prune") {
    const result = await pruneVersions(id);
    return NextResponse.json(result);
  }

  if (body?.action !== "promote") {
    return NextResponse.json({ error: "action must be 'promote' or 'prune'" }, { status: 400 });
  }
  if (!body.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  if (!Number.isInteger(body.version) || (body.version as number) < 1) {
    return NextResponse.json({ error: "version must be a positive integer" }, { status: 400 });
  }

  try {
    const result = await promoteVersion(id, body.kind, body.sceneId ?? null, body.version as number);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
