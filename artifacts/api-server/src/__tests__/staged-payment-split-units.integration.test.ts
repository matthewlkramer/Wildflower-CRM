import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for the synthetic split-unit service
 * (stagedPaymentSplitUnits.ts — workbench-business-rules §7.2 "one QB row
 * bundles several money events"):
 *   - a split mints ≥2 children with deterministic ids `<parent>:split:<n>`,
 *     inherited payer/date/entity, pinned manual classification, NULL
 *     qb_entity_id (synthetic shape), and the parent left untouched;
 *   - children must sum to EXACTLY the parent amount in signed cents —
 *     negative units are legal (failed-payout clawback shape);
 *   - guards: <2 units, zero unit, sum mismatch, nested split, re-split,
 *     parent with live claims (cash application / settled payout pairing /
 *     non-proposed source_link);
 *   - a PROPOSED source_link on the parent is cleared, not blocking;
 *   - the parent derives `excluded` (SQL arm) while children exist; the
 *     TS deriver agrees (hasSplitChildren);
 *   - unsplit deletes claim-free children and restores the parent; claimed
 *     children block the unsplit.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `spsu_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;
const PAYOUT_ID = `${RUN}_po`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stripePayouts: Db["stripePayouts"];
  paymentApplications: Db["paymentApplications"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  organizations: Db["organizations"];
  users: Db["users"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let sqlTag: (typeof import("drizzle-orm"))["sql"];
let svc: typeof import("../lib/stagedPaymentSplitUnits");
let derived: typeof import("../lib/derivedStatus");
let ReconcileAbort: typeof import("../lib/reconciliationCommit")["ReconcileAbort"];

const stagedIds: string[] = [];
const giftIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedParent(over?: {
  amount?: string;
  payerName?: string;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: nextId("qbe"),
    amount: over?.amount ?? "1661.70",
    dateReceived: "2026-02-01",
    payerName: over?.payerName ?? "Greenfield Foundation",
    lineDescription: "Combined deposit line",
    autoApplied: false,
  });
  stagedIds.push(id);
  return id;
}

function split(
  parentId: string,
  units: import("../lib/stagedPaymentSplitUnits").SplitUnitInput[],
) {
  return db.transaction((tx) => svc.splitStagedPaymentIntoUnits(tx, parentId, units));
}

function unsplit(parentId: string) {
  return db.transaction((tx) => svc.revertStagedPaymentSplitUnits(tx, parentId));
}

/** Run `fn` expecting a ReconcileAbort; return its status + payload. */
async function abortOf(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ReconcileAbort) {
      return { status: e.httpStatus, payload: e.payload };
    }
    throw e;
  }
  throw new Error("expected ReconcileAbort, but the call succeeded");
}

/** The parent's SQL-derived status via the ONE shared CASE builder. */
async function sqlStatusOf(id: string): Promise<string> {
  const r = await db.execute(
    sqlTag`SELECT ${sqlTag.raw(derived.qbStatusCaseText("s"))} AS status
           FROM staged_payments s WHERE s.id = ${id}`,
  );
  return (r.rows[0] as { status: string }).status;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stripePayouts: dbMod.stripePayouts,
    paymentApplications: dbMod.paymentApplications,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    organizations: dbMod.organizations,
    users: dbMod.users,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  sqlTag = drizzle.sql;
  svc = await import("../lib/stagedPaymentSplitUnits");
  derived = await import("../lib/derivedStatus");
  ({ ReconcileAbort } = await import("../lib/reconciliationCommit"));

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${RUN}_clerk`,
    email: `${RUN}@wildflowerschools.org`,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Split Units Org ${RUN}`,
  });
  await db.insert(schema.stripePayouts).values({
    id: PAYOUT_ID,
    stripeAccountId: `${RUN}_acct`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  // Children reference parents; claims reference children. Peel outward-in.
  if (stagedIds.length) {
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.paymentId, stagedIds));
    await db
      .delete(schema.sourceLinks)
      .where(inArrayFn(schema.sourceLinks.qbStagedPaymentId, stagedIds));
  }
  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  // Delete children (split_parent_id set) before their parents.
  if (stagedIds.length) {
    await db
      .delete(schema.stagedPayments)
      .where(
        sqlTag`${schema.stagedPayments.splitParentId} IN (${sqlTag.join(
          stagedIds.map((s) => sqlTag`${s}`),
          sqlTag`, `,
        )})`,
      );
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  }
  await db
    .delete(schema.stripePayouts)
    .where(eqFn(schema.stripePayouts.id, PAYOUT_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
});

describe.skipIf(!HAS_DB)("staged payment split units (DB)", () => {
  it("splits into deterministic children that inherit the parent's identity fields", async () => {
    const parent = await seedParent(); // 1661.70
    const res = await split(parent, [
      { amount: "1917.70" },
      { amount: "-256.00", lineDescription: "Failed payout clawback" },
    ]);
    expect(res.parentId).toBe(parent);
    expect(res.children.map((c) => c.id)).toEqual([
      svc.splitUnitId(parent, 1),
      svc.splitUnitId(parent, 2),
    ]);

    const rows = await db
      .select()
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.splitParentId, parent));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.qbEntityId).toBeNull(); // synthetic shape (DB CHECK)
      expect(r.realmId).toBe(REALM_ID);
      expect(r.qbEntityType).toBe("deposit");
      expect(r.payerName).toBe("Greenfield Foundation"); // inherited
      expect(r.dateReceived).toBe("2026-02-01"); // inherited
      expect(r.classificationSource).toBe("manual"); // pinned vs re-classify
      expect(r.entitySource).toBe("manual");
    }
    const neg = rows.find((r) => r.amount === "-256.00");
    expect(neg?.lineDescription).toBe("Failed payout clawback"); // override

    // Parent row itself is untouched (still the QB mirror).
    const [p] = await db
      .select()
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, parent));
    expect(p!.amount).toBe("1661.70");
    expect(p!.splitParentId).toBeNull();
  });

  it("parent derives `excluded` while children exist (SQL + TS agree); unsplit restores pending", async () => {
    const parent = await seedParent({ amount: "100.00" });
    expect(await sqlStatusOf(parent)).toBe("pending");
    await split(parent, [{ amount: "60.00" }, { amount: "40.00" }]);
    expect(await sqlStatusOf(parent)).toBe("excluded");
    // TS-side deriver mirrors the SQL arm.
    expect(
      derived.deriveStagedPaymentStatus({
        exclusionReason: null,
        autoApplied: false,
        matchConfirmedAt: null,
        hasCountedApplication: false,
        hasSplitChildren: true,
      }),
    ).toBe("excluded");

    const res = await unsplit(parent);
    expect(res.removedChildIds.sort()).toEqual([
      svc.splitUnitId(parent, 1),
      svc.splitUnitId(parent, 2),
    ]);
    expect(await sqlStatusOf(parent)).toBe("pending");
    const orphans = await db
      .select({ id: schema.stagedPayments.id })
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.splitParentId, parent));
    expect(orphans).toHaveLength(0);
  });

  it("rejects units that do not sum to the parent amount → 409 split_sum_mismatch", async () => {
    const parent = await seedParent({ amount: "100.00" });
    const a = await abortOf(() =>
      split(parent, [{ amount: "60.00" }, { amount: "40.01" }]),
    );
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("split_sum_mismatch");
    expect(a.payload.unitTotal).toBe("100.01");
    expect(a.payload.parentAmount).toBe("100.00");
  });

  it("rejects fewer than 2 units and zero-amount units → 400", async () => {
    const parent = await seedParent({ amount: "100.00" });
    expect((await abortOf(() => split(parent, [{ amount: "100.00" }]))).status).toBe(400);
    expect(
      (
        await abortOf(() =>
          split(parent, [{ amount: "100.00" }, { amount: "0.00" }]),
        )
      ).status,
    ).toBe(400);
  });

  it("rejects splitting a synthetic child (no nesting) → 409 split_nested", async () => {
    const parent = await seedParent({ amount: "100.00" });
    await split(parent, [{ amount: "60.00" }, { amount: "40.00" }]);
    const child = svc.splitUnitId(parent, 1);
    const a = await abortOf(() =>
      split(child, [{ amount: "30.00" }, { amount: "30.00" }]),
    );
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("split_nested");
  });

  it("rejects re-splitting an already-split parent → 409 already_split with child ids", async () => {
    const parent = await seedParent({ amount: "100.00" });
    await split(parent, [{ amount: "60.00" }, { amount: "40.00" }]);
    const a = await abortOf(() =>
      split(parent, [{ amount: "50.00" }, { amount: "50.00" }]),
    );
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("already_split");
    expect(a.payload.childIds).toEqual([
      svc.splitUnitId(parent, 1),
      svc.splitUnitId(parent, 2),
    ]);
  });

  it("rejects a parent carrying a cash application → 409 parent_has_claims", async () => {
    const parent = await seedParent({ amount: "100.00" });
    const gift = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: gift,
      amount: "100.00",
      organizationId: ORG_ID,
    });
    giftIds.push(gift);
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: parent,
      giftId: gift,
      amountApplied: "100.00",
      evidenceSource: "quickbooks",
      linkRole: "counted",
    });
    const a = await abortOf(() =>
      split(parent, [{ amount: "60.00" }, { amount: "40.00" }]),
    );
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("parent_has_claims");
  });

  it("rejects a parent settled into a payout (the pairing fact) → 409 parent_has_claims", async () => {
    const parent = await seedParent({ amount: "100.00" });
    await db
      .update(schema.stagedPayments)
      .set({ settledStripePayoutId: PAYOUT_ID })
      .where(eqFn(schema.stagedPayments.id, parent));
    const a = await abortOf(() =>
      split(parent, [{ amount: "60.00" }, { amount: "40.00" }]),
    );
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("parent_has_claims");
  });

  it("clears a PROPOSED source_link tie but blocks on a CONFIRMED one", async () => {
    // Proposed machine guess: cleared, split proceeds.
    const p1 = await seedParent({ amount: "100.00" });
    const c1 = nextId("ch");
    await db.insert(schema.stripeStagedCharges).values({
      id: c1,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "100.00",
      dateReceived: "2026-02-01",
    });
    chargeIds.push(c1);
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", c1),
      linkType: "charge_qb_tie",
      stripeChargeId: c1,
      qbStagedPaymentId: p1,
      lifecycle: "proposed",
      provenance: "system",
    });
    await split(p1, [{ amount: "60.00" }, { amount: "40.00" }]);
    const leftover = await db
      .select({ id: schema.sourceLinks.id })
      .from(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.qbStagedPaymentId, p1));
    expect(leftover).toHaveLength(0); // guess cleared by the stronger human statement

    // Confirmed tie: blocks.
    const p2 = await seedParent({ amount: "100.00" });
    const c2 = nextId("ch");
    await db.insert(schema.stripeStagedCharges).values({
      id: c2,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "100.00",
      dateReceived: "2026-02-01",
    });
    chargeIds.push(c2);
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", c2),
      linkType: "charge_qb_tie",
      stripeChargeId: c2,
      qbStagedPaymentId: p2,
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId: USER_ID,
      confirmedAt: new Date(),
    });
    const a = await abortOf(() =>
      split(p2, [{ amount: "60.00" }, { amount: "40.00" }]),
    );
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("parent_has_claims");
  });

  it("unsplit blocks while a child carries a claim → 409 split_children_claimed", async () => {
    const parent = await seedParent({ amount: "100.00" });
    await split(parent, [{ amount: "60.00" }, { amount: "40.00" }]);
    const child = svc.splitUnitId(parent, 1);
    const ch = nextId("ch");
    await db.insert(schema.stripeStagedCharges).values({
      id: ch,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "60.00",
      dateReceived: "2026-02-01",
    });
    chargeIds.push(ch);
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", ch),
      linkType: "charge_qb_tie",
      stripeChargeId: ch,
      qbStagedPaymentId: child,
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId: USER_ID,
      confirmedAt: new Date(),
    });
    const a = await abortOf(() => unsplit(parent));
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("split_children_claimed");
    expect(a.payload.claimedChildIds).toEqual([child]);

    // Revert the claim → unsplit proceeds.
    await db
      .delete(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.qbStagedPaymentId, child));
    const res = await unsplit(parent);
    expect(res.removedChildIds).toHaveLength(2);
  });

  it("unsplit of a never-split row → 409 not_split; unknown parent → 404", async () => {
    const parent = await seedParent({ amount: "100.00" });
    const a = await abortOf(() => unsplit(parent));
    expect(a.status).toBe(409);
    expect(a.payload.code).toBe("not_split");
    const b = await abortOf(() => unsplit(`${RUN}_missing`));
    expect(b.status).toBe(404);
  });
});
