import { NextResponse } from "next/server";
import { db, setNote } from "@/lib/db";
import { enqueue, type JobKind } from "@/lib/jobs/worker";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const KINDS: JobKind[] = [
  "character_card", "storyboards", "storyboard_one",
  "videos", "video_one", "captions", "assemble", "offload",
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
  const body = (await req.json().catch(() => null)) as
    | { kind?: JobKind; sceneId?: string; note?: string; force?: boolean }
    | null;
  if (!body?.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  if ((body.kind === "storyboard_one" || body.kind === "video_one") && !body.sceneId) {
    return NextResponse.json({ error: "sceneId is required for single-scene jobs" }, { status: 400 });
  }

  // A note sent with the job is saved before it is queued, so "re-roll with this
  // note" is one action for the user instead of save-then-run.
  if (typeof body.note === "string") {
    const kindForNote =
      body.kind === "storyboard_one" || body.kind === "storyboards"
        ? "storyboard"
        : body.kind === "video_one" || body.kind === "videos"
          ? "video"
          : body.kind === "character_card"
            ? "character_card"
            : null;
    if (kindForNote) setNote(id, kindForNote, body.sceneId ?? null, body.note);
  }

  // Collapse a repeat request onto the job already in flight.
  //
  // Generation starts seconds after the row is inserted, so the interface looks idle
  // right after a click. The motion designer read that as a hang, clicked again, and
  // paid for a second render of the same scene - "click re-roll a few times and it
  // re-generates a few times". Guarding only in the client would leave the same hole
  // open to a second tab, a double-tap, or a stale page, so the queue itself refuses.
  //
  // Keyed on scene as well as kind: two different scenes may legitimately be queued at
  // once, the same scene twice may not.
  const existing = db()
    .prepare(
      `SELECT id, kind, status, payload FROM jobs
        WHERE project_id = ? AND kind = ? AND status IN ('queued', 'running')
        ORDER BY created_at LIMIT 20`
    )
    .all(id, body.kind) as { id: string; kind: string; status: string; payload: string }[];

  const duplicate = existing.find((j) => {
    try {
      return (JSON.parse(j.payload).sceneId ?? null) === (body.sceneId ?? null);
    } catch {
      return false;
    }
  });

  if (duplicate) {
    // 200 with the in-flight id, not an error: the user's intent is already being
    // carried out, so the interface should track that job rather than show a failure.
    return NextResponse.json(
      { jobId: duplicate.id, coalesced: true, status: duplicate.status },
      { status: 200 }
    );
  }

  // One running job at a time keeps ffmpeg and the model APIs from contending, and
  // makes the progress log readable. Queueing is fine; parallelism is not the goal.
  const jobId = enqueue(id, body.kind, { sceneId: body.sceneId, force: body.force === true });
  return NextResponse.json({ jobId }, { status: 202 });
}
