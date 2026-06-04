import { logger } from "./logger";
import {
  type EntityRef,
  dedupeKeyForEntity,
  runTaskSuggestion,
} from "./taskProposalEngine";

/**
 * Signal-triggered task-suggestion regeneration.
 *
 * When a new relationship signal lands for an entity (a new matched
 * email/meeting, a media mention, a gift, an opportunity/pledge) we want its
 * cached next-step suggestion to reflect that signal — but we must not fire
 * an AI call per raw event. Bulk imports, calendar resyncs, and media sweeps
 * can touch the same entity dozens of times in a few seconds.
 *
 * This in-process queue debounces + dedupes those bursts: callers enqueue
 * entity refs (fire-and-forget); the queue coalesces repeats by dedupe key
 * and, after a quiet window, flushes each affected entity exactly once
 * through the shared `runTaskSuggestion` entry point (mode "regenerate"),
 * which enforces the priority gate, the resolved-suppression invariant, and
 * the AI concurrency/rate-limit guardrails. A single flush runs at a time;
 * signals that arrive mid-flush are collected for the next one.
 *
 * Intentionally process-local and best-effort: a dropped enqueue (process
 * restart) is harmless — the monthly refresh and the next signal both heal
 * the suggestion. Disabled under NODE_ENV=test and via
 * DISABLE_TASK_SUGGESTIONS=1.
 */

// Quiet window after the last signal before a batch flushes.
const DEBOUNCE_MS = 10_000;
// Hard ceiling so a never-quiet stream still drains periodically.
const MAX_WAIT_MS = 60_000;

const pending = new Map<string, EntityRef>();
let debounceTimer: NodeJS.Timeout | null = null;
let maxWaitTimer: NodeJS.Timeout | null = null;
let flushing = false;

function isDisabled(): boolean {
  return (
    process.env["NODE_ENV"] === "test" ||
    process.env["DISABLE_TASK_SUGGESTIONS"] === "1"
  );
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void flush();
  }, DEBOUNCE_MS);
  debounceTimer.unref?.();
  // Cap the total wait so a continuous trickle still drains.
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => {
      void flush();
    }, MAX_WAIT_MS);
    maxWaitTimer.unref?.();
  }
}

async function flush(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
  // Only one flush at a time. If a flush is already running, the entries
  // currently in the map stay queued and a new flush is scheduled when the
  // running one finishes (via the re-check at the end).
  if (flushing) {
    if (pending.size > 0) scheduleFlush();
    return;
  }
  if (pending.size === 0) return;

  flushing = true;
  const batch = Array.from(pending.values());
  pending.clear();

  let regenerated = 0;
  let generated = 0;
  let skipped = 0;
  let errored = 0;
  for (const entity of batch) {
    try {
      const { outcome } = await runTaskSuggestion(entity, {
        trigger: "signal",
        mode: "regenerate",
      });
      if (outcome === "regenerated") regenerated += 1;
      else if (outcome === "generated") generated += 1;
      else skipped += 1;
    } catch (err) {
      errored += 1;
      logger.warn(
        { err, entity },
        "Signal-triggered task suggestion failed for entity",
      );
    }
  }

  logger.info(
    { count: batch.length, generated, regenerated, skipped, errored },
    "Signal-triggered task-suggestion batch processed",
  );

  flushing = false;
  // New signals may have arrived while we were flushing.
  if (pending.size > 0) scheduleFlush();
}

/** Enqueue a single entity for debounced suggestion regeneration. */
export function enqueueTaskSuggestion(entity: EntityRef): void {
  if (isDisabled()) return;
  pending.set(dedupeKeyForEntity(entity), entity);
  scheduleFlush();
}

/** Enqueue several entities at once (nulls/blank ids are ignored). */
export function enqueueTaskSuggestions(
  entities: Array<EntityRef | null | undefined>,
): void {
  if (isDisabled()) return;
  let added = false;
  for (const entity of entities) {
    if (!entity || !entity.id) continue;
    pending.set(dedupeKeyForEntity(entity), entity);
    added = true;
  }
  if (added) scheduleFlush();
}

/**
 * Convenience: enqueue the donor entity of a gift/opportunity. Task
 * suggestions target a person OR an organization; household donors have no
 * single person/org target, so they are skipped here (see follow-ups).
 */
export function enqueueDonorSignal(donor: {
  organizationId?: string | null;
  individualGiverPersonId?: string | null;
}): void {
  const refs: EntityRef[] = [];
  if (donor.organizationId) {
    refs.push({ kind: "organization", id: donor.organizationId });
  }
  if (donor.individualGiverPersonId) {
    refs.push({ kind: "person", id: donor.individualGiverPersonId });
  }
  if (refs.length) enqueueTaskSuggestions(refs);
}

/**
 * Enqueue matched people + organizations from an email/calendar match.
 * Household matches are intentionally not expanded (no person/org target).
 */
export function enqueueMatchedSignal(match: {
  personIds?: string[] | null;
  organizationIds?: string[] | null;
}): void {
  const refs: EntityRef[] = [];
  for (const id of match.personIds ?? []) {
    if (id) refs.push({ kind: "person", id });
  }
  for (const id of match.organizationIds ?? []) {
    if (id) refs.push({ kind: "organization", id });
  }
  if (refs.length) enqueueTaskSuggestions(refs);
}
