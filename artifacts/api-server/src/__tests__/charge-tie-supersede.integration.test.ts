import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
  unitIdForAnchor,
} from "./paymentApplicationsTestUtil";

/**
 * DB-backed coverage for the charge-grain tie supersede
 * (chargeTieSupersede.ts — the per-charge twin of §4.3 settlement supersede):
 * when a Stripe charge of an individually-booked payout is confirmed-tied to
 * its own QB row (`linked_qb_staged_payment_id`) and the tie passes the
 * EXACT-cents same-money test (QB row amount == charge gross OR net; no
 * band), the QB row's counted gift bookings MOVE to the charge grain — a
 * marked copied stripe counted row per gift — and the QB rows demote to
 * `corroborating` (amount kept). Reverting the tie deletes ONLY the marked
 * rows and promotes the demoted QB rows back. Exercises the real tx applier
 * against dev Postgres:
 *   - confirmed tie (gross booking) → move; idempotent re-run; revert →
 *     restore,
 *   - NET-amount booking moves with the NET copied (never re-stamped gross),
 *   - override-mismatch tie (inexact) → nothing moves either direction,
 *   - pre-existing charge booking for the same gift → demote_only, and the
 *     revert never deletes the unmarked pre-existing row,
 *   - corrections-flow NULL-amount rows are never touched; a colliding
 *     corroborating crumb is cleared before demote (partial UNIQUE),
 *   - move is conservatively SKIPPED when the copy would bust the charge's
 *     gross cap (booking stays counted on the QB row),
 *   - promote drops the stale crumb when a fresh counted row raced ahead.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `ctsup_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const REALM_ID = `${RUN}_realm`;
const ORG_ID = `${RUN}_org`;
const USER_ID = `${RUN}_user`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
  paymentUnits: Db["paymentUnits"];
  organizations: Db["organizations"];
  users: Db["users"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let supersede: typeof import("../lib/chargeTieSupersede");
let pa: typeof import("../lib/paymentApplications");

const stagedIds: string[] = [];
const giftIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: "103.00",
    organizationId: ORG_ID,
    details: "Imported from QuickBooks (sales receipt).",
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: "103.00",
  });
  giftIds.push(id);
  return id;
}

/** An individually-booked QB row (one row per donation). Default 103.00 —
 * the charge GROSS. */
async function seedQbStagedPayment(over?: { amount?: string }): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "sales_receipt",
    qbEntityId: nextId("qbe"),
    amount: over?.amount ?? "103.00",
    dateReceived: "2026-03-15",
    payerName: "Jane Donor",
    autoApplied: false,
  });
  stagedIds.push(id);
  return id;
}

/**
 * Seed a QB-side tie fact for `sp`'s unit onto `gift`:
 *   counted           → the unit's own tie facts (returns the UNIT id);
 *   corroborating with an amount → a supersede demotion crumb (returns the
 *                       source_links id);
 *   corroborating with a NULL amount → a plain corrections-flow corroboration
 *                       claim (returns the source_links id).
 */
async function seedQbLedgerRow(
  sp: string,
  gift: string,
  over?: { amount?: string | null; linkRole?: "counted" | "corroborating" },
): Promise<string> {
  const unitId = await unitIdForAnchor("quickbooks", sp);
  const role = over?.linkRole ?? "counted";
  if (role === "counted") {
    await db
      .update(schema.paymentUnits)
      .set({
        giftId: gift,
        giftMatchMethod: "human",
        giftConfirmedByUserId: USER_ID,
        giftConfirmedAt: new Date("2026-03-16T00:00:00Z"),
      })
      .where(eqFn(schema.paymentUnits.id, unitId));
    return unitId;
  }
  const linkId = schema.sourceLinkId(
    "unit_gift_corroboration",
    `${unitId}_${gift}`,
  );
  if (over?.amount != null) {
    await db.transaction((tx) =>
      pa.writeSupersedeDemotionCrumb(tx, {
        paymentUnitId: unitId,
        giftId: gift,
        matchMethod: "human",
        confirmedByUserId: USER_ID,
        confirmedAt: new Date("2026-03-16T00:00:00Z"),
      }),
    );
  } else {
    await db.insert(schema.sourceLinks).values({
      id: linkId,
      linkType: "unit_gift_corroboration",
      paymentUnitId: unitId,
      giftId: gift,
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId: USER_ID,
      confirmedAt: new Date("2026-03-16T00:00:00Z"),
    });
  }
  return linkId;
}

