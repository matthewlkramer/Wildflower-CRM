import { db } from "@workspace/db";
import {
  opportunitiesAndPledges,
  giftsAndPayments,
  pledgeAllocations,
} from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

// ── Cultivation funnel ───────────────────────────────────────────────────────
// Stage is a pure funnel — it tracks how far the conversation has progressed,
// SEPARATE from the outcome. A WON row reads `complete`; everything else keeps
// its real funnel stage.

// Legacy commitment stages (`conditional_commitment`, `written_commitment`,
// `cash_in`) are retained in the DB enum for imported / un-migrated rows but
// are NO LONGER written by the app and NO LONGER latch written_pledge.
// Receiving money or reaching one of these stages does not make a record a
// pledge — only a genuine written commitment does (see deriveOppFields).

// `complete` is retained only for imported rows. New lifecycle derivation never
// overwrites the cultivation stage; imported complete rows normalize to the
// final meaningful opportunity stage.
const LEGACY_COMPLETE_STAGE = "verbal_confirmation";

// ── Win-probability weighting ────────────────────────────────────────────────
// Open opps weight by stage. A written pledge that isn't fully paid is its own
// weighted category (non-conditional 90% / conditional 75%). Paid = 100%,
// lost/dormant = 0%.
const STAGE_WIN_PROBABILITY: Record<string, string> = {
  cold_lead: "0.0000",
  warm_lead: "0.0500",
  in_conversation: "0.2000",
  convince: "0.4000",
  probable_renewal: "0.7500",
  verbal_confirmation: "0.9000",
  // Legacy stages retained for historical rows.
  conditional_commitment: "0.7500",
  written_commitment: "0.9000",
  cash_in: "1.0000",
  complete: "1.0000",
};

const WRITTEN_PLEDGE_WEIGHT = "0.9000";
const WRITTEN_PLEDGE_CONDITIONAL_WEIGHT = "0.7500";

// A written pledge counts as "conditional" (weighted 75%) only for the
// genuinely-uncertain conditional kinds. `unconditional`, `reimbursable`, and
// null are treated as non-conditional (90%).
export function isConditionalPledge(
  conditional: string | null | undefined,
): boolean {
  return (
    conditional === "conditional_unspecified" ||
    conditional === "conditional_on_funder_determination" ||
    conditional === "conditional_on_target"
  );
}

export interface ConditionalRollup {
  // Representative conditional value across the opportunity's pledge
  // allocations: a conditional kind when ANY allocation is conditional, else
  // 'unconditional'. Null when the opportunity has no allocations at all.
  conditional: string | null;
  // 'yes' only when every conditional allocation has its conditions met;
  // vacuously 'yes' when there are no conditional allocations.
  conditionsMet: "yes" | "no";
}

/**
 * Pure rollup of allocation-level grant conditions to the opportunity header.
 * Shared by the per-row DB reader below AND the bulk derivation health check,
 * so there is exactly one rollup implementation.
 */
export function rollupConditional(
  allocs: Array<{ conditional: string | null; conditionsMet: string | null }>,
): ConditionalRollup {
  if (allocs.length === 0) return { conditional: null, conditionsMet: "yes" };
  const conditionalAllocs = allocs.filter((a) =>
    isConditionalPledge(a.conditional),
  );
  if (conditionalAllocs.length === 0) {
    return { conditional: "unconditional", conditionsMet: "yes" };
  }
  // Deterministic representative value (sorted) so repeated derivations agree.
  const conditional = [...conditionalAllocs]
    .map((a) => a.conditional!)
    .sort()[0]!;
  const conditionsMet = conditionalAllocs.every(
    (a) => a.conditionsMet === "yes",
  )
    ? "yes"
    : "no";
  return { conditional, conditionsMet };
}

/**
 * Derive the header-level conditional rollup from an opportunity's pledge
 * allocations (Task #449 — grant conditions moved off the opportunity header
 * onto the allocations). Drives win-probability weighting.
 */
export async function deriveConditionalRollup(
  opportunityId: string,
): Promise<ConditionalRollup> {
  const allocs = await db
    .select({
      conditional: pledgeAllocations.conditional,
      conditionsMet: pledgeAllocations.conditionsMet,
    })
    .from(pledgeAllocations)
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId));
  return rollupConditional(allocs);
}

/**
 * Canonical default win-probability (0–1, as a numeric string) for a given
 * (status, stage, conditional). Status drives the terminal categories:
 *   lost / dormant            → 0.0000
 *   cash_in                   → 1.0000
 *   pledge (unpaid written)   → 0.9000, or 0.7500 when conditional
 *   open (or null)            → by stage; no stage → 0.0000 (an unstaged ask
 *                               carries no funnel signal — weight it like a
 *                               cold lead, never NULL)
 * Never returns null: every (status, stage) combination has a canonical
 * weight, so derivation can always persist a non-NULL win_probability.
 */
