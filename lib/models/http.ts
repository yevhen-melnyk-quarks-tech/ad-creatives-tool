// Shared HTTP behaviour for every model provider. Both rules here are scars from the
// POC runs, not defensive boilerplate:
//
//   readJson  — calling res.json() before checking res.ok crashed a whole run: a
//               Replicate 402 came back non-JSON, so .json() threw a SyntaxError past
//               every handler and printed a bare Node stack instead of "insufficient
//               credit". Read the text first, then decide.
//
//   fetchRetry— connection-level failures throw before any response exists, so
//               readJson never sees them. A single EHOSTUNREACH mid-poll killed two
//               separate paid video generations.
//
//   signal    — Next.js patches the global fetch and memoizes GET requests with the
//               same URL and options for the life of a render pass. Our polling loops
//               ask the same URL the same way every 10 seconds, so after the first
//               poll every later one replayed that first cached response and the
//               status could never change. Real incident, 2026-09-10: 24 predictions
//               completed on Replicate's side while the worker sat on a frozen
//               `processing` for the full 20-minute poll ceiling and then threw away
//               3,226 seconds of billed compute. `cache: "no-store"` does NOT opt out
//               (that governs the Data Cache, a different mechanism) — an
//               AbortController signal does, because it makes the options object
//               un-memoizable. Verified both ways against a counter endpoint before
//               choosing this.

export async function fetchRetry(
  url: string,
  options: RequestInit = {},
  attempts = 4,
  label = "request",
  onRetry?: (msg: string) => void
): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      // A fresh controller per attempt, never aborted. It exists purely so this
      // request can never be served from Next's per-render memoization cache; a
      // caller's own signal, if there is one, still wins.
      const signal = options.signal ?? new AbortController().signal;
      return await fetch(url, { ...options, signal });
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error).message;
      if (i >= attempts) throw new Error(`${label}: network failed after ${attempts} attempts — ${code}`);
      const waitMs = 2000 * i;
      onRetry?.(`${label}: network error (${code}), retrying in ${waitMs / 1000}s [${i}/${attempts - 1}]`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export async function readJson<T = unknown>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* provider returned a non-JSON error body */
  }
  if (!res.ok) {
    const j = json as { detail?: string; title?: string; error?: { message?: string } } | null;
    const detail = j?.error?.message ?? j?.detail ?? j?.title ?? text.slice(0, 300) ?? "(empty body)";
    throw new Error(`${context} failed — HTTP ${res.status}: ${detail}`);
  }
  if (json === null) throw new Error(`${context}: response was not JSON — ${text.slice(0, 200)}`);
  return json as T;
}