/** A Stripe charge; tie it to a QB row by passing linkedTo. */
async function seedCharge(over?: {
  gross?: string;
  net?: string;
  linkedTo?: string | null;
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: over?.gross ?? "103.00",
    netAmount: over?.net ?? "99.71",
    dateReceived: "2026-03-14",
    crossProcessorLinkedByUserId: over?.linkedTo ? USER_ID : null,
    crossProcessorLinkedAt: over?.linkedTo ? new Date() : null,
  });
  // The tie lives ONLY in the source_links ledger (the authority).
  if (over?.linkedTo) {
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", id),
      linkType: "charge_qb_tie",
      stripeChargeId: id,
      qbStagedPaymentId: over.linkedTo,
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId: USER_ID,
      confirmedAt: new Date(),
    });
  }
  chargeIds.push(id);
  return id;
}

/** A pre-existing (unmarked) counted stripe tie on the charge's unit.
 * Returns the UNIT id. */
async function seedChargeLedgerRow(
  charge: string,
  gift: string,
  over?: { amount?: string; note?: string },
): Promise<string> {
  const unitId = await unitIdForAnchor("stripe", charge);
  await db
    .update(schema.paymentUnits)
    .set({
      giftId: gift,
      giftMatchMethod: "human",
      giftNote: over?.note ?? null,
    })
    .where(eqFn(schema.paymentUnits.id, unitId));
  return unitId;
}

/** The QB-side tie facts for `sp`'s unit: the counted unit tie (id = unit
 * id, amount = unit gross) + every unit_gift_corroboration source_link
 * (id = link id; crumbs carry the unit gross, plain claims a NULL amount). */
async function readQbRows(sp: string) {
  const units = await db
    .select({
      id: schema.paymentUnits.id,
      giftId: schema.paymentUnits.giftId,
      grossAmount: schema.paymentUnits.grossAmount,
    })
    .from(schema.paymentUnits)
    .where(eqFn(schema.paymentUnits.sourceStagedPaymentId, sp));
  const unitIds = units.map((u) => u.id);
  const links = unitIds.length
    ? await db
        .select({
          id: schema.sourceLinks.id,
          giftId: schema.sourceLinks.giftId,
          paymentUnitId: schema.sourceLinks.paymentUnitId,
          matchBasis: schema.sourceLinks.matchBasis,
        })
        .from(schema.sourceLinks)
        .where(
          andFn(
            eqFn(schema.sourceLinks.linkType, "unit_gift_corroboration"),
            inArrayFn(schema.sourceLinks.paymentUnitId, unitIds),
          ),
        )
    : [];
  const grossByUnit = new Map(units.map((u) => [u.id, u.grossAmount]));
  return [
    ...units.flatMap((u) =>
      u.giftId
        ? [
            {
              id: u.id,
              giftId: u.giftId,
              amountApplied: u.grossAmount,
              linkRole: "counted" as const,
              matchBasis: null as string | null,
            },
          ]
        : [],
    ),
    ...links.map((l) => ({
      id: l.id,
      giftId: l.giftId as string,
      amountApplied:
        l.matchBasis === "supersede_demotion"
          ? (grossByUnit.get(l.paymentUnitId as string) ?? null)
          : null,
      linkRole: "corroborating" as const,
      matchBasis: l.matchBasis as string | null,
    })),
  ];
}

/** The counted tie on the charge's unit (id = unit id). */
async function readChargeRows(charge: string) {
  const rows = await db
    .select({
      id: schema.paymentUnits.id,
      giftId: schema.paymentUnits.giftId,
      linkRole: schema.paymentUnits.giftMatchMethod,
      note: schema.paymentUnits.giftNote,
      confirmedByUserId: schema.paymentUnits.giftConfirmedByUserId,
    })
    .from(schema.paymentUnits)
    .where(eqFn(schema.paymentUnits.stripeChargeId, charge));
  return rows
    .filter((r) => r.giftId !== null)
    .map((r) => ({
      id: r.id,
      giftId: r.giftId as string,
      matchMethod: r.linkRole,
      note: r.note,
      confirmedByUserId: r.confirmedByUserId,
    }));
}

async function apply(pairs: { chargeId: string; qbStagedPaymentId: string }[]) {
  return db.transaction((tx) =>
    supersede.applyChargeTieSupersedePairs(tx, pairs),
  );
}

