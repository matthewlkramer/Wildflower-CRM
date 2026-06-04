import { db } from "@workspace/db";
import { taskProposals, people, organizations } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { newId } from "./helpers";
import { generateTaskProposal } from "./proposeTask";

/**
 * Shared task-intelligence engine. Centralises the per-entity bookkeeping
 * (priority gate + dedupe + find/create the pending row) so that every
 * automated path — the on-demand route, the one-time backfill, the
 * signal-triggered queue, and the monthly refresh — funnels through ONE
 * entry point (`runTaskSuggestion`). The actual AI call, rate-limit retry,
 * concurrency cap, and error capture live one level down in
 * `generateTaskProposal`, so resilience is enforced in a single place.
 *
 * Invariant (see `.agents/memory/task-intelligence.md`): an automated path
 * must NEVER resurface a suggestion the user already accepted or dismissed.
 * Only an explicit user "Refresh" creates a fresh pending row after the
 * entity's last proposal was resolved. The modes below encode that:
 *   - "ensure"          (backfill)   — create only when the entity has NO
 *                                      proposal of any status; never touch an
 *                                      existing pending row (idempotent).
 *   - "regenerate"      (signal)     — regenerate an existing pending row in
 *                                      place; create one when none exists;
 *                                      skip when only resolved rows exist.
 *   - "refresh-pending" (monthly)    — only regenerate an existing pending
 *                                      row; never create a new one.
 * All modes skip low-priority entities.
 */

export type EntityRef =
  | { kind: "person"; id: string }
  | { kind: "organization"; id: string };

export type TaskSuggestionTrigger =
  | "backfill"
  | "signal"
  | "monthly"
  | "manual";

export type TaskSuggestionMode = "ensure" | "regenerate" | "refresh-pending";

export type TaskSuggestionOutcome =
  | "generated"
  | "regenerated"
  | "skipped_low_priority"
  | "skipped_not_found"
  | "skipped_resolved"
  | "skipped_exists"
  | "noop";

export interface RunResult {
  outcome: TaskSuggestionOutcome;
  proposalId?: string;
}

export function dedupeKeyForEntity(entity: EntityRef): string {
  return entity.kind === "person"
    ? `person:${entity.id}`
    : `org:${entity.id}`;
}

/**
 * Look up the entity's priority. Returns `{ found, priority }`;
 * `found:false` means the id doesn't resolve.
 */
export async function loadEntityPriority(
  entity: EntityRef,
): Promise<{ found: boolean; priority: string | null }> {
  if (entity.kind === "person") {
    const [row] = await db
      .select({ priority: people.priority })
      .from(people)
      .where(eq(people.id, entity.id))
      .limit(1);
    return { found: !!row, priority: row?.priority ?? null };
  }
  const [row] = await db
    .select({ priority: organizations.priority })
    .from(organizations)
    .where(eq(organizations.id, entity.id))
    .limit(1);
  return { found: !!row, priority: row?.priority ?? null };
}

export async function findPendingProposal(
  dedupeKey: string,
): Promise<typeof taskProposals.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(taskProposals)
    .where(
      and(
        eq(taskProposals.dedupeKey, dedupeKey),
        eq(taskProposals.status, "pending"),
      ),
    )
    .limit(1);
  return row;
}

/**
 * True when ANY proposal (pending or resolved) already exists for this
 * entity — used to distinguish a true first touch from a return after the
 * user already accepted/dismissed a suggestion (don't silently resurface).
 */
export async function hasAnyProposal(dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: taskProposals.id })
    .from(taskProposals)
    .where(eq(taskProposals.dedupeKey, dedupeKey))
    .limit(1);
  return !!row;
}

export async function loadProposalById(
  id: string,
): Promise<typeof taskProposals.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(taskProposals)
    .where(eq(taskProposals.id, id))
    .limit(1);
  return row;
}

/**
 * Create a fresh pending row for an entity and run AI generation in place.
 * Uses onConflictDoNothing against the partial-unique pending index to win
 * the race when two callers fire simultaneously — the loser re-reads the
 * winner's row.
 */
export async function createAndGenerate(
  entity: EntityRef,
  dedupeKey: string,
): Promise<typeof taskProposals.$inferSelect | undefined> {
  const id = newId();
  const inserted = await db
    .insert(taskProposals)
    .values({
      id,
      status: "pending",
      targetPersonId: entity.kind === "person" ? entity.id : null,
      targetOrganizationId: entity.kind === "organization" ? entity.id : null,
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    // Lost the race — another caller already created the pending row.
    return findPendingProposal(dedupeKey);
  }

  await generateTaskProposal(id);
  return loadProposalById(id);
}

/**
 * THE shared automated-generation entry point. Applies the priority gate +
 * dedupe + resolved-suppression invariant for the given mode, then delegates
 * the AI call to `generateTaskProposal`. Never throws — generation failures
 * are recorded on the row by `generateTaskProposal`; lookup/priority issues
 * are returned as a skip outcome.
 */
export async function runTaskSuggestion(
  entity: EntityRef,
  opts: { trigger: TaskSuggestionTrigger; mode: TaskSuggestionMode },
): Promise<RunResult> {
  const dedupeKey = dedupeKeyForEntity(entity);

  const { found, priority } = await loadEntityPriority(entity);
  if (!found) return { outcome: "skipped_not_found" };
  if (priority === "low") return { outcome: "skipped_low_priority" };

  const existing = await findPendingProposal(dedupeKey);
  if (existing) {
    if (opts.mode === "ensure") {
      // Idempotent backfill: a pending suggestion already exists — leave it.
      return { outcome: "skipped_exists", proposalId: existing.id };
    }
    // "regenerate" / "refresh-pending": rerun generation in place.
    await generateTaskProposal(existing.id);
    return { outcome: "regenerated", proposalId: existing.id };
  }

  // No pending row.
  if (opts.mode === "refresh-pending") {
    // Monthly refresh only touches existing pending rows.
    return { outcome: "noop" };
  }

  // "ensure" / "regenerate": create on a true first touch only. If the
  // entity already had a proposal that was resolved (accepted/dismissed),
  // respect that resolution and do not auto-resurface.
  if (await hasAnyProposal(dedupeKey)) {
    return { outcome: "skipped_resolved" };
  }

  const row = await createAndGenerate(entity, dedupeKey);
  return { outcome: "generated", proposalId: row?.id };
}