export function canonicalWinProbability(
  status: string | null | undefined,
  stage: string | null | undefined,
  conditional?: string | null,
): string | null {
  if (status === "lost" || status === "dormant") return "0.0000";
  if (status === "cash_in") return "1.0000";
  if (status === "pledge") {
    return isConditionalPledge(conditional)
      ? WRITTEN_PLEDGE_CONDITIONAL_WEIGHT
      : WRITTEN_PLEDGE_WEIGHT;
  }
  if (stage && stage in STAGE_WIN_PROBABILITY) {
    return STAGE_WIN_PROBABILITY[stage]!;
  }
  // Open (or not-yet-derived) row with no funnel stage. Every stage enum value
  // is in the map, so this is the only remaining path — weight it 0 like a
  // cold lead instead of returning NULL (analytics used to silently count
  // these at 100%).
  return "0.0000";
}

export interface DeriveInput {
  stage: string | null;
  lossType: string | null;
  commitmentPath?: string | null;
  verbalCommitmentAt?: string | Date | null;
  pledgeCommittedAt?: string | Date | null;
  writtenPledge?: boolean | null;
  conditional: string | null;
  grantLetterUrl: string | null;
  awardedAmount: string | number | null;
  paidAmount: string | number;
  firstPaymentDate?: string | Date | null;
  actualCompletionDate?: string | Date | null;
  disbursementModel: string | null;
  awardClosedAt: string | Date | null;
}

export interface DeriveOutput {
  stage: string | null;
  status: string | null;
  commitmentPath: string | null;
  verbalCommitmentAt: string | Date | null;
  pledgeCommittedAt: string | Date | null;
  actualCompletionDate: string | Date | null;
  writtenPledge: boolean;
}

/**
 * Pure derivation of lifecycle outputs from the stored cultivation facts and
 * linked money.
 *
 * - `pledgeCommittedAt` is the authoritative pledge boundary. The legacy
 *   `writtenPledge` boolean is accepted only as a temporary import fallback and
 *   is emitted as a read-compatible mirror.
 * - Money without a finalized pledge is an actual gift outcome. It does not
 *   manufacture `commitmentPath` or `verbalCommitmentAt`; those fields exist
 *   only when a fundraiser recorded the preceding verbal commitment.
 * - Cultivation `stage` is preserved. Deprecated outcome-like stages are
 *   normalized to `verbal_confirmation`, but pledge finalization and payment do
 *   not overwrite the funnel history.
 * - Fixed pledges complete when paid >= awarded. Cost-reimbursement awards
 *   complete only through the explicit award-close action.
 */
export function deriveOppFields(input: DeriveInput): DeriveOutput {
  const paidNum = Number(input.paidAmount ?? 0);
  const awardedNum = Number(input.awardedAmount ?? 0);
  const hasPayment = Number.isFinite(paidNum) && paidNum > 0;

  let commitmentPath = input.commitmentPath ?? null;
  let verbalCommitmentAt = input.verbalCommitmentAt ?? null;
  let pledgeCommittedAt = input.pledgeCommittedAt ?? null;
  let actualCompletionDate = input.actualCompletionDate ?? null;

  // Transitional compatibility for tests/imports created before migration
  // 0224. Production data is backfilled; new API writes cannot set this flag.
  const legacyPledge =
    pledgeCommittedAt == null &&
    commitmentPath == null &&
    input.writtenPledge === true;
  const isPledge = pledgeCommittedAt != null || legacyPledge;

  if (!isPledge && hasPayment) {
    // Money establishes an actual gift outcome. A prior verbal commitment is a
    // separate historical fact and must not be invented from the payment date.
    actualCompletionDate =
      actualCompletionDate ?? input.firstPaymentDate ?? null;
  }

  const isCostReimbursement = input.disbursementModel === "cost_reimbursement";
  const fullyCollected = isPledge
    ? isCostReimbursement
      ? input.awardClosedAt != null
      : awardedNum > 0 && paidNum >= awardedNum
    : hasPayment && (awardedNum <= 0 || paidNum >= awardedNum);

  let status: string;
  if (input.lossType === "dormant" || input.lossType === "lost") {
    status = input.lossType;
  } else if (fullyCollected) {
    status = "cash_in";
  } else if (isPledge) {
    status = "pledge";
  } else {
    status = "open";
  }

  const legacyOutcomeStage =
    input.stage === "complete" ||
    input.stage === "cash_in" ||
    input.stage === "written_commitment" ||
    input.stage === "conditional_commitment";
  // Stage records cultivation progress, not the outcome. Normalize imported
  // outcome-like legacy stages once, then preserve the real funnel position.
  const stage = legacyOutcomeStage ? LEGACY_COMPLETE_STAGE : input.stage;

  return {
    status,
    stage,
    commitmentPath,
    verbalCommitmentAt,
    pledgeCommittedAt,
    actualCompletionDate,
    writtenPledge: isPledge,
  };
}

