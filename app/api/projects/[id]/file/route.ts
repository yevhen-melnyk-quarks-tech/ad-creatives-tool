import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { projectDir } from "@/lib/paths";

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
 * Serves an artifact out of the project's directory.
 *
 * The resolved path is confined to that directory: `name` arrives from the client, so
 * without this check a `../../` would read anything the process can reach, including
 * the SQLite file holding every project.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return new Response("name is required", { status: 400 });

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
