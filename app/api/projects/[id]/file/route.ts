import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { projectDir } from "@/lib/paths";
import { remoteUrl } from "@/lib/storage/deliverables";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/**
 * Serves an artifact, from the volume or from object storage.
 *
 * One URL covers both, which is deliberate: every link, every `<video src>` and every
 * saved bookmark keeps working after a project's deliverables are moved off the
 * volume, and nothing in the interface has to ask where a file currently lives. An
 * offloaded file redirects to a short-lived signed URL — so the bucket stays private,
 * the bytes never pass through this container, and Range requests (scrubbing a
 * three-minute video) are answered by storage natively.
 *
 * The resolved local path is confined to the project's directory: `name` arrives from
 * the client, so without this check a `../../` would read anything the process can
 * reach, including the SQLite file holding every project.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name) return new Response("name is required", { status: 400 });

  const signed = remoteUrl(id, name, { download: url.searchParams.get("download") === "1" });
  if (signed) {
    // no-store matters: the redirect target carries a signature that expires, and a
    // cached 302 would eventually point every visit at a URL storage has stopped
    // accepting.
    return new Response(null, { status: 302, headers: { Location: signed, "Cache-Control": "no-store" } });
  }

  const root = path.resolve(projectDir(id));
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return new Response("forbidden", { status: 403 });
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!info.isFile()) return new Response("not found", { status: 404 });

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";

  // Range support so the browser can scrub a 146-second video without downloading
  // all ~80 MB first.
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : info.size - 1;
      if (start >= info.size || end >= info.size || start > end) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        });
      }
      const stream = Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${info.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(info.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
