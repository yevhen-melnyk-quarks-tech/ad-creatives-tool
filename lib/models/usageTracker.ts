import { AsyncLocalStorage } from "node:async_hooks";
import type { Usage } from "./pricing";

/**
 * Per-job-execution context for model usage, so cost can be captured without
 * threading a callback down through stage → repair loop → critic → client.
 *
 * This used to be a single module-level variable, which was safe only because the
 * worker ran strictly one job at a time — the comment on that version said so
 * explicitly: "if that ever becomes concurrent, this must become a proper per-job
 * context or costs will be attributed to the wrong project." The worker now runs
 * several projects' jobs concurrently (see lib/jobs/worker.ts), which made that
 * exact failure live: two jobs' Gemini calls would race to overwrite the same
 * variable, and one project's cost could land on another's ledger.
 *
 * `AsyncLocalStorage` is the fix — each call into `withUsageSink` gets its own
 * store that every `await` inside it (however deep, and regardless of how many
 * *other* stores are concurrently active in sibling contexts) continues to see.
 * Verified directly before relying on it: two contexts started concurrently, with
 * their inner calls' completion order deliberately interleaved, each only ever saw
 * their own callbacks — never the other's.
 */
type Sink = (usage: Usage, operation: string) => void;

const storage = new AsyncLocalStorage<Sink>();

/** Runs `fn` with `sink` as the usage context for every `reportUsage` call beneath it. */
export function withUsageSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return storage.run(sink, fn);
}

export function reportUsage(usage: Usage, operation: string) {
  storage.getStore()?.(usage, operation);
}
