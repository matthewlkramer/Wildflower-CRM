import type { ResearchJobOutcome } from "./conferenceResearchWorker";

export const MAX_CONFERENCE_JOBS_PER_RUN = 20;
export const MAX_CONFERENCE_RUN_MS = 12 * 60_000;
// The CLI parent kills a still-running child before the deployment's 20m timeout.
export const HARD_CONFERENCE_RUN_MS = 15 * 60_000;

export interface ConferenceRunSummary {
  eventsScanned: number;
  windowsDue: number;
  enqueueFailures: number;
  contextInvalidated: number;
  staleRequeued: number;
  staleExhausted: number;
  jobsAttempted: number;
  completed: number;
  retrying: number;
  failed: number;
  skipped: number;
  jobCapReached: boolean;
  runtimeCapReached: boolean;
  exitCode: 0 | 1;
}

export interface ConferenceRunDependencies {
  assertSchemaReady(): Promise<void>;
  invalidateStale(): Promise<number>;
  enqueue(now: Date): Promise<{ eventsScanned: number; windowsDue: number; enqueueFailures: number }>;
  recover(): Promise<{ requeued: number; exhausted: number }>;
  runJob(): Promise<ResearchJobOutcome | null>;
  now(): number;
}

/** One scheduled invocation, with no HTTP listener, interval, or implicit backfill. */
export async function runConferenceResearchOnce(
  deps: ConferenceRunDependencies,
  options: { maxJobs?: number; maxRuntimeMs?: number } = {},
): Promise<ConferenceRunSummary> {
  const maxJobs = options.maxJobs ?? MAX_CONFERENCE_JOBS_PER_RUN;
  const maxRuntimeMs = options.maxRuntimeMs ?? MAX_CONFERENCE_RUN_MS;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 ||
    !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1) {
    throw new Error("Invalid conference research run limits.");
  }
  // No queue write, claim, or lease recovery before migration 0267 is verified.
  await deps.assertSchemaReady();
  const startedAt = deps.now();
  const contextInvalidated = await deps.invalidateStale();
  const enqueued = await deps.enqueue(new Date(startedAt));
  const recovered = await deps.recover();
  const summary: ConferenceRunSummary = {
    ...enqueued,
    contextInvalidated,
    staleRequeued: recovered.requeued,
    staleExhausted: recovered.exhausted,
    jobsAttempted: 0,
    completed: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
    jobCapReached: false,
    runtimeCapReached: false,
    exitCode: 0,
  };
  while (summary.jobsAttempted < maxJobs && deps.now() - startedAt < maxRuntimeMs) {
    const outcome = await deps.runJob();
    if (outcome === null) break;
    summary.jobsAttempted += 1;
    if (outcome === "completed") summary.completed += 1;
    if (outcome === "retry") summary.retrying += 1;
    if (outcome === "failed") summary.failed += 1;
    if (outcome === "skipped") summary.skipped += 1;
  }
  summary.jobCapReached = summary.jobsAttempted === maxJobs;
  summary.runtimeCapReached = deps.now() - startedAt >= maxRuntimeMs;
  summary.exitCode = summary.enqueueFailures || summary.contextInvalidated || summary.staleExhausted ||
    summary.retrying || summary.failed ? 1 : 0;
  return summary;
}