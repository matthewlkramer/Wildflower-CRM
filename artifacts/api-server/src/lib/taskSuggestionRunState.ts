import { db } from "@workspace/db";
import {
  taskSuggestionState,
  TASK_SUGGESTION_STATE_ID,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

/**
 * Shared read/write helpers for the singleton `task_suggestion_state` row.
 * Both the one-time backfill and the monthly refresh record their last run
 * here so "due" survives restarts and the result is observable without
 * trawling logs. (The signal-triggered queue is continuous and never writes
 * this row.)
 */

export type RunKind = "backfill" | "monthly" | "manual";

export interface RunCounts {
  entitiesProcessed?: number;
  suggestionsGenerated?: number;
  suggestionsRegenerated?: number;
  suggestionsSkipped?: number;
  errors?: number;
}

export async function readLastFinishedAt(): Promise<Date | null> {
  const row = await db
    .select({ lastRunFinishedAt: taskSuggestionState.lastRunFinishedAt })
    .from(taskSuggestionState)
    .where(eq(taskSuggestionState.id, TASK_SUGGESTION_STATE_ID))
    .then((r) => r[0]);
  return row?.lastRunFinishedAt ?? null;
}

export async function markRunning(kind: RunKind): Promise<void> {
  await db
    .insert(taskSuggestionState)
    .values({
      id: TASK_SUGGESTION_STATE_ID,
      lastRunKind: kind,
      lastRunStartedAt: new Date(),
      lastStatus: "running",
      lastError: null,
    })
    .onConflictDoUpdate({
      target: taskSuggestionState.id,
      set: {
        lastRunKind: kind,
        lastRunStartedAt: new Date(),
        lastStatus: "running",
        lastError: null,
        updatedAt: new Date(),
      },
    });
}

export async function markFinished(
  status: "ok" | "error",
  counts: RunCounts & { lastError?: string | null },
): Promise<void> {
  await db
    .update(taskSuggestionState)
    .set({
      lastRunFinishedAt: new Date(),
      lastStatus: status,
      entitiesProcessed: counts.entitiesProcessed ?? null,
      suggestionsGenerated: counts.suggestionsGenerated ?? null,
      suggestionsRegenerated: counts.suggestionsRegenerated ?? null,
      suggestionsSkipped: counts.suggestionsSkipped ?? null,
      errors: counts.errors ?? null,
      lastError: counts.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(taskSuggestionState.id, TASK_SUGGESTION_STATE_ID));
}
