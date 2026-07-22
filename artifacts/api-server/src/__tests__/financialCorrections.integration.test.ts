import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  derivedSettledAmountForGift,
  hasLinkedPaymentForGift,
} from "../lib/giftPaymentSummary";

/**
 * End-to-end coverage for the admin-only financial-corrections review queue
 * (routes/financialCorrections.ts), the propose-then-confirm layer that makes
 * evidence↔gift many-to-many (INV-5/6, §4.2/§4.8) without breaking book-once.
 *
 * Determinism against the populated dev DB:
 *   - Detector A (merge_gifts) groups by a per-donor key, so a UNIQUE seeded
 *     organisation can never collide with real data regardless of date. We seed
 *     two gifts for one unique org on one (far-future) date and locate the
 *     proposal by its canonical key.
 *   - The detector caps results only in the HTTP route (limit 500); the exported
 *     `detectFinancialCorrections(limit)` takes the limit directly, so we call it
 *     with a huge limit to find our proposal by key even if real data produces
 *     many other corrections. The HTTP path is still exercised for 200 + admin
 *     gating + the apply round-trips.
 *
 * Asserts:
 *   - non-admins get 403 on the list and apply endpoints
 *   - an admin GET returns 200 with a corrections array (exercises all detector
 *     SQL against the real dev dataset — catches runtime SQL errors typecheck
 *     can't)
 *   - the seeded same-donor/same-date pair surfaces as a merge_gifts proposal
 *     with a survivor suggestion
 *   - apply link_evidence corroborates many gifts with one evidence row, is
 *     idempotent, and NEVER edits the QuickBooks source (book-once preserved:
 *     the gifts' counted pointers and the staged row's gift pointers stay null)
 *   - apply rejects an unknown evidence row (404) and unknown gifts (400)
 *
 * Only the Clerk auth gate (`requireAuth`) is mocked, injecting a mutable app
 * user so each test can switch viewer/role. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `fcspec_${Date.now()}`;
const OTHER_ID = `${RUN}_other`;
const ADMIN_ID = `${RUN}_admin`;

// Detector A (merge) fixture: one unique org, two gifts on one date.
const ORG_M = `${RUN}_orgm`;
const GIFT_M1 = `${RUN}_giftm1`;
const GIFT_M2 = `${RUN}_giftm2`;
const MERGE_DATE = "2099-12-30";

// link_evidence apply fixture: two donors' gifts + one staged QB deposit whose
// amount deliberately does NOT tie to their sum (so detection never auto-emits a
// link proposal — we drive apply directly).
const ORG_L1 = `${RUN}_orgl1`;
const ORG_L2 = `${RUN}_orgl2`;
const GIFT_A1 = `${RUN}_gifta1`;
const GIFT_A2 = `${RUN}_gifta2`;
const STAGED_E = `${RUN}_staged`;
const LINK_DATE = "2099-12-28";

const MERGE_KEY = `merge_gifts:${[GIFT_M1, GIFT_M2].sort().join(",")}`;

// ── Task #794 step 4 fixtures: detector matching rules ──────────────────────
// Fee-tolerance band (amountTies): evidence ∈ [0.9*sum − 0.5, sum + 0.5].
// TIE pair sums to 1000; 899.60 is just INSIDE the floor (899.50), so the
// merge proposal carries the evidence tie. NOTIE pair also sums to 1000 but
// its deposit is 899.00 — just OUTSIDE — so the proposal has no evidence.
const ORG_T = `${RUN}_orgt`;
const GIFT_T1 = `${RUN}_giftt1`;
const GIFT_T2 = `${RUN}_giftt2`;
const TIE_DATE = "2099-12-20";
const STAGED_TIE = `${RUN}_stagedtie`;
const ORG_N = `${RUN}_orgn`;
const GIFT_N1 = `${RUN}_giftn1`;
const GIFT_N2 = `${RUN}_giftn2`;
const NOTIE_DATE = "2099-12-21";
const STAGED_NOTIE = `${RUN}_stagednotie`;
// Counted-linked exclusion: a gift that is already the counted source of a
// Stripe charge must never enter a merge group.
const ORG_C = `${RUN}_orgc`;
const GIFT_C1 = `${RUN}_giftc1`; // counted stripe link
const GIFT_C2 = `${RUN}_giftc2`;
const COUNTED_DATE = "2099-12-22";
const CH_C = `${RUN}_ch_c`;
// link_evidence donor floor: a deposit tying EXACTLY to two same-donor gifts
// must NOT produce a link_evidence proposal (needs >= 2 distinct donors).
const ORG_S = `${RUN}_orgs`;
const GIFT_S1 = `${RUN}_gifts1`;
const GIFT_S2 = `${RUN}_gifts2`;
const SINGLE_DATE = "2099-12-23";
const STAGED_SINGLE = `${RUN}_stagedsingle`;

const TIE_KEY = `merge_gifts:${[GIFT_T1, GIFT_T2].sort().join(",")}`;
const NOTIE_KEY = `merge_gifts:${[GIFT_N1, GIFT_N2].sort().join(",")}`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "" } as { id: string; role: string },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = auth.current;
    next();
  },
}));

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  paymentApplications: Db["paymentApplications"];
  stripeStagedCharges: Db["stripeStagedCharges"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let andFn: (typeof import("drizzle-orm"))["and"];
let detect: typeof import("../routes/financialCorrections").detectFinancialCorrections;
let server: Server;
let baseUrl = "";

type Correction = {
  kind: string;
  key: string;
  score: number;
  reason: string;
  gifts: { id: string }[];
  evidence?: { kind: string; id: string };
  mergeSuggestion?: { primaryId: string; mergeIds: string[] };
  safeApply: boolean;
};

async function getList(): Promise<{
  status: number;
  json: { corrections: Correction[] };
}> {
  const res = await fetch(`${baseUrl}/api/financial-corrections?limit=500`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as { corrections: Correction[] } };
}

async function postJson(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}

// Corroborating ledger rows the /apply flow writes, anchored to the QB deposit.
// Phase-5 read-flip: /apply writes ONLY these rows (link_role='corroborating').
async function corrLedgerCount(): Promise<number> {
  const rows = await db
    .select({ id: schema.paymentApplications.id })
    .from(schema.paymentApplications)
    .where(
      andFn(
        eqFn(schema.paymentApplications.paymentId, STAGED_E),
        eqFn(schema.paymentApplications.linkRole, "corroborating"),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
    paymentApplications: dbMod.paymentApplications,
    stripeStagedCharges: dbMod.stripeStagedCharges,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  andFn = drizzle.and;
  detect = (await import("../routes/financialCorrections"))
    .detectFinancialCorrections;

  await db.insert(schema.users).values([
    {
      id: OTHER_ID,
      clerkId: `clerk_${OTHER_ID}`,
      email: `${OTHER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
  ]);

  await db.insert(schema.organizations).values([
    { id: ORG_M, name: `Merge Org ${RUN}` },
    { id: ORG_L1, name: `Link Org 1 ${RUN}` },
    { id: ORG_L2, name: `Link Org 2 ${RUN}` },
    { id: ORG_T, name: `Tie Org ${RUN}` },
    { id: ORG_N, name: `NoTie Org ${RUN}` },
    { id: ORG_C, name: `Counted Org ${RUN}` },
    { id: ORG_S, name: `Single Org ${RUN}` },
  ]);

  await db.insert(schema.giftsAndPayments).values([
    // Merge pair: same donor + same date, no counted pointer ⇒ merge_gifts.
    {
      id: GIFT_M1,
      name: `Gift M1 ${RUN}`,
      organizationId: ORG_M,
      amount: "100.00",
      dateReceived: MERGE_DATE,
    },
    {
      id: GIFT_M2,
      name: `Gift M2 ${RUN}`,
      organizationId: ORG_M,
      amount: "150.00",
      dateReceived: MERGE_DATE,
    },
    // Link pair: two distinct donors on one date, driven through apply directly.
    {
      id: GIFT_A1,
      name: `Gift A1 ${RUN}`,
      organizationId: ORG_L1,
      amount: "100.00",
      dateReceived: LINK_DATE,
    },
    {
      id: GIFT_A2,
      name: `Gift A2 ${RUN}`,
      organizationId: ORG_L2,
      amount: "100.00",
      dateReceived: LINK_DATE,
    },
  ]);

  // ── Step-4 fixtures: band edges, counted exclusion, donor floor ──────────
  await db.insert(schema.giftsAndPayments).values([
    { id: GIFT_T1, name: `Gift T1 ${RUN}`, organizationId: ORG_T, amount: "400.00", dateReceived: TIE_DATE },
    { id: GIFT_T2, name: `Gift T2 ${RUN}`, organizationId: ORG_T, amount: "600.00", dateReceived: TIE_DATE },
    { id: GIFT_N1, name: `Gift N1 ${RUN}`, organizationId: ORG_N, amount: "400.00", dateReceived: NOTIE_DATE },
    { id: GIFT_N2, name: `Gift N2 ${RUN}`, organizationId: ORG_N, amount: "600.00", dateReceived: NOTIE_DATE },
    { id: GIFT_C1, name: `Gift C1 ${RUN}`, organizationId: ORG_C, amount: "300.00", dateReceived: COUNTED_DATE },
    { id: GIFT_C2, name: `Gift C2 ${RUN}`, organizationId: ORG_C, amount: "300.00", dateReceived: COUNTED_DATE },
    { id: GIFT_S1, name: `Gift S1 ${RUN}`, organizationId: ORG_S, amount: "100.00", dateReceived: SINGLE_DATE },
    { id: GIFT_S2, name: `Gift S2 ${RUN}`, organizationId: ORG_S, amount: "200.00", dateReceived: SINGLE_DATE },
  ]);
  await db.insert(schema.stagedPayments).values([
    {
      // Just INSIDE the fee floor: 0.9 * 1000 − 0.5 = 899.50 ≤ 899.60.
      id: STAGED_TIE,
      realmId: `${RUN}_realm`,
      qbEntityType: "deposit",
      qbEntityId: STAGED_TIE,
      amount: "899.60",
      dateReceived: TIE_DATE,
      payerName: `Tie Deposit ${RUN}`,
    },
    {
      // Just OUTSIDE the fee floor: 899.00 < 899.50.
      id: STAGED_NOTIE,
      realmId: `${RUN}_realm`,
      qbEntityType: "deposit",
      qbEntityId: STAGED_NOTIE,
      amount: "899.00",
      dateReceived: NOTIE_DATE,
      payerName: `NoTie Deposit ${RUN}`,
    },
    {
      // Ties EXACTLY to the single-donor pair's sum (300.00).
      id: STAGED_SINGLE,
      realmId: `${RUN}_realm`,
      qbEntityType: "deposit",
      qbEntityId: STAGED_SINGLE,
      amount: "300.00",
      dateReceived: SINGLE_DATE,
      payerName: `Single Donor Deposit ${RUN}`,
    },
  ]);
  // GIFT_C1 is the counted source of a Stripe charge — book-once already done.
  await db.insert(schema.stripeStagedCharges).values({
    id: CH_C,
    stripeAccountId: `${RUN}_acct`,
    grossAmount: "300.00",
    dateReceived: COUNTED_DATE,
  });
  await db.insert(schema.paymentApplications).values({
    id: `${RUN}_pa_c1`,
    giftId: GIFT_C1,
    stripeChargeId: CH_C,
    evidenceSource: "stripe",
    linkRole: "counted",
    amountApplied: "300.00",
  });

  // Unlinked QB staged deposit used as the evidence for the apply test. Amount
  // intentionally far from the A1+A2 sum so no link_evidence proposal is auto-
  // emitted by the detector.
  await db.insert(schema.stagedPayments).values({
    id: STAGED_E,
    realmId: `${RUN}_realm`,
    qbEntityType: "deposit",
    qbEntityId: STAGED_E,
    amount: "999.99",
    dateReceived: LINK_DATE,
    payerName: `Bulk Deposit ${RUN}`,
  });

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
  // The /apply flow writes a corroborating payment_applications row per link
  // (Phase-5 read-flip); clear them before the staged-payment (payment_id FK)
  // and gift (gift_id RESTRICT) deletes below.
  await db
    .delete(schema.paymentApplications)
    .where(
      inArrayFn(schema.paymentApplications.giftId, [
        GIFT_M1,
        GIFT_M2,
        GIFT_A1,
        GIFT_A2,
        GIFT_T1,
        GIFT_T2,
        GIFT_N1,
        GIFT_N2,
        GIFT_C1,
        GIFT_C2,
        GIFT_S1,
        GIFT_S2,
      ]),
    );
  await db
    .delete(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, CH_C));
  await db
    .delete(schema.stagedPayments)
    .where(
      inArrayFn(schema.stagedPayments.id, [
        STAGED_E,
        STAGED_TIE,
        STAGED_NOTIE,
        STAGED_SINGLE,
      ]),
    );
  await db
    .delete(schema.giftsAndPayments)
    .where(
      inArrayFn(schema.giftsAndPayments.id, [
        GIFT_M1,
        GIFT_M2,
        GIFT_A1,
        GIFT_A2,
        GIFT_T1,
        GIFT_T2,
        GIFT_N1,
        GIFT_N2,
        GIFT_C1,
        GIFT_C2,
        GIFT_S1,
        GIFT_S2,
      ]),
    );
  await db
    .delete(schema.organizations)
    .where(
      inArrayFn(schema.organizations.id, [
        ORG_M,
        ORG_L1,
        ORG_L2,
        ORG_T,
        ORG_N,
        ORG_C,
        ORG_S,
      ]),
    );
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [OTHER_ID, ADMIN_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("financial-corrections queue", () => {
  it("rejects a non-admin on the list and apply endpoints with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { status } = await getList();
    expect(status).toBe(403);
    expect(
      await postJson("/api/financial-corrections/apply", {
        evidenceKind: "qb_staged",
        evidenceId: STAGED_E,
        giftIds: [GIFT_A1],
      }),
    ).toBe(403);
  }, 30_000);

  it("returns 200 with a corrections array to an admin (exercises detector SQL)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await getList();
    expect(status).toBe(200);
    expect(Array.isArray(json.corrections)).toBe(true);
  }, 30_000);

  it("surfaces the seeded same-donor/same-date pair as a merge_gifts proposal", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const corrections = await detect(1_000_000);
    const proposal = corrections.find((c) => c.key === MERGE_KEY);
    expect(proposal, "seeded merge proposal present").toBeDefined();
    expect(proposal!.kind).toBe("merge_gifts");
    expect(proposal!.gifts.map((g) => g.id).sort()).toEqual(
      [GIFT_M1, GIFT_M2].sort(),
    );
    expect(proposal!.mergeSuggestion).toBeDefined();
    const { primaryId, mergeIds } = proposal!.mergeSuggestion!;
    expect([GIFT_M1, GIFT_M2]).toContain(primaryId);
    expect(mergeIds).toHaveLength(1);
    expect(primaryId).not.toBe(mergeIds[0]);
  }, 30_000);

  it("applies link_evidence: one deposit corroborates many gifts, idempotently, without touching the QB source", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    expect(await corrLedgerCount()).toBe(0);

    expect(
      await postJson("/api/financial-corrections/apply", {
        evidenceKind: "qb_staged",
        evidenceId: STAGED_E,
        giftIds: [GIFT_A1, GIFT_A2],
      }),
    ).toBe(200);
    expect(await corrLedgerCount()).toBe(2);

    // Idempotent: re-applying the same correction adds no rows.
    expect(
      await postJson("/api/financial-corrections/apply", {
        evidenceKind: "qb_staged",
        evidenceId: STAGED_E,
        giftIds: [GIFT_A1, GIFT_A2],
      }),
    ).toBe(200);
    expect(await corrLedgerCount()).toBe(2);

    // Book-once preserved: the gifts' counted stripe pointer stays null
    // (corroborating links never become the counted source —
    // finalAmountStripeChargeId was DROPPED in Task #451; source is verified
    // via payment_applications ledger in other integration tests).
  }, 30_000);

  it("corroborating links stay out of the settled read model (link_role='counted' guard)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    // Precondition: the prior apply dual-wrote a single corroborating ledger row
    // for GIFT_A1 (link_role='corroborating', amount NULL) and NO counted row.
    const pa = await db
      .select({
        role: schema.paymentApplications.linkRole,
        amt: schema.paymentApplications.amountApplied,
      })
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.giftId, GIFT_A1));
    expect(pa).toHaveLength(1);
    expect(pa[0].role).toBe("corroborating");
    expect(pa[0].amt).toBeNull();

    // A corroborating-only gift has NO linked counted payment, so the settled
    // read model must report "nothing landed yet" — derived settled amount NULL
    // (not '0'). This is the regression guard for the link_role='counted' filter
    // in giftPaymentSummary: without it the corroborating row would flip
    // hasLinkedPayment TRUE and settle the gift at $0.
    const [row] = await db
      .select({
        amt: derivedSettledAmountForGift(),
        has: hasLinkedPaymentForGift(),
      })
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, GIFT_A1));
    expect(row.has).toBe(false);
    expect(row.amt).toBeNull();
  }, 30_000);

  it("amountTies fee band: evidence just inside [0.9·sum − 0.5, sum + 0.5] ties, just outside does not", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const corrections = await detect(1_000_000);

    // 899.60 vs sum 1000 sits 10 cents INSIDE the fee floor → evidence tie.
    const tied = corrections.find((c) => c.key === TIE_KEY);
    expect(tied, "in-band merge proposal present").toBeDefined();
    expect(tied!.evidence).toBeDefined();
    expect(tied!.evidence!.id).toBe(STAGED_TIE);
    expect(tied!.score).toBeCloseTo(0.92);

    // 899.00 vs sum 1000 sits 50 cents OUTSIDE the floor → merge proposal
    // still emitted (same donor + date) but with NO evidence tie.
    const untied = corrections.find((c) => c.key === NOTIE_KEY);
    expect(untied, "out-of-band merge proposal present").toBeDefined();
    expect(untied!.evidence).toBeUndefined();
    expect(untied!.score).toBeCloseTo(0.7);
  }, 30_000);

  it("a counted-linked gift never enters a merge group", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const corrections = await detect(1_000_000);
    // GIFT_C1 carries a counted stripe payment_application, so the C pair can
    // never group — no merge proposal may mention either gift.
    const touching = corrections.filter(
      (c) =>
        c.kind === "merge_gifts" &&
        c.gifts.some((g) => g.id === GIFT_C1 || g.id === GIFT_C2),
    );
    expect(touching).toEqual([]);
  }, 30_000);

  it("link_evidence requires >= 2 distinct donors even when the deposit ties exactly", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const corrections = await detect(1_000_000);
    // The 300.00 deposit ties exactly to GIFT_S1 + GIFT_S2, but both belong
    // to one donor — batching evidence across gifts of a single donor is a
    // merge question, not a link_evidence proposal.
    const linkProposals = corrections.filter(
      (c) => c.kind === "link_evidence" && c.evidence?.id === STAGED_SINGLE,
    );
    expect(linkProposals).toEqual([]);
    // The same pair DOES surface as a same-donor merge (with the tie).
    const merged = corrections.find(
      (c) =>
        c.kind === "merge_gifts" &&
        c.gifts.some((g) => g.id === GIFT_S1) &&
        c.gifts.some((g) => g.id === GIFT_S2),
    );
    expect(merged).toBeDefined();
  }, 30_000);

  it("rejects apply with an unknown evidence row (404) or unknown gifts (400)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    expect(
      await postJson("/api/financial-corrections/apply", {
        evidenceKind: "qb_staged",
        evidenceId: `${RUN}_missing`,
        giftIds: [GIFT_A1],
      }),
    ).toBe(404);
    expect(
      await postJson("/api/financial-corrections/apply", {
        evidenceKind: "qb_staged",
        evidenceId: STAGED_E,
        giftIds: [`${RUN}_missinggift`],
      }),
    ).toBe(400);
  }, 30_000);
});
