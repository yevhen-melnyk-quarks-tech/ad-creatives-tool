import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueue, type JobKind } from "@/lib/jobs/worker";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const KINDS: JobKind[] = [
  "character_card", "storyboards", "storyboard_one",
  "videos", "video_one", "captions", "assemble",
];

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (jobId) {
    const job = db().prepare(`SELECT * FROM jobs WHERE id=? AND project_id=?`).get(jobId, id);
    return job ? NextResponse.json({ job }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const jobs = db()
    .prepare(`SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 30`)
    .all(id);
  return NextResponse.json({ jobs });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { kind?: JobKind; sceneId?: string } | null;
  if (!body?.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  if ((body.kind === "storyboard_one" || body.kind === "video_one") && !body.sceneId) {
    return NextResponse.json({ error: "sceneId is required for single-scene jobs" }, { status: 400 });
  }

  // One running job at a time keeps ffmpeg and the model APIs from contending, and
  // makes the progress log readable. Queueing is fine; parallelism is not the goal.
  const jobId = enqueue(id, body.kind, { sceneId: body.sceneId });
  return NextResponse.json({ jobId }, { status: 202 });
}
