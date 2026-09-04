import { NextResponse } from "next/server";
import { getNote, setNote, listNotes } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const KINDS = ["character_card", "storyboard", "video"];

/**
 * Operator corrections — free text a human types after looking at a generated
 * artifact, fed into the prompt on the next generation.
 *
 * This is the only feedback channel for scenes the QA critic cannot assess, which is
 * every scene whose cast includes a child.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return NextResponse.json({ notes: listNotes(id) });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { kind?: string; sceneId?: string | null; note?: string }
    | null;

  if (!body?.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  if (typeof body.note !== "string") {
    return NextResponse.json({ error: "note must be a string (empty clears it)" }, { status: 400 });
  }

  setNote(id, body.kind, body.sceneId ?? null, body.note);
  return NextResponse.json({ ok: true, note: getNote(id, body.kind, body.sceneId ?? null) });
}
