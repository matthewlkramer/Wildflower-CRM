import { describe, it, expect } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableName, is } from "drizzle-orm";
import * as schema from "@workspace/db/schema";

/**
 * Guards the contract that DELETE /gifts-and-payments/:id relies on.
 *
 * The route deletes a gift's `gift_allocations` rows (an onDelete:restrict FK)
 * inside a transaction before deleting the gift itself, because every gift
 * carries >= 1 allocation row and a raw parent delete would otherwise fail the
 * FK with a 500 (this happened in production).
 *
 * Two FKs onto gifts_and_payments.id are RESTRICT and each is handled by the
 * delete route up front:
 *   - gift_allocations.gift_id      — cleared in-txn before the gift delete.
 *   - staged_payment_splits.gift_id — a split-reconciled QuickBooks payment
 *     points at the gift; the route returns a clean 409 ("revert the split
 *     first") instead of cascading, so the staged payment never ends up with an
 *     incomplete split.
 *
 * Every OTHER FK landing on gifts_and_payments.id is onDelete:set null, so it
 * never blocks a delete and needs no cleanup. If a future schema change adds a
 * new RESTRICT (or no-action) FK onto gifts_and_payments without teaching the
 * delete handler to handle it first, that 500 silently returns — this test
 * fails first, in the same spirit as the merge-entities FK-inventory guard.
 */
function fksOntoGiftsAndPayments(): { col: string; onDelete?: string }[] {
  const out: { col: string; onDelete?: string }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    const tableName = getTableName(value);
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      if (getTableName(ref.foreignTable) !== "gifts_and_payments") continue;
      const foreignCols = ref.foreignColumns.map((c) => c.name);
      if (foreignCols.length === 1 && foreignCols[0] === "id") {
        for (const col of ref.columns) {
          out.push({ col: `${tableName}.${col.name}`, onDelete: fk.onDelete });
        }
      }
    }
  }
  return out;
}

describe("gift delete FK contract", () => {
  // The RESTRICT FKs the delete route explicitly handles up front.
  const HANDLED_RESTRICT = [
    "gift_allocations.gift_id",
    "staged_payment_splits.gift_id",
  ];

  it("only the handled FKs are RESTRICT; the delete handler must deal with each first", () => {
    const restrict = fksOntoGiftsAndPayments()
      .filter((f) => f.onDelete === "restrict")
      .map((f) => f.col)
      .sort();
    expect(restrict).toEqual([...HANDLED_RESTRICT].sort());
  });

  it("every other FK onto gifts_and_payments is set null (never blocks delete)", () => {
    const blocking = fksOntoGiftsAndPayments().filter(
      (f) => !HANDLED_RESTRICT.includes(f.col) && f.onDelete !== "set null",
    );
    expect(blocking).toEqual([]);
  });
});
