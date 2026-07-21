import { alias } from "drizzle-orm/pg-core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  opportunitiesAndPledges,
  pledgeAllocations,
} from "@workspace/db/schema";
import type { Tx } from "./reconciliationCommit";
import { quotedSqlAlias } from "./derivedStatus";

/**
 * SINGLE SOURCE OF TRUTH for a pledge's remaining capacity (its uncollected
 * remainder):
 *
 *   capacity = committed + writtenOff − paid, rounded to whole cents
 *
 * where
 *   committed  = SUM of the pledge's own allocation sub-amounts,
 *   writtenOff = SUM of the allocation sub-amounts of its ACTIVE (non-archived)
 *                write-off children (write-off allocations are NEGATIVE, so
 *                adding them shrinks the remainder),
 *   paid       = SUM of non-archived linked gift amounts (the persisted
 *                `opportunities_and_pledges.paid` rollup mirrors this exact
 *                sum — see applyDerivedOppFields).
 *
 * This one figure is the write-off dialog prefill, the server-enforced CAP on
 * a write-off's chosen amount, and the audit-close "underpaid pledge"
 * predicate (capacity > 0 flags). It is NOT clamped here — the write-off
 * route treats `<= 0` as "nothing to write off"; display layers clamp at 0.
 *
 * TWO REPRESENTATIONS, ONE SOURCE (same pattern as derivedStatus.ts):
 *   1. `pledgeCapacity(...)` — the pure TS formula (cents rounding pinned by
 *      unit test).
 *   2. `pledgeWrittenOffSumText(alias)` — the alias-parameterized SQL text for
 *      the writtenOff bucket, for raw-SQL contexts that need the same bucket
 *      inside GROUP BY / HAVING / ORDER BY.
 */

/** The canonical capacity formula: committed + writtenOff − paid, rounded to
 *  whole cents. `writtenOff` is expected to be ≤ 0 (write-off allocations are
 *  negative). Accepts numeric strings straight off SQL SUM()::text results. */
export function pledgeCapacity(
  committed: number | string,
  writtenOff: number | string,
  paid: number | string,
): number {
  return (
    Math.round((Number(committed) + Number(writtenOff) - Number(paid)) * 100) /
    100
  );
}

/** Internal subquery aliases carry the reserved `_ds` suffix so
 *  `quotedSqlAlias` rejects them as caller aliases (no collision possible). */
const WRITE_OFF_CHILD_ALIAS = "wo_ds";
const WRITE_OFF_ALLOC_ALIAS = "wpa_ds";

/**
 * Alias-parameterized SQL text: the SUM of active write-off children's
 * allocation sub-amounts for the pledge row `alias` (COALESCEd to 0, no cast).
 * Write-off allocations are negative, so this term is ≤ 0. Matches the
 * `writtenOff` bucket of `pledgeCapacity` exactly (archived children
 * excluded).
 */
export function pledgeWrittenOffSumText(aliasName: string): string {
  if (
    aliasName === WRITE_OFF_CHILD_ALIAS ||
    aliasName === WRITE_OFF_ALLOC_ALIAS
  ) {
    throw new Error(
      `pledgeCapacity: table alias ${JSON.stringify(aliasName)} is reserved for the builder's internal subquery`,
    );
  }
  const a = quotedSqlAlias(aliasName);
  return `COALESCE((SELECT SUM("${WRITE_OFF_ALLOC_ALIAS}"."sub_amount")
    FROM "pledge_allocations" "${WRITE_OFF_ALLOC_ALIAS}"
    JOIN "opportunities_and_pledges" "${WRITE_OFF_CHILD_ALIAS}"
      ON "${WRITE_OFF_ALLOC_ALIAS}"."pledge_or_opportunity_id" = "${WRITE_OFF_CHILD_ALIAS}"."id"
    WHERE "${WRITE_OFF_CHILD_ALIAS}"."write_off_of_pledge_id" = ${a}."id"
      AND "${WRITE_OFF_CHILD_ALIAS}"."archived_at" IS NULL), 0)`;
}

/** Either the root drizzle handle or an open transaction — lets the write-off
 * route run every read inside its locked transaction (the app-level guards are
 * the only concurrency protection now that multiple write-offs are legal). */
type Dbc = Tx | typeof db;

/**
 * A pledge's uncollected remainder, DERIVED server-side via the canonical
 * `pledgeCapacity` formula (see the module doc above for bucket definitions
 * and clamping semantics). Pass the open transaction from the write-off route
 * so the cap is computed under its row lock.
 */
export async function computePledgeUncollectedRemainder(
  pledgeId: string,
  dbc: Dbc = db,
): Promise<number> {
  const [{ committed } = { committed: "0" }] = await dbc
    .select({
      committed: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
    })
    .from(pledgeAllocations)
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, pledgeId));
  const [{ paid } = { paid: "0" }] = await dbc
    .select({
      paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
    })
    .from(giftsAndPayments)
    .where(
      and(
        eq(giftsAndPayments.opportunityId, pledgeId),
        isNull(giftsAndPayments.archivedAt),
      ),
    );
  const writeOffChild = alias(opportunitiesAndPledges, "write_off_child");
  const [{ writtenOff } = { writtenOff: "0" }] = await dbc
    .select({
      writtenOff: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
    })
    .from(pledgeAllocations)
    .innerJoin(
      writeOffChild,
      eq(pledgeAllocations.pledgeOrOpportunityId, writeOffChild.id),
    )
    .where(
      and(
        eq(writeOffChild.writeOffOfPledgeId, pledgeId),
        isNull(writeOffChild.archivedAt),
      ),
    );
  return pledgeCapacity(committed, writtenOff, paid);
}
