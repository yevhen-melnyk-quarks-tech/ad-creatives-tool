import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * Minimal S3-compatible client for Cloudflare R2.
 *
 * Hand-rolled SigV4 rather than @aws-sdk/client-s3: this needs four operations, and
 * the SDK is tens of megabytes in an image that already carries ffmpeg. The signing
 * is the only fiddly part and it is fully covered by lib/storage/r2.test.ts.
 *
 * Payloads are signed as UNSIGNED-PAYLOAD, which R2 accepts over HTTPS. The
 * alternative is hashing the whole body first — a pointless second read of a 157 MB
 * file, and one that would have to buffer it to hash and upload in one pass.
 */

const REGION = "auto";
const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

/**
 * Reads the configuration from the environment, or null when R2 is not set up.
 *
 * Null is a supported state, not an error: with no credentials the app keeps every
 * deliverable on the local volume and behaves exactly as it did before. That keeps a
 * developer running `npm run dev` from needing cloud credentials at all.
 */
export function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

const host = (c: R2Config) => `${c.accountId}.r2.cloudflarestorage.com`;
const sha256 = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const hmac = (key: string | Buffer, v: string) => createHmac("sha256", key).update(v).digest();

/** ISO8601 basic format, which is the only one SigV4 accepts. */
function stamps(now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(c: R2Config, dateStamp: string) {
  return hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, dateStamp), REGION), SERVICE), "aws4_request");
}

/**
 * S3 wants each path segment percent-encoded, but NOT the separating slashes, and it
 * treats `+` as a literal rather than a space — so encodeURIComponent per segment.
 */
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

function authorize(
  c: R2Config,
  method: string,
  key: string,
  headers: Record<string, string>,
  amzDate: string,
  dateStamp: string
) {
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h].trim()}\n`)
    .join("");
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = [
    method,
    `/${c.bucket}/${encodeKey(key)}`,
    "",
    canonicalHeaders,
    signedHeaders,
    UNSIGNED,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(c, dateStamp)).update(stringToSign).digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function send(c: R2Config, method: string, key: string, body?: BodyInit, contentType?: string, extra?: Record<string, string>) {
  const { amzDate, dateStamp } = stamps();
  const headers: Record<string, string> = {
    host: host(c),
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": amzDate,
    ...extra,
  };
  if (contentType) headers["content-type"] = contentType;

  const res = await fetch(`https://${host(c)}/${c.bucket}/${encodeKey(key)}`, {
    method,
    headers: { ...headers, authorization: authorize(c, method, key, headers, amzDate, dateStamp) },
    body,
    // Node needs this to stream a request body rather than buffering it.
    ...(body instanceof Readable || body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  return res;
}

/** Uploads a local file. Streams it, so a 157 MB deliverable never sits in memory. */
export async function putFile(c: R2Config, key: string, filePath: string, contentType: string) {
  const { size } = await stat(filePath);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  const res = await send(c, "PUT", key, stream, contentType, { "content-length": String(size) });
  if (!res.ok) throw new Error(`R2 upload of ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return size;
}

/**
 * Object size in bytes, or null when it does not exist.
 *
 * A one-byte ranged GET rather than a HEAD. Cloudflare gzips compressible types, and
 * a HEAD that comes back `content-encoding: gzip` carries no usable content-length —
 * it reads as 0. That is not a hypothetical: it made every text deliverable look like
 * a failed upload while the object was in fact stored perfectly, because the size
 * check compared 0 against the local file. `content-range` reports the object's true
 * length for every content type.
 */
export async function objectSize(c: R2Config, key: string): Promise<number | null> {
  const res = await send(c, "GET", key, undefined, undefined, { range: "bytes=0-0" });
  if (res.status === 404) return null;
  if (res.status === 416) return 0; // a ranged read of an empty object
  if (res.status !== 206 && !res.ok) throw new Error(`R2 size of ${key} failed: ${res.status}`);

  const total = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1];
  await res.arrayBuffer(); // one byte, but the body still has to be drained
  if (total) return Number(total);

  const len = res.headers.get("content-length");
  return len === null ? null : Number(len);
}

export async function deleteObject(c: R2Config, key: string) {
  const res = await send(c, "DELETE", key);
  // 204 on success, 404 when it was already gone — both are the desired end state.
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete of ${key} failed: ${res.status}`);
}

export async function createBucket(c: R2Config) {
  const { amzDate, dateStamp } = stamps();
  const headers: Record<string, string> = {
    host: host(c),
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": amzDate,
  };
  // The bucket itself is the resource here, so the canonical path has no key.
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = ["PUT", `/${c.bucket}`, "", canonicalHeaders, signedHeaders, UNSIGNED].join("\n");
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(c, dateStamp)).update(stringToSign).digest("hex");

  const res = await fetch(`https://${host(c)}/${c.bucket}`, {
    method: "PUT",
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`R2 create bucket failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 409 ? "exists" : "created";
}

/**
 * A time-limited GET URL, computed locally with no request to R2.
 *
 * This is what keeps the bucket private. The alternative — R2's public r2.dev
 * subdomain — would make every unreleased ad creative readable by anyone who ever saw
 * a link, permanently. A presigned URL expires, and nothing has to be world-readable
 * for a browser to play or download the file.
 */
export function presignGet(c: R2Config, key: string, expiresSeconds: number, filename?: string): string {
  const { amzDate, dateStamp } = stamps();
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  // Makes the browser save under a sensible name instead of the object key's basename.
  if (filename) query["response-content-disposition"] = `attachment; filename="${filename}"`;

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    `/${c.bucket}/${encodeKey(key)}`,
    canonicalQuery,
    `host:${host(c)}\n`,
    "host",
    UNSIGNED,
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(c, dateStamp)).update(stringToSign).digest("hex");

  return `https://${host(c)}/${c.bucket}/${encodeKey(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Deliverables live under one prefix per project, so a project's objects are prunable. */
export const objectKey = (projectId: string, name: string) => `projects/${projectId}/${name}`;
