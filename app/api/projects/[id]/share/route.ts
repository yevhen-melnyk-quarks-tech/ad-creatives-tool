import { NextResponse } from "next/server";
import { DELIVERABLES, remoteUrl, remoteRow } from "@/lib/storage/deliverables";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A long-lived signed URL for one deliverable, to hand to someone outside the tool.
 *
 * Seven days rather than forever, and signed rather than public: the bucket holds
 * unreleased ad creatives, so a link that cannot be revoked by expiry is a link that
 * outlives whatever it was shared for. R2's public r2.dev subdomain would have made
 * every object permanently readable by anyone who ever saw a URL.
 *
 * Only the known deliverable names are accepted. `name` comes from the client, and an
 * unconstrained value would sign a URL for any key in the bucket, which spans every
 * project.
 */
const TTL_SECONDS = 7 * 24 * 3600;

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const name = new URL(req.url).searchParams.get("name") ?? "";

  if (!DELIVERABLES.some((d) => d.name === name)) {
    return NextResponse.json({ error: "unknown deliverable" }, { status: 400 });
  }
  if (!remoteRow(id, name)) {
    return NextResponse.json(
      { error: "that file is still on the volume — move it to object storage first" },
      { status: 409 }
    );
  }

  const url = remoteUrl(id, name, { download: true, ttlSeconds: TTL_SECONDS });
  if (!url) return NextResponse.json({ error: "object storage is not configured" }, { status: 409 });

  return NextResponse.json({ url, expiresInDays: 7 });
}
