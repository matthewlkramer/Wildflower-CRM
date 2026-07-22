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

// When a win is undone we cannot recover the exact pre-win funnel stage (it was
// overwritten by `complete`), so we revert to the terminal funnel stage. This
// keeps win-reversal safe: a later loss/dormant never shows "Complete".
const PRE_WIN_STAGE = "verbal_confirmation";

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
  const conditionalAllocs = allocs.filter((a) => isConditionalPledge(a.conditional));
  if (conditionalAllocs.length === 0) {
    return { conditional: "unconditional", conditionsMet: "yes" };
  }
  // Deterministic representative value (sorted) so repeated derivations agree.
  const conditional = [...conditionalAllocs]
    .map((a) => a.conditional!)
    .sort()[0]!;
  const conditionsMet = conditionalAllocs.every((a) => a.conditionsMet === "yes")
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
  // User-set override (null | 'dormant' | 'lost'). When set, status mirrors it;
  // otherwise status is computed from written_pledge + payments.
  lossType: string | null;
  // Sticky commitment flag (renamed from writtenPledge). Drives status='pledge'.
  writtenPledge: boolean | null;
  conditional: string | null;
  grantLetterUrl: string | null;
  awardedAmount: string | number | null;
  paidAmount: string | number;
  // Task #788 — how the money is disbursed. fixed_commitment completes via
  // paid >= awarded; cost_reimbursement completes ONLY via awardClosedAt.
  disbursementModel: string | null;
  // Second user-set lifecycle input (alongside lossType): the explicit
  // award-closure date on a cost-reimbursement pledge. Non-null = complete.
  awardClosedAt: string | Date | null;
}

export interface DeriveOutput {
  stage: string | null;
  // Fully calculated — never an input.
  status: string | null;
  writtenPledge: boolean;
}

/**
 * Pure derivation of (status, stage, writtenPledge) from current row state +
 * total paid against the opportunity. Mirrors applyDerivedOppFields so it can
 * be unit-tested without the DB.
 *
 *   written_pledge: sticky-true. Latches ONLY on a grant letter (and only
 *     while the money is not already fully in) or an explicit set. Receiving
 *     payment (cash-in) and legacy commitment stages never latch it. Never
 *     auto-cleared.
 *
 *   status (FULLY CALCULATED):
 *     loss_type set                                  → loss_type (dormant|lost)
 *     else "fully collected" (see below)             → 'cash_in'
 *     else written_pledge                            → 'pledge' (UI: "Waiting for payment")
 *     else                                           → 'open'
 *
 *   "fully collected" depends on the disbursement model (Task #788):
 *     fixed_commitment  → paid >= awarded > 0 (payment-driven, unchanged)
 *     cost_reimbursement → award_closed_at IS NOT NULL (explicit Close-award
 *       action only — paid >= ceiling NEVER completes a reimbursement award)
 *
 *   stage (pure funnel): a WON row (status pledge/cash_in) reads 'complete';
 *     a non-won row keeps its funnel stage. A stale 'complete' on a non-won
 *     row is reverted to the pre-win funnel stage (win-reversal safety) so a
 *     later loss/dormant never shows "Complete".
 */
export function deriveOppFields(input: DeriveInput): DeriveOutput {
  const paidNum = Number(input.paidAmount ?? 0);
  const awardedNum = Number(input.awardedAmount ?? 0);
  const isCostReimbursement = input.disbursementModel === "cost_reimbursement";
  // Fixed commitments complete when the money is fully in; cost-reimbursement
  // awards complete ONLY via the explicit Close-award action (the ceiling is
  // informational — paid >= ceiling never completes one).
  const fullyPaid = isCostReimbursement
    ? input.awardClosedAt != null
    : awardedNum > 0 && paidNum >= awardedNum;

  // A record becomes a (sticky) written pledge ONLY when it carries a genuine
  // written commitment — a grant letter — and the money has not already fully
  // landed. A gift you were merely told about (no grant letter), or a grant
  // whose payment already arrived, is NOT a pledge.
  let writtenPledge = input.writtenPledge ?? false;
  if (!writtenPledge && !!input.grantLetterUrl && !fullyPaid) {
    writtenPledge = true;
  }

  let status: string;
  if (input.lossType === "dormant" || input.lossType === "lost") {
    status = input.lossType;
  } else if (fullyPaid) {
    status = "cash_in";
  } else if (writtenPledge) {
    status = "pledge";
  } else {
    status = "open";
  }

  // A won row reads `complete`; otherwise keep the funnel stage but never leave
  // a stale `complete` on a non-won row.
  const won = status === "pledge" || status === "cash_in";
  let stage = input.stage;
  if (won) {
    stage = "complete";
  } else if (stage === "complete") {
    stage = PRE_WIN_STAGE;
  }

  return { status, stage, writtenPledge };
}

/**
 * Recompute the derived fields on a single opportunity/pledge row by calling
 * the same derivation the pure helper uses. Also recomputes the persisted
 * `paid` rollup (SUM of linked non-archived gift amounts). Idempotent — only
 * writes when a derived field actually changes.
 *
 * Run after any mutation that touches stage, awardedAmount, lossType,
 * conditional, written_pledge, grantLetterUrl, or after a payment is recorded /
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

  const [{ paid } = { paid: "0" }] = await db
    .select({
      paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
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

  const { status, stage, writtenPledge } = deriveOppFields({
    stage: row.stage,
    lossType: row.lossType,
    writtenPledge: row.writtenPledge,
    conditional: rollup.conditional,
    grantLetterUrl: row.grantLetterUrl,
    awardedAmount: row.awardedAmount,
    paidAmount: paid,
    disbursementModel: row.disbursementModel,
    awardClosedAt: row.awardClosedAt,
  });

  const statusOrStageChanged = status !== row.status || stage !== row.stage;
  const paidChanged = Number(paid) !== Number(row.paid ?? 0);
  // Re-canonicalise win-probability when status/stage changes OR when the
  // allocation-driven conditional rollup would change the pledge weight (an
  // allocation edit re-stamps win_probability even if status is unchanged).
  const canonicalWp = canonicalWinProbability(status, stage, rollup.conditional);
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
        ? canonicalWp ?? row.winProbability
        : row.winProbability;
    await db
      .update(opportunitiesAndPledges)
      .set({
        status: status as typeof row.status,
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
