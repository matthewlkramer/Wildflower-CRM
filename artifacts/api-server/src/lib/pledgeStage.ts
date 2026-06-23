import { db } from "@workspace/db";
import { opportunitiesAndPledges, giftsAndPayments } from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

// ── Cultivation funnel ───────────────────────────────────────────────────────
// Stage is a pure funnel — it tracks how far the conversation has progressed,
// SEPARATE from the outcome. A WON row reads `complete`; everything else keeps
// its real funnel stage.

// Legacy commitment stages retained in the DB enum (imported / un-migrated
// rows). No longer written by the app, but recognised on read so a historical
// row still latches written_pledge correctly. `cash_in` is included: a legacy
// cash-in row is a committed pledge that merely happened to be paid, so it
// latches written_pledge and then derives status purely from payments.
const LEGACY_COMMITMENT_STAGES = new Set([
  "conditional_commitment",
  "written_commitment",
  "cash_in",
]);

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

/**
 * Canonical default win-probability (0–1, as a numeric string) for a given
 * (status, stage, conditional). Status drives the terminal categories:
 *   lost / dormant            → 0.0000
 *   cash_in                   → 1.0000
 *   pledge (unpaid written)   → 0.9000, or 0.7500 when conditional
 *   open (or null)            → by stage
 * Returns null if nothing matches (e.g. open with no stage).
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
  return null;
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
 *   written_pledge: sticky-true. Latches on a grant letter, a legacy
 *     commitment stage, or an explicit set. Never auto-cleared.
 *
 *   status (FULLY CALCULATED):
 *     loss_type set                                  → loss_type (dormant|lost)
 *     else fully paid (paid≥awarded>0)               → 'cash_in' (payment-driven only)
 *     else written_pledge                            → 'pledge' (UI: "Waiting for payment")
 *     else                                           → 'open'
 *
 *   stage (pure funnel): a WON row (status pledge/cash_in) reads 'complete';
 *     a non-won row keeps its funnel stage. A stale 'complete' on a non-won
 *     row is reverted to the pre-win funnel stage (win-reversal safety) so a
 *     later loss/dormant never shows "Complete".
 */
export function deriveOppFields(input: DeriveInput): DeriveOutput {
  const paidNum = Number(input.paidAmount ?? 0);
  const awardedNum = Number(input.awardedAmount ?? 0);
  const fullyPaid = awardedNum > 0 && paidNum >= awardedNum;

  let writtenPledge = input.writtenPledge ?? false;
  if (
    !writtenPledge &&
    (!!input.grantLetterUrl ||
      (input.stage != null && LEGACY_COMMITMENT_STAGES.has(input.stage)))
  ) {
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

  const { status, stage, writtenPledge } = deriveOppFields({
    stage: row.stage,
    lossType: row.lossType,
    writtenPledge: row.writtenPledge,
    conditional: row.conditional,
    grantLetterUrl: row.grantLetterUrl,
    awardedAmount: row.awardedAmount,
    paidAmount: paid,
  });

  const statusOrStageChanged = status !== row.status || stage !== row.stage;
  const paidChanged = Number(paid) !== Number(row.paid ?? 0);
  if (
    statusOrStageChanged ||
    writtenPledge !== row.writtenPledge ||
    paidChanged
  ) {
    // A status/stage change re-canonicalises win_probability to the default,
    // intentionally overwriting any prior user override (same rule as the
    // explicit PATCH path).
    const winProbability = statusOrStageChanged
      ? canonicalWinProbability(status, stage, row.conditional) ??
        row.winProbability
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
