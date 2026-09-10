/**
 * Starts the job worker at server boot, before any request is served.
 *
 * This is a correctness requirement, not a convenience. The worker is a process-wide
 * singleton (`globalThis.__adCreativesWorker`), so whichever context calls
 * `ensureWorker()` first owns the poll timer for the life of the process — and the
 * home page used to be a likely first caller. A `setInterval` created during a Server
 * Component render inherits that render's context, where Next memoizes GET fetches
 * with identical URL and options: every Replicate status poll then replayed the first
 * response forever and no prediction could ever be observed finishing. That cost a
 * full day of generations on 2026-09-10 (24 predictions completed and paid for, zero
 * clips kept).
 *
 * `fetchRetry` now defeats that memoization directly (see lib/models/http.ts), which
 * is the actual fix. Starting the loop here as well means the poll timer is never
 * created inside a render in the first place — belt and braces on a failure mode that
 * is silent, expensive, and only visible hours later.
 *
 * `register()` runs once per server instance and blocks readiness, so this must stay
 * cheap: `ensureWorker()` is synchronous (one SQLite recovery query, then a timer).
 */
export async function register() {
  // Skip the Edge runtime pass — better-sqlite3 is native and node-only.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureWorker } = await import("@/lib/jobs/worker");
  ensureWorker();
  console.log("[worker] started from instrumentation register()");
}
