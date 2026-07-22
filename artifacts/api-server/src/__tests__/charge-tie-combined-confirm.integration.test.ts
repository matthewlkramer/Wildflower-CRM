import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * HTTP-level coverage for the COMBINED-BOOKED arm of the charge-tie confirm
 * endpoint (POST /api/reconciliation/payouts/:id/charge-ties/confirm, Mode A):
 * when several charges were proposed onto the SAME QuickBooks row and that
 * row's amount equals their exact gross (or net) sum, confirm must:
 *   - split the shared row into synthetic per-charge units
 *     (`<parent>:split:<n>`, exact-sum enforced by the split service),
 *   - confirm each charge against ITS OWN unit (one-QB-row-per-charge
 *     invariant on the confirmed side),
 *   - leave the parent as the untouched QB mirror deriving `excluded`.
 * When the repeated row's amount matches NEITHER sum, it is drift: the whole
 * confirm must refuse with 409 duplicate_qb_tie and write NOTHING.
 *
 * Strategy mirrors finance-role-gating.integration.test.ts: the only seam
 * mocked is requireAuth (injects req.appUser as a finance user); the app runs
 * against the real dev DB. Skips when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `ctcc_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const FINANCE_ID = `${RUN}_finance`;

// Deliberately unusual cent values unique to this run.
const AMT_1 = "1717.19";
const AMT_2 = "2828.31";
const AMT_SUM = "4545.50"; // 1717.19 + 2828.31
const AMT_DRIFT = "9999.87"; // matches neither gross nor net sum

const state = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: null as any,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = state.user;
    next();
  },
}));

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stagedPayments: Db["stagedPayments"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
  users: Db["users"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let splitUnitId: (typeof import("../lib/stagedPaymentSplitUnits"))["splitUnitId"];
let server: Server;
let baseUrl = "";

const payoutIds: string[] = [];
const chargeIds: string[] = [];
const stagedIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function post(
  path: string,
  body: unknown = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedPayout(): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
  });
  payoutIds.push(id);
  return id;
}

async function seedCharge(over: {
  payoutId: string;
  grossAmount: string;
  payerName: string;
  proposedQb: string;
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: over.payoutId,
    grossAmount: over.grossAmount,
    dateReceived: "2026-03-08",
    payerName: over.payerName,
  });
  await db.insert(schema.sourceLinks).values({
    id: schema.sourceLinkId("charge_qb_tie", id),
    linkType: "charge_qb_tie",
    stripeChargeId: id,
    qbStagedPaymentId: over.proposedQb,
    lifecycle: "proposed",
    provenance: "system",
  });
  chargeIds.push(id);
  return id;
}

async function seedQbRow(amount: string): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: nextId("qbe"),
    amount,
    dateReceived: "2026-03-11",
    payerName: "Combined Deposit",
  });
  stagedIds.push(id);
  return id;
}

async function readTie(chargeId: string) {
  const rows = await db
    .select({
      lifecycle: schema.sourceLinks.lifecycle,
      qb: schema.sourceLinks.qbStagedPaymentId,
    })
    .from(schema.sourceLinks)
    .where(
      andFn(
        eqFn(schema.sourceLinks.linkType, "charge_qb_tie"),
        eqFn(schema.sourceLinks.stripeChargeId, chargeId),
      ),
    );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

async function childrenOf(parentId: string) {
  return db
    .select({
      id: schema.stagedPayments.id,
      amount: schema.stagedPayments.amount,
      qbEntityId: schema.stagedPayments.qbEntityId,
      payerName: schema.stagedPayments.payerName,
    })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.splitParentId, parentId));
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stagedPayments: dbMod.stagedPayments,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
    users: dbMod.users,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;
  ({ splitUnitId } = await import("../lib/stagedPaymentSplitUnits"));

  await db.insert(schema.users).values({
    id: FINANCE_ID,
    clerkId: `clerk_${FINANCE_ID}`,
    email: `${FINANCE_ID}@wildflowerschools.org`,
    role: "finance",
  });
  state.user = { id: FINANCE_ID, role: "finance" };

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (chargeIds.length) {
    await db
      .delete(schema.sourceLinks)
      .where(inArrayFn(schema.sourceLinks.stripeChargeId, chargeIds));
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  }
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (stagedIds.length) {
    // Children first (FK to parents).
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.splitParentId, stagedIds));
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  }
  await db.delete(schema.users).where(eqFn(schema.users.id, FINANCE_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("combined-booked charge-tie confirm (HTTP)", () => {
  it(
    "Mode A splits the shared QB row and ties each charge to its own unit",
    { timeout: 120_000 },
    async () => {
      const po = await seedPayout();
      const qb = await seedQbRow(AMT_SUM);
      const chA = await seedCharge({
        payoutId: po,
        grossAmount: AMT_1,
        payerName: "Devon Person",
        proposedQb: qb,
      });
      const chB = await seedCharge({
        payoutId: po,
        grossAmount: AMT_2,
        payerName: "Fisher Fund",
        proposedQb: qb,
      });

      const res = await post(
        `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
        {},
      );
      expect(res.status, JSON.stringify(res.json)).toBe(200);

      // The shared row was split into per-charge units with deterministic ids.
      const kids = await childrenOf(qb);
      expect(kids.map((k) => k.id).sort()).toEqual([
        splitUnitId(qb, 1),
        splitUnitId(qb, 2),
      ]);
      for (const k of kids) expect(k.qbEntityId).toBeNull(); // synthetic
      expect(kids.map((k) => k.amount).sort()).toEqual(
        [AMT_1, AMT_2].sort(),
      );

      // Each charge confirmed against ITS OWN unit — amounts line up 1:1.
      const tieA = await readTie(chA);
      const tieB = await readTie(chB);
      expect(tieA?.lifecycle).toBe("confirmed");
      expect(tieB?.lifecycle).toBe("confirmed");
      expect(tieA?.qb).not.toBe(tieB?.qb);
      const byId = new Map(kids.map((k) => [k.id, k]));
      expect(byId.get(tieA!.qb!)?.amount).toBe(AMT_1);
      expect(byId.get(tieB!.qb!)?.amount).toBe(AMT_2);

      // The parent itself carries no confirmed tie — the units do.
      const parentTies = await db
        .select({ id: schema.sourceLinks.id })
        .from(schema.sourceLinks)
        .where(eqFn(schema.sourceLinks.qbStagedPaymentId, qb));
      expect(parentTies).toHaveLength(0);
    },
  );

  it(
    "refuses drift (row amount ≠ gross AND ≠ net sum) with 409 duplicate_qb_tie, writing nothing",
    { timeout: 120_000 },
    async () => {
      const po = await seedPayout();
      const qb = await seedQbRow(AMT_DRIFT);
      const chA = await seedCharge({
        payoutId: po,
        grossAmount: AMT_1,
        payerName: "Devon Person",
        proposedQb: qb,
      });
      const chB = await seedCharge({
        payoutId: po,
        grossAmount: AMT_2,
        payerName: "Fisher Fund",
        proposedQb: qb,
      });

      const res = await post(
        `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
        {},
      );
      expect(res.status).toBe(409);
      expect(res.json?.error).toBe("duplicate_qb_tie");

      // NOTHING written: no split children, both ties still proposed.
      expect(await childrenOf(qb)).toHaveLength(0);
      expect((await readTie(chA))?.lifecycle).toBe("proposed");
      expect((await readTie(chB))?.lifecycle).toBe("proposed");
      expect((await readTie(chA))?.qb).toBe(qb);
    },
  );
});