async function untie(charge: string) {
  await db
    .update(schema.stripeStagedCharges)
    .set({
      crossProcessorLinkedByUserId: null,
      crossProcessorLinkedAt: null,
    })
    .where(eqFn(schema.stripeStagedCharges.id, charge));
  await db
    .delete(schema.sourceLinks)
    .where(eqFn(schema.sourceLinks.id, schema.sourceLinkId("charge_qb_tie", charge)));
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stagedPayments: dbMod.stagedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
    paymentUnits: dbMod.paymentUnits,
    organizations: dbMod.organizations,
    users: dbMod.users,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;
  supersede = await import("../lib/chargeTieSupersede");
  pa = await import("../lib/paymentApplications");

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${RUN}_clerk`,
    email: `${RUN}@wildflowerschools.org`,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `ChargeTie Supersede Org ${RUN}`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await clearPaymentApplicationsForGiftIds(giftIds);
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
});

describe.skipIf(!HAS_DB)("charge-tie supersede (DB)", () => {
  it("confirmed GROSS tie moves the booking; idempotent; revert restores it", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment(); // 103.00 = gross
    const qbPaId = await seedQbLedgerRow(sp, gift);
    const ch = await seedCharge({ linkedTo: sp });

    // CONFIRMED tie → move.
    let affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);

    let qbRows = await readQbRows(sp);
    expect(qbRows).toHaveLength(1);
    expect(qbRows[0].linkRole).toBe("corroborating"); // demoted → crumb
    expect(qbRows[0].matchBasis).toBe("supersede_demotion");
    expect(qbRows[0].amountApplied).toBe("103.00");

    let chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(1);
    expect(chRows[0].giftId).toBe(gift);
    expect(chRows[0].matchMethod).toBe("charge_tie_supersede");
    expect(chRows[0].note).toBe(supersede.chargeTieSupersedeMarker(sp));
    expect(chRows[0].confirmedByUserId).toBe(USER_ID); // provenance carried

    // Idempotent re-run: converged, no-op.
    affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([]);

    // REVERT the tie → marked row deleted, QB row promoted back.
    await untie(ch);
    affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);

    qbRows = await readQbRows(sp);
    expect(qbRows).toHaveLength(1);
    expect(qbRows[0].id).toBe(qbPaId); // the tie is back on the QB unit
    expect(qbRows[0].linkRole).toBe("counted");
    expect(qbRows[0].amountApplied).toBe("103.00");
    chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(0);
  });

  it("NET-amount booking moves (exact same-money test on the NET)", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment({ amount: "99.71" }); // = net
    await seedQbLedgerRow(sp, gift, { amount: "99.71" });
    const ch = await seedCharge({ linkedTo: sp });

    const affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);

    const chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(1);
    expect(chRows[0].giftId).toBe(gift);
    expect(chRows[0].matchMethod).toBe("charge_tie_supersede");
  });

  it("override-mismatch tie (inexact) moves NOTHING in either direction", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment({ amount: "150.00" }); // ≠ gross, ≠ net
    const qbPaId = await seedQbLedgerRow(sp, gift, { amount: "150.00" });
    const ch = await seedCharge({ linkedTo: sp });

    // Confirm direction: conservative no-op.
    let affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([]);
    let qbRows = await readQbRows(sp);
    expect(qbRows[0].id).toBe(qbPaId);
    expect(qbRows[0].linkRole).toBe("counted");
    expect(await readChargeRows(ch)).toHaveLength(0);

    // Revert direction: still nothing to undo.
    await untie(ch);
    affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([]);
    qbRows = await readQbRows(sp);
    expect(qbRows[0].linkRole).toBe("counted");
  });

  it("pre-existing charge booking → demote_only; revert never deletes the unmarked row", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment();
    await seedQbLedgerRow(sp, gift);
    const ch = await seedCharge();
    // The gift was booked from the charge BEFORE the tie (e.g. Gift report).
    const preexistingId = await seedChargeLedgerRow(ch, gift);
    // The supersede pass reads the tie from source_links (the authority).
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", ch),
      linkType: "charge_qb_tie",
      stripeChargeId: ch,
      qbStagedPaymentId: sp,
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId: USER_ID,
      confirmedAt: new Date(),
    });

    let affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);

    let qbRows = await readQbRows(sp);
    expect(qbRows[0].linkRole).toBe("corroborating"); // demoted
    let chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(1); // NO copy minted
    expect(chRows[0].id).toBe(preexistingId);

    // Revert: the unmarked pre-existing booking survives; QB row promotes.
    await untie(ch);
    affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);
    qbRows = await readQbRows(sp);
    expect(qbRows[0].linkRole).toBe("counted");
    chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(1);
    expect(chRows[0].id).toBe(preexistingId);
  });

  it("corrections NULL-amount rows survive; a colliding crumb clears before demote", async () => {
    const gift = await seedGift();
    const bystanderGift = await seedGift();
    const sp = await seedQbStagedPayment();
    const countedId = await seedQbLedgerRow(sp, gift);
    // Colliding corroborating crumb for the SAME (payment, gift) pair (would
    // trip the partial UNIQUE on demote) + an unrelated NULL-amount
    // corrections annotation that must never be touched.
    const collidingId = await seedQbLedgerRow(sp, gift, {
      amount: "103.00",
      linkRole: "corroborating",
    });
    const bystanderId = await seedQbLedgerRow(sp, bystanderGift, {
      amount: null,
      linkRole: "corroborating",
    });
    const ch = await seedCharge({ linkedTo: sp });

    const affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);

    const rows = await readQbRows(sp);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The counted unit tie demoted into the crumb — which shares the
    // deterministic (unit, gift) id with the colliding seeded crumb, so the
    // demote's upsert converged both into ONE supersede_demotion claim.
    expect(rows.filter((r) => r.linkRole === "counted")).toHaveLength(0);
    expect(byId.get(collidingId)?.matchBasis).toBe("supersede_demotion");
    expect(byId.get(collidingId)?.amountApplied).toBe("103.00");
    expect(byId.get(bystanderId)?.linkRole).toBe("corroborating");
    expect(byId.get(bystanderId)?.matchBasis).toBeNull(); // untouched
    expect(byId.get(bystanderId)?.amountApplied).toBeNull();
  });

  it("move is SKIPPED when the copy would bust the charge's gross cap", async () => {
    const gift = await seedGift();
    const otherGift = await seedGift();
    const sp = await seedQbStagedPayment();
    const qbPaId = await seedQbLedgerRow(sp, gift);
    const ch = await seedCharge({ linkedTo: sp });
    // The charge's gross is already fully counted against ANOTHER gift —
    // copying 103.00 more would over-apply past the book-once cap.
    await seedChargeLedgerRow(ch, otherGift);

    const affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([]);

    const qbRows = await readQbRows(sp);
    expect(qbRows[0].id).toBe(qbPaId);
    expect(qbRows[0].linkRole).toBe("counted"); // booking stayed QB-side
    const chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(1); // no marked copy minted
  });

  it("move is SKIPPED when the charge is counted for a DIFFERENT gift within the cap", async () => {
    const gift = await seedGift();
    const otherGift = await seedGift();
    const sp = await seedQbStagedPayment();
    // NET booking (99.71) so the copy + the other gift's small counted row
    // (1.00) stay UNDER the 103.00 gross cap — the old book-once pre-check
    // alone would allow the move; the counted-uniqueness guard inside
    // applyPaymentApplication must conservatively skip it instead.
    const qbPaId = await seedQbLedgerRow(sp, gift, { amount: "99.71" });
    const ch = await seedCharge({ linkedTo: sp });
    await seedChargeLedgerRow(ch, otherGift, { amount: "1.00" });

    const affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([]);

    const qbRows = await readQbRows(sp);
    expect(qbRows[0].id).toBe(qbPaId);
    expect(qbRows[0].linkRole).toBe("counted"); // booking stayed QB-side
    const chRows = await readChargeRows(ch);
    expect(chRows).toHaveLength(1); // only the other gift's row; no copy
    expect(chRows[0].giftId).toBe(otherGift);
  });

  it("promote drops the stale crumb when a fresh counted row raced ahead", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment();
    const crumbId = await seedQbLedgerRow(sp, gift, {
      amount: "103.00",
      linkRole: "corroborating",
    });
    const freshId = await seedQbLedgerRow(sp, gift);
    const ch = await seedCharge(); // untied → revert path

    const affected = await apply([{ chargeId: ch, qbStagedPaymentId: sp }]);
    expect(affected).toEqual([gift]);

    const rows = await readQbRows(sp);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(freshId);
    expect(rows[0].linkRole).toBe("counted");
    expect(rows.find((r) => r.id === crumbId)).toBeUndefined();
  });
});
