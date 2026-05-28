import { db } from "@workspace/db";
import { opportunitiesAndPledges, giftsAndPayments } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

// Stages that, once reached, mark a row as "ever was a pledge" for the
// purposes of the Pledges page filter (wasPledge sticky-true).
const PLEDGE_STAGES = new Set([
  "conditional_commitment",
  "verbal_commitment",
  "written_commitment",
]);

// Canonical win-probability mapping. Status takes precedence over stage
// for the four "terminal-ish" statuses (pledge/cash_in/dormant/lost);
// for 'open' (or null), we fall through to the stage table. Values are
// stored as numeric strings to match the DB column type (NUMERIC(5,4)).
const STATUS_WIN_PROBABILITY: Record<string, string> = {
  pledge: "0.9000",
  cash_in: "1.0000",
  dormant: "0.0000",
  lost: "0.0000",
};

const STAGE_WIN_PROBABILITY: Record<string, string> = {
  cold_lead: "0.0000",
  warm_lead: "0.0500",
  in_conversation: "0.2000",
  convince: "0.4000",
  conditional_commitment: "0.7500",
  probable_renewal: "0.7500",
  verbal_commitment: "0.9000",
  written_commitment: "0.9000",
  cash_in: "1.0000",
};

/**
 * Canonical default win-probability (0–1, as a numeric string) for a
 * given (status, stage). Status overrides stage for pledge / cash_in /
 * dormant / lost; otherwise the stage drives it. Returns null if
 * nothing matches (e.g. both inputs null).
 */
export function canonicalWinProbability(
  status: string | null | undefined,
  stage: string | null | undefined,
): string | null {
  if (status && status in STATUS_WIN_PROBABILITY) {
    return STATUS_WIN_PROBABILITY[status]!;
  }
  if (stage && stage in STAGE_WIN_PROBABILITY) {
    return STAGE_WIN_PROBABILITY[stage]!;
  }
  return null;
}

export interface DeriveInput {
  stage: string | null;
  status: string | null;
  wasPledge: boolean | null;
  grantLetterUrl: string | null;
  awardedAmount: string | number | null;
  paidAmount: string | number;
}

export interface DeriveOutput {
  stage: string | null;
  status: string | null;
  wasPledge: boolean;
}

/**
 * Pure derivation of (status, stage, wasPledge) from current row state +
 * total paid against the pledge. Mirrors the logic in applyDerivedOppFields
 * so it can be unit-tested without touching the DB.
 */
export function deriveOppFields(input: DeriveInput): DeriveOutput {
  const paidNum = Number(input.paidAmount ?? 0);
  const awardedNum = Number(input.awardedAmount ?? 0);
  const fullyPaid = awardedNum > 0 && paidNum >= awardedNum;

  let wasPledge = input.wasPledge ?? false;
  if (
    !wasPledge &&
    ((input.stage && PLEDGE_STAGES.has(input.stage)) || !!input.grantLetterUrl)
  ) {
    wasPledge = true;
  }

  let status = input.status;
  if (status !== "dormant" && status !== "lost") {
    if (fullyPaid || input.stage === "cash_in") {
      status = "cash_in";
    } else if (
      input.stage === "verbal_commitment" ||
      input.stage === "written_commitment"
    ) {
      status = "pledge";
    } else {
      status = "open";
    }
  }

  let stage = input.stage;
  if (fullyPaid && stage === "written_commitment") {
    stage = "cash_in";
  }

  return { status, stage, wasPledge };
}

/**
 * Recompute the derived fields on a single opportunity/pledge row.
 *
 *   was_pledge: sticky-true. Flips false→true when stage hits any of
 *     conditional/verbal/written or when a grant letter is on file.
 *     Never auto-flipped back to false (users can clear it via PATCH).
 *
 *   status: auto-derived EXCEPT when current value is 'dormant' or
 *     'lost' (those are sticky user overrides — only cleared when the
 *     user explicitly picks a non-sticky value via PATCH).
 *       fully paid (paid≥awarded) OR stage='cash_in' → 'cash_in'
 *       stage ∈ (verbal, written)                    → 'pledge'
 *       everything else                              → 'open'
 *
 *   stage: when fully paid and currently 'written_commitment', advance
 *     to 'cash_in'. Never moves backwards or skips stages otherwise.
 *
 * Run after any mutation that touches stage, awardedAmount, status,
 * grantLetterUrl, or after a payment is recorded against this pledge.
 * Idempotent — only writes when a derived field actually changes.
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
    .where(eq(giftsAndPayments.paymentOnPledgeId, id));

  const { status, stage, wasPledge } = deriveOppFields({
    stage: row.stage,
    status: row.status,
    wasPledge: row.wasPledge,
    grantLetterUrl: row.grantLetterUrl,
    awardedAmount: row.awardedAmount,
    paidAmount: paid,
  });

  const statusOrStageChanged = status !== row.status || stage !== row.stage;
  if (statusOrStageChanged || wasPledge !== row.wasPledge) {
    // When derivation flips status or stage (e.g. written_commitment
    // auto-advances to cash_in on full payment), also recompute
    // win_probability to the canonical default. We intentionally
    // overwrite any prior user override — same rule as the explicit
    // PATCH path: a status/stage change always re-canonicalises the
    // probability.
    const winProbability = statusOrStageChanged
      ? canonicalWinProbability(status, stage) ?? row.winProbability
      : row.winProbability;
    await db
      .update(opportunitiesAndPledges)
      .set({
        status: status as typeof row.status,
        wasPledge,
        stage: stage as typeof row.stage,
        winProbability,
        updatedAt: new Date(),
      })
      .where(eq(opportunitiesAndPledges.id, id));
  }
}

// Convenience wrapper for write paths that may touch two pledges (e.g.
// a PATCH that re-points a payment from pledge A to pledge B — both
// need their derived fields recomputed).
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
