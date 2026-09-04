import type { Usage } from "./pricing";

/**
 * Ambient sink for model usage, so cost can be captured without threading a callback
 * down through stage → repair loop → critic → client.
 *
 * Module-level state is safe here for one specific reason: the job worker runs
 * strictly one job at a time (see the `running` guard in lib/jobs/worker.ts), so
 * there is never more than one project's work in flight in this process. If that
 * ever becomes concurrent, this must become a proper per-job context or costs will
 * be attributed to the wrong project.
 */
type Sink = (usage: Usage, operation: string) => void;

let sink: Sink | null = null;

export function setUsageSink(next: Sink | null) {
  sink = next;
}

export function reportUsage(usage: Usage, operation: string) {
  sink?.(usage, operation);
}
