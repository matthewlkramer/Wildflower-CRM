import { fiscalYears, giftAllocations } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { newId } from "./helpers";
import type { Tx } from "./reconciliationCommit";

/**
 * Every gift MUST have at least one `gift_allocations` row — that child row is
 * where ALL money scope lives (fund entity, fiscal year, sub-amount, restriction
 * axes, region, school recipient) and revenue coding is derived from it. Several
 * mint paths historically created a header-only gift and relied on a follow-up
 * allocation edit that sometimes never happened, leaving "orphan" gifts with an
 * amount + donor but no scope (see the 0085 backfill). These helpers close that
 * gap at the source: every mint path seeds a default full-amount allocation, and
 * a cheap in-transaction backstop asserts the invariant so a future path that
 * forgets to seed fails loudly instead of committing an orphan.
 */

/**
 * Wildflower fiscal year (Jul 1 – Jun 30), named by the ending calendar year:
 * a date in Jul–Dec belongs to NEXT year's FY. Returns the `fiscal_years.id`
 * slug (e.g. '2026-03-25' → 'fy2026', '2025-11-17' → 'fy2026'), or null when the
 * date is missing/unparseable. Pure — no DB access, safe to unit-test.
 */
export function fiscalYearSlugForDate(dateReceived: string | null | undefined): string | null {
  if (!dateReceived) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateReceived);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  const fyEndYear = month >= 7 ? year + 1 : year;
  return `fy${fyEndYear}`;
}

/**
 * Insert ONE default allocation covering the whole gift, so a freshly-minted
 * header never lands scope-less. `sub_amount` = the gift amount (preserves the
 * header == sum-of-allocations invariant); `grant_year` = the fiscal year of the
 * gift date (only set when that `fiscal_years` row actually exists, so a missing
 * FY never trips the RESTRICT FK and aborts the mint — the fundraiser can fill it
 * in later). Restriction axes + `counts_toward_goal` fall back to their NOT-NULL
 * defaults unless a caller passes a signal (e.g. the QuickBooks path threads
 * `entityId` from the staged row and `countsTowardGoal` from the gov-reimbursement
 * detector). `display_usage` is left for its DB trigger to compute.
 *
 * MUST be called inside the same transaction that inserts the gift.
 */
export async function seedInitialGiftAllocation(
  tx: Tx,
  args: {
    giftId: string;
    amount: string | null;
    dateReceived: string | null;
    grantYear?: string | null;
    entityId?: string | null;
    intendedUsage?: (typeof giftAllocations.$inferInsert)["intendedUsage"];
    fundableProjectId?: string | null;
    countsTowardGoal?: boolean;
    regionalRestrictionType?: (typeof giftAllocations.$inferInsert)["regionalRestrictionType"];
    otherRestrictionType?: (typeof giftAllocations.$inferInsert)["otherRestrictionType"];
    timeRestrictionType?: (typeof giftAllocations.$inferInsert)["timeRestrictionType"];
  },
): Promise<void> {
  const candidateFy =
    args.grantYear !== undefined
      ? args.grantYear
      : fiscalYearSlugForDate(args.dateReceived);
  let grantYear: string | null = null;
  if (candidateFy) {
    const fy = await tx
      .select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(eq(fiscalYears.id, candidateFy))
      .then((r) => r[0]);
    grantYear = fy?.id ?? null;
  }

  await tx.insert(giftAllocations).values({
    id: newId(),
    giftId: args.giftId,
    subAmount: args.amount,
    grantYear,
    entityId: args.entityId ?? null,
    intendedUsage: args.intendedUsage,
    fundableProjectId:
      args.intendedUsage === "project" ? (args.fundableProjectId ?? null) : null,
    ...(args.countsTowardGoal === undefined
      ? {}
      : { countsTowardGoal: args.countsTowardGoal }),
    // Restriction axes are NOT NULL default 'unrestricted' — only override when
    // a caller actually captured a value, so the DB default still applies.
    ...(args.regionalRestrictionType
      ? { regionalRestrictionType: args.regionalRestrictionType }
      : {}),
    ...(args.otherRestrictionType
      ? { otherRestrictionType: args.otherRestrictionType }
      : {}),
    ...(args.timeRestrictionType
      ? { timeRestrictionType: args.timeRestrictionType }
      : {}),
  });
}

/**
 * Backstop invariant: a gift must never be committed with zero allocations.
 * Called at the end of every mint transaction as a cheap regression net — if a
 * (current or future) mint path forgets to seed, this throws so the whole tx
 * rolls back instead of persisting an orphan gift. One indexed COUNT on
 * gift_allocations.gift_id.
 */
export async function assertGiftHasAllocations(tx: Tx, giftId: string): Promise<void> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(giftAllocations)
    .where(eq(giftAllocations.giftId, giftId));
  if (!n || n < 1) {
    throw new Error(
      `gift_allocations invariant violated: gift ${giftId} would be committed with zero allocations`,
    );
  }
}