/**
 * Recompute the derived fields on a single opportunity/pledge row by calling
 * the same derivation the pure helper uses. Also recomputes the persisted
 * `paid` rollup (SUM of linked non-archived gift amounts). Idempotent — only
 * writes when a derived field actually changes.
 *
 * Run after any mutation that touches stage, awardedAmount, lossType,
 * commitment lifecycle fields, grant documentation, or after a payment is recorded /
 * archived / re-pointed against this opportunity.
 */
export async function applyDerivedOppFields(
  id: string | null | undefined,
): Promise<void> {
  if (!id) return;
  const row = await db
    .select()
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, id))
    .then((r) => r[0]);
  if (!row) return;

  const [{ paid, firstPaymentDate } = { paid: "0", firstPaymentDate: null }] =
    await db
      .select({
        paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
        firstPaymentDate: sql<
          string | null
        >`MIN(${giftsAndPayments.dateReceived})`,
      })
      .from(giftsAndPayments)
      .where(
        and(
          eq(giftsAndPayments.opportunityId, id),
          // Archived gifts are logically deleted and excluded from analytics
          // totals; keep paid derivation consistent so an archived payment can't
          // keep an opportunity derived as cash_in.
          isNull(giftsAndPayments.archivedAt),
        ),
      );

  // Grant conditions now live on the pledge allocations; the header conditional
  // is a derived rollup (conditional when ANY allocation is conditional). It
  // drives win-probability weighting (90% non-conditional / 75% conditional).
  const rollup = await deriveConditionalRollup(id);

  const derived = deriveOppFields({
    stage: row.stage,
    lossType: row.lossType,
    commitmentPath: row.commitmentPath,
    verbalCommitmentAt: row.verbalCommitmentAt,
    pledgeCommittedAt: row.pledgeCommittedAt,
    writtenPledge: row.writtenPledge,
    conditional: rollup.conditional,
    grantLetterUrl: row.grantLetterUrl,
    awardedAmount: row.awardedAmount,
    paidAmount: paid,
    firstPaymentDate,
    actualCompletionDate: row.actualCompletionDate,
    disbursementModel: row.disbursementModel,
    awardClosedAt: row.awardClosedAt,
  });
  const {
    status,
    stage,
    writtenPledge,
    commitmentPath,
    verbalCommitmentAt,
    pledgeCommittedAt,
    actualCompletionDate,
  } = derived;

  const statusOrStageChanged = status !== row.status || stage !== row.stage;
  const lifecycleChanged =
    commitmentPath !== row.commitmentPath ||
    verbalCommitmentAt !== row.verbalCommitmentAt ||
    pledgeCommittedAt !== row.pledgeCommittedAt ||
    actualCompletionDate !== row.actualCompletionDate;
  const paidChanged = Number(paid) !== Number(row.paid ?? 0);
  // Re-canonicalise win-probability when status/stage changes OR when the
  // allocation-driven conditional rollup would change the pledge weight (an
  // allocation edit re-stamps win_probability even if status is unchanged).
  const canonicalWp = canonicalWinProbability(
    status,
    stage,
    rollup.conditional,
  );
  const winProbabilityChanged =
    (status === "pledge" &&
      canonicalWp !== null &&
      canonicalWp !== row.winProbability) ||
    // Null-heal: a row must never carry a NULL weight (the analytics rollups
    // no longer COALESCE around one). NULL is not a legitimate hand-set
    // override, so stamping the canonical value here never clobbers a user
    // choice — open rows with a stored value stay untouched.
    (row.winProbability == null && canonicalWp !== null);
  if (
    statusOrStageChanged ||
    lifecycleChanged ||
    writtenPledge !== row.writtenPledge ||
    paidChanged ||
    winProbabilityChanged
  ) {
    // A status/stage change re-canonicalises win_probability to the default,
    // intentionally overwriting any prior user override (same rule as the
    // explicit PATCH path). An allocation-driven conditional change does the
    // same so the pledge weight tracks its conditions.
    const winProbability =
      statusOrStageChanged || winProbabilityChanged
        ? (canonicalWp ?? row.winProbability)
        : row.winProbability;
    await db
      .update(opportunitiesAndPledges)
      .set({
        status: status as typeof row.status,
        commitmentPath: commitmentPath as typeof row.commitmentPath,
        verbalCommitmentAt:
          verbalCommitmentAt == null
            ? null
            : String(verbalCommitmentAt).slice(0, 10),
        pledgeCommittedAt:
          pledgeCommittedAt == null
            ? null
            : String(pledgeCommittedAt).slice(0, 10),
        actualCompletionDate:
          actualCompletionDate == null
            ? null
            : String(actualCompletionDate).slice(0, 10),
        writtenPledge,
        stage: stage as typeof row.stage,
        winProbability,
        paid,
        updatedAt: new Date(),
      })
      .where(eq(opportunitiesAndPledges.id, id));
  }
}

// Convenience wrapper for write paths that may touch two opportunities (e.g. a
// PATCH that re-points a payment from opp A to opp B — both need recompute).
export async function applyDerivedOppFieldsMany(
  ...ids: Array<string | null | undefined>
): Promise<void> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      await applyDerivedOppFields(id);
    }
  }
}
