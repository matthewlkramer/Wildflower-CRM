import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
} from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the two NEW "stray worklist" read endpoints that hang
 * off the QB-anchored reconciliation workspace:
 *
 *   GET /api/reconciliation/gifts-missing-qb
 *     "gifts with no QuickBooks record" — every gift should eventually map to a
 *     QB money event; this surfaces the ones that don't. A gift is "missing a QB
 *     record" iff it carries NO final-amount QB pointer AND no staged_payments
 *     row links it (matched / created / group-reconciled). Broad + filterable
 *     (q, entityId, paymentMethod, date window); donor names masked
 *     per the viewer (match RAW name, mask DISPLAY).
 *
 *   GET /api/reconciliation/qb-search
 *     criteria-based QB staged-payment search with NO card anchor — the
 *     stray-Stripe worklist uses it to hunt the QB deposit an unmatched Stripe
 *     payout belongs to. Requires text (>=2 chars) OR a positive amount.
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked to
 * inject a seeded NON-admin (team_member) user so the anonymous-masking path is
 * actually exercised; the route SQL is the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_stray_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    // NON-admin viewer so anonymous masking is enforced (admins see all names).
    req.appUser = { id: TEST_USER_ID, role: "team_member" };
    next();
  },
}));

const RUN = `recstray_${Date.now()}`;
const MARKER = `${RUN}_mk`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const ENTITY_ID = `${RUN}_entity`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  donorboxDonations: Db["donorboxDonations"];
  paymentApplications: Db["paymentApplications"];
  entities: Db["entities"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const orgIds: string[] = [];
const giftIds: string[] = [];
const allocIds: string[] = [];
const stagedIds: string[] = [];
const chargeIds: string[] = [];
const donorboxDonationIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function apiGet(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "GET" });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedOrg(opts: {
  label: string;
  anonymous?: boolean;
  ownerUserId?: string | null;
}): Promise<string> {
  const id = nextId("org");
  await db.insert(schema.organizations).values({
    id,
    name: `${MARKER} ${opts.label}`,
    anonymous: opts.anonymous ?? false,
    ownerUserId: opts.ownerUserId ?? null,
  });
  orgIds.push(id);
  return id;
}

async function seedGift(opts: {
  organizationId: string;
  amount?: string;
  dateReceived?: string | null;
  paymentMethod?: string | null;
  archived?: boolean;
}): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: opts.amount ?? "100.00",
    organizationId: opts.organizationId,
    dateReceived: opts.dateReceived ?? null,
    paymentMethod: (opts.paymentMethod ?? null) as never,
    archivedAt: opts.archived ? new Date() : null,
    details: "stray-worklist test gift",
  });
  giftIds.push(id);
  return id;
}

async function seedAllocation(giftId: string, entityId: string): Promise<void> {
  const id = nextId("alloc");
  await db.insert(schema.giftAllocations).values({
    id,
    giftId,
    entityId,
    subAmount: "100.00",
  });
  allocIds.push(id);
}

async function seedStaged(opts: {
  label: string;
  amount?: string;
  dateReceived?: string | null;
  status?: "pending" | "approved" | "reconciled";
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
  groupReconciledGiftId?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    amount: opts.amount ?? "100.00",
    dateReceived: opts.dateReceived ?? "2026-03-15",
    payerName: `${MARKER} ${opts.label}`,
    status: opts.status ?? "pending",
    matchStatus: "unmatched",
    matchedGiftId: opts.matchedGiftId ?? null,
    createdGiftId: opts.createdGiftId ?? null,
    groupReconciledGiftId: opts.groupReconciledGiftId ?? null,
  });
  stagedIds.push(id);
  // QB cash-application reads now come from the authoritative ledger, so mirror
  // the production dual-write: any staged payment that links a gift (matched /
  // created / group-reconciled) also gets a `payment_applications` row. The
  // teardown clears these by payment_id before deleting staged_payments.
  const linkedGiftId =
    opts.matchedGiftId ?? opts.createdGiftId ?? opts.groupReconciledGiftId ?? null;
  if (linkedGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: linkedGiftId,
      amountApplied: opts.amount ?? "100.00",
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: opts.createdGiftId != null,
    });
  }
  return id;
}

async function seedCharge(opts: {
  label?: string;
  grossAmount?: string;
  netAmount?: string | null;
  dateReceived?: string | null;
  status?: "pending" | "approved" | "reconciled";
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
  refunded?: boolean;
  disputed?: boolean;
} = {}): Promise<string> {
  const id = nextId("sc");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: opts.grossAmount ?? "100.00",
    netAmount: opts.netAmount ?? null,
    dateReceived: opts.dateReceived ?? null,
    status: opts.status ?? (opts.matchedGiftId ? "approved" : "pending"),
    payerName: opts.label ? `${MARKER} ${opts.label}` : null,
    matchedGiftId: opts.matchedGiftId ?? null,
    createdGiftId: opts.createdGiftId ?? null,
    refunded: opts.refunded ?? false,
    disputed: opts.disputed ?? false,
  });
  chargeIds.push(id);
  return id;
}

async function seedDonorboxDonation(): Promise<string> {
  const id = nextId("dbx");
  await db.insert(schema.donorboxDonations).values({ id, amount: "100.00" });
  donorboxDonationIds.push(id);
  return id;
}

// Book a COUNTED cash-application ledger row for a non-QB processor (Stripe /
// Donorbox). This is the authoritative "settled through a non-QB processor"
// signal the gifts-missing-qb read consults (stripeLedgerExistsForGift /
// donorboxLedgerExistsForGift) — such money lands in QuickBooks at the payout
// level, not per gift, so the gift is reconciled and must NOT surface as
// "missing a QB record".
async function seedStripeLedgerRow(
  giftId: string,
  stripeChargeId: string,
): Promise<void> {
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    giftId,
    stripeChargeId,
    amountApplied: "100.00",
    evidenceSource: "stripe",
    matchMethod: "human",
    linkRole: "counted",
    createdTheGift: false,
  });
}

async function seedDonorboxLedgerRow(
  giftId: string,
  donorboxDonationId: string,
): Promise<void> {
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    giftId,
    donorboxDonationId,
    amountApplied: "100.00",
    evidenceSource: "donorbox",
    matchMethod: "human",
    linkRole: "counted",
    createdTheGift: false,
  });
}

type ProposedPayment = {
  source: "quickbooks" | "stripe";
  stagedPaymentId: string | null;
  stripeChargeId: string | null;
  payerName: string | null;
  amount: string | null;
} | null;

type GiftRow = {
  id: string;
  donorName: string | null;
  donorKind: string | null;
  entityId: string | null;
  entityName: string | null;
  paymentMethod: string | null;
  proposedPayment: ProposedPayment;
};

async function listGifts(qs: string): Promise<{
  rows: GiftRow[];
  ids: Set<string>;
  pagination: { page: number; limit: number; total: number };
}> {
  const res = await apiGet(`/api/reconciliation/gifts-missing-qb?${qs}`);
  expect(res.status).toBe(200);
  const rows = res.json.data as GiftRow[];
  return {
    rows,
    ids: new Set(rows.map((r) => r.id)),
    pagination: res.json.pagination,
  };
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
    giftAllocations: dbMod.giftAllocations,
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    donorboxDonations: dbMod.donorboxDonations,
    paymentApplications: dbMod.paymentApplications,
    entities: dbMod.entities,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db.insert(schema.entities).values({ id: ENTITY_ID, name: `${MARKER} Entity` });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Clear every ledger row for the test gifts FIRST. Stripe/Donorbox-anchored
  // rows carry payment_id = NULL (so the by-staged-id clear never reaches them)
  // and their anchor FKs are ON DELETE SET NULL, which would trip the evidence
  // CHECK if we deleted the parent charge/donation while the row still existed.
  await clearPaymentApplicationsForGiftIds(giftIds);
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (donorboxDonationIds.length)
    await db
      .delete(schema.donorboxDonations)
      .where(inArrayFn(schema.donorboxDonations.id, donorboxDonationIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (allocIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (orgIds.length)
    await db
      .delete(schema.organizations)
      .where(inArrayFn(schema.organizations.id, orgIds));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[reconciliation-stray-worklists] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)("GET /reconciliation/gifts-missing-qb (integration)", () => {
  it("includes gifts with no QB link and excludes any QB-linked or archived gift", async () => {
    const orgVisible = await seedOrg({ label: "Visible Org" });

    const giftNoQb = await seedGift({ organizationId: orgVisible });
    const giftMatched = await seedGift({ organizationId: orgVisible });
    const giftCreated = await seedGift({ organizationId: orgVisible });
    const giftGroup = await seedGift({ organizationId: orgVisible });
    const giftArchived = await seedGift({ organizationId: orgVisible, archived: true });

    await seedStaged({ label: "matched", matchedGiftId: giftMatched });
    await seedStaged({ label: "created", createdGiftId: giftCreated });
    await seedStaged({ label: "group", groupReconciledGiftId: giftGroup });

    const { ids, pagination } = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);

    expect(ids.has(giftNoQb)).toBe(true); // no QB link → surfaced
    expect(ids.has(giftMatched)).toBe(false); // staged_payments.matched_gift_id
    expect(ids.has(giftCreated)).toBe(false); // staged_payments.created_gift_id
    expect(ids.has(giftGroup)).toBe(false); // staged_payments.group_reconciled_gift_id
    expect(ids.has(giftArchived)).toBe(false); // archived gifts never surface

    // Pagination envelope is present and well-formed.
    expect(pagination.limit).toBe(200);
    expect(typeof pagination.total).toBe("number");
    expect(pagination.total).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("excludes a gift QB-linked ONLY via the ledger (no legacy columns) — proves the read consults payment_applications", async () => {
    // Ledger-only divergence: a staged payment with NO legacy matched/created/
    // group pointer, whose only tie to the gift is a `payment_applications` row.
    // The legacy read (staged_payments.*_gift_id) would still surface this gift as
    // "missing QB"; the ledger read must EXCLUDE it. This is the one state where
    // the two reads disagree, so it isolates which source the endpoint trusts.
    const org = await seedOrg({ label: "Ledger-Only Org" });
    const giftLedgerOnly = await seedGift({ organizationId: org });
    const stagedUnlinked = await seedStaged({ label: "ledger-only" }); // no legacy link ⇒ no auto PA row
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: stagedUnlinked,
      giftId: giftLedgerOnly,
      amountApplied: "100.00",
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: false,
    });

    const { ids } = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    expect(ids.has(giftLedgerOnly)).toBe(false); // ledger row alone excludes it
  }, 30_000);

  it("excludes a gift settled through a non-QB processor via a COUNTED Stripe or Donorbox ledger row", async () => {
    // The positive counterpart to the "legacy Stripe charge alone does NOT
    // exclude" case: a gift with a COUNTED payment_applications row whose
    // evidence_source is a non-QB processor (stripe / donorbox) is settled at the
    // PAYOUT level in QuickBooks, never per gift, so it has no per-gift QB ledger
    // row yet is still reconciled — it must be EXCLUDED. Both gifts otherwise
    // qualify (on-books, no QB ledger row, no allocation), so the only thing that
    // can keep them off the worklist is the processor-settled ledger exclusion,
    // driven by stripeLedgerExistsForGift / donorboxLedgerExistsForGift (mirroring
    // deriveGiftQbTie's "tied" semantics).
    const org = await seedOrg({ label: "Processor Settled Org" });

    // Stripe: the charge carries NO legacy matched_gift_id — the ONLY tie to the
    // gift is the counted 'stripe' ledger row, isolating the ledger as the driver.
    const giftStripe = await seedGift({ organizationId: org });
    const charge = await seedCharge();
    await seedStripeLedgerRow(giftStripe, charge);

    // Donorbox: the only tie is the counted 'donorbox' ledger row.
    const giftDonorbox = await seedGift({ organizationId: org });
    const donation = await seedDonorboxDonation();
    await seedDonorboxLedgerRow(giftDonorbox, donation);

    const { ids } = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    expect(ids.has(giftStripe)).toBe(false); // counted Stripe ledger row ⇒ processor-settled ⇒ excluded
    expect(ids.has(giftDonorbox)).toBe(false); // counted Donorbox ledger row ⇒ excluded
  }, 30_000);

  it("masks anonymous donor names for a non-owner, non-admin viewer (match RAW, mask DISPLAY)", async () => {
    // Anonymous org the viewer does NOT own → the team_member viewer must not
    // see its real name, but the RAW name still matches the `q` filter.
    const orgAnon = await seedOrg({
      label: "Secret Anon Org",
      anonymous: true,
    });
    const giftAnon = await seedGift({ organizationId: orgAnon });

    const { rows } = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    const row = rows.find((r) => r.id === giftAnon);
    expect(row).toBeDefined(); // matched on RAW name despite masking
    expect(row?.donorKind).toBe("organization");
    expect(row?.donorName).toBe("Anonymous"); // DISPLAY masked
  }, 30_000);

  it("filters by entityId and paymentMethod; a legacy Stripe charge (no ledger row) does NOT exclude a gift", async () => {
    const org = await seedOrg({ label: "Filter Org" });

    const giftCheck = await seedGift({
      organizationId: org,
      paymentMethod: "check",
      dateReceived: "2026-02-10",
    });
    const giftAch = await seedGift({
      organizationId: org,
      paymentMethod: "ach",
      dateReceived: "2026-05-01",
    });
    await seedAllocation(giftAch, ENTITY_ID);

    // A legacy stripe_staged_charges link alone does NOT settle a gift: the
    // authoritative "settled through a non-QB processor" signal is a COUNTED
    // Stripe row in the payment_applications ledger (T003 read cutover). A gift
    // whose only Stripe tie is the legacy charge table (no ledger row) is still
    // genuinely missing a QB record, so it must STILL surface on this worklist.
    const giftStripeChargeOnly = await seedGift({
      organizationId: org,
      paymentMethod: "check",
    });
    await seedCharge({ matchedGiftId: giftStripeChargeOnly });

    // entityId — only the entity-allocated gift, scoped DB-wide by the unique id.
    const byEntity = await listGifts(`entityId=${ENTITY_ID}&limit=200`);
    expect(byEntity.ids.has(giftAch)).toBe(true);
    expect(byEntity.ids.has(giftCheck)).toBe(false);
    const achRow = byEntity.rows.find((r) => r.id === giftAch);
    expect(achRow?.entityId).toBe(ENTITY_ID); // single-entity ⇒ concrete id
    expect(achRow?.entityName).toContain(MARKER);

    // paymentMethod — check vs ach.
    const byMethod = await listGifts(
      `q=${encodeURIComponent(MARKER)}&paymentMethod=check&limit=200`,
    );
    expect(byMethod.ids.has(giftCheck)).toBe(true);
    expect(byMethod.ids.has(giftAch)).toBe(false);

    // The legacy-charge-only gift is NOT excluded — exclusion consults the
    // ledger, not stripe_staged_charges.
    const all = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    expect(all.ids.has(giftStripeChargeOnly)).toBe(true);
  }, 30_000);

  it("proposes an unlinked QB staged payment, else falls back to an unlinked Stripe charge", async () => {
    // (a) QB-first: a stray gift whose donor name + amount + date match an
    // unlinked QB staged payment gets a source=quickbooks proposal pointing at
    // that staged row.
    const orgQb = await seedOrg({ label: "Propose QB Org" });
    const giftQb = await seedGift({
      organizationId: orgQb,
      amount: "321.00",
      dateReceived: "2026-04-10",
    });
    const stagedQb = await seedStaged({
      label: "Propose QB Org",
      amount: "321.00",
      dateReceived: "2026-04-12",
    });

    const qbRes = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    const qbRow = qbRes.rows.find((r) => r.id === giftQb);
    expect(qbRow?.proposedPayment?.source).toBe("quickbooks");
    expect(qbRow?.proposedPayment?.stagedPaymentId).toBe(stagedQb);
    expect(qbRow?.proposedPayment?.stripeChargeId).toBeNull();

    // (b) Stripe fallback: a stray gift with NO plausible QB payment but an
    // unlinked, pending Stripe charge whose GROSS/NET fee band contains the gift
    // amount gets a source=stripe proposal pointing at that charge. The gift is
    // booked NET of fees (485.50), inside the charge's [net 485.50, gross 500].
    const orgStripe = await seedOrg({ label: "Propose Stripe Org" });
    const giftStripe = await seedGift({
      organizationId: orgStripe,
      amount: "485.50",
      dateReceived: "2026-06-01",
    });
    const chargeStripe = await seedCharge({
      label: "Propose Stripe Org",
      grossAmount: "500.00",
      netAmount: "485.50",
      dateReceived: "2026-06-02",
      status: "pending",
    });

    const stripeRes = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    const stripeRow = stripeRes.rows.find((r) => r.id === giftStripe);
    expect(stripeRow?.proposedPayment?.source).toBe("stripe");
    expect(stripeRow?.proposedPayment?.stripeChargeId).toBe(chargeStripe);
    expect(stripeRow?.proposedPayment?.stagedPaymentId).toBeNull();

    // (c) No plausible payment either place ⇒ null proposal (search-to-link).
    const orgNone = await seedOrg({ label: "Propose None Org" });
    const giftNone = await seedGift({
      organizationId: orgNone,
      amount: "777.77",
      dateReceived: "2026-07-01",
    });
    const noneRes = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    const noneRow = noneRes.rows.find((r) => r.id === giftNone);
    expect(noneRow?.proposedPayment ?? null).toBeNull();
  }, 30_000);

  it("filters by date window (dateFrom / dateTo)", async () => {
    const org = await seedOrg({ label: "Date Org" });
    const giftEarly = await seedGift({
      organizationId: org,
      dateReceived: "2026-01-05",
      paymentMethod: "wire",
    });
    const giftLate = await seedGift({
      organizationId: org,
      dateReceived: "2026-09-20",
      paymentMethod: "wire",
    });

    const ranged = await listGifts(
      `q=${encodeURIComponent(MARKER)}&dateFrom=2026-08-01&dateTo=2026-12-31&limit=200`,
    );
    expect(ranged.ids.has(giftLate)).toBe(true);
    expect(ranged.ids.has(giftEarly)).toBe(false);
  }, 30_000);

  it("rejects a malformed date with 400 (not a DB 500)", async () => {
    const badFrom = await apiGet(
      `/api/reconciliation/gifts-missing-qb?dateFrom=2026-13-40`,
    );
    expect(badFrom.status).toBe(400);

    const badTo = await apiGet(
      `/api/reconciliation/gifts-missing-qb?dateTo=not-a-date`,
    );
    expect(badTo.status).toBe(400);
  }, 30_000);

  // ─── proposedPayment (the report's one-click "Link" suggestion) ────────────
  // Each stray-gift row carries a best-guess UNLINKED QB staged payment the
  // reviewer can one-click reconcile to. A wrong guess here would tie a gift to
  // the wrong money, so pin the ranking (closest amount, then date), the
  // in-band/already-linked null cases, and the RAW-name-vs-masked-display split.

  it("proposedPayment picks the closest unlinked staged payment (amount, then date)", async () => {
    const org = await seedOrg({ label: "Prop Closest Org" });
    const gift = await seedGift({
      organizationId: org,
      amount: "100.00",
      dateReceived: "2026-03-15",
    });

    // All three carry the donor's RAW name as the payer (text match), sit inside
    // the ±20%/±$50 amount band, and fall in the ±30d date window — so ranking,
    // not filtering, must decide the winner.
    const closest = await seedStaged({
      label: "Prop Closest Org", // payerName == org name ⇒ text match
      amount: "100.00", // exact amount + closest date ⇒ winner
      dateReceived: "2026-03-10",
    });
    await seedStaged({
      label: "Prop Closest Org",
      amount: "100.00", // exact amount but farther date ⇒ loses the date tiebreak
      dateReceived: "2026-03-01",
    });
    await seedStaged({
      label: "Prop Closest Org",
      amount: "120.00", // in-band but farther amount ⇒ loses on amount first
      dateReceived: "2026-03-15",
    });

    const { rows } = await listGifts(
      `q=${encodeURIComponent(`${MARKER} Prop Closest Org`)}&limit=200`,
    );
    const row = rows.find((r) => r.id === gift);
    expect(row?.proposedPayment?.stagedPaymentId).toBe(closest);
  }, 30_000);

  it("proposedPayment is null when nothing plausible is in the amount band", async () => {
    const org = await seedOrg({ label: "Prop Out Of Band Org" });
    const gift = await seedGift({
      organizationId: org,
      amount: "100.00",
      dateReceived: "2026-03-15",
    });
    // Same donor name + date, but far outside the ±20%/±$50 amount band.
    await seedStaged({
      label: "Prop Out Of Band Org",
      amount: "10000.00",
      dateReceived: "2026-03-15",
    });

    const { rows } = await listGifts(
      `q=${encodeURIComponent(`${MARKER} Prop Out Of Band Org`)}&limit=200`,
    );
    const row = rows.find((r) => r.id === gift);
    expect(row).toBeDefined();
    expect(row?.proposedPayment ?? null).toBeNull();
  }, 30_000);

  it("proposedPayment is null when the only candidates are already linked to a gift", async () => {
    const org = await seedOrg({ label: "Prop Linked Org" });
    const stray = await seedGift({
      organizationId: org,
      amount: "100.00",
      dateReceived: "2026-03-15",
    });
    // Sink gifts the staged rows are already tied to. Those staged rows match the
    // stray gift's name/amount/date but carry a gift link (matched / created /
    // group), so the proposal must exclude every one of them. (The sinks are
    // themselves excluded from the list because the dual-written ledger row gives
    // them a QB record.)
    const sinkMatched = await seedGift({ organizationId: org });
    const sinkCreated = await seedGift({ organizationId: org });
    const sinkGroup = await seedGift({ organizationId: org });

    await seedStaged({
      label: "Prop Linked Org",
      amount: "100.00",
      dateReceived: "2026-03-15",
      matchedGiftId: sinkMatched,
    });
    await seedStaged({
      label: "Prop Linked Org",
      amount: "100.00",
      dateReceived: "2026-03-15",
      createdGiftId: sinkCreated,
    });
    await seedStaged({
      label: "Prop Linked Org",
      amount: "100.00",
      dateReceived: "2026-03-15",
      groupReconciledGiftId: sinkGroup,
    });

    const { rows } = await listGifts(
      `q=${encodeURIComponent(`${MARKER} Prop Linked Org`)}&limit=200`,
    );
    const row = rows.find((r) => r.id === stray);
    expect(row).toBeDefined(); // the stray gift itself has no QB link ⇒ surfaces
    expect(row?.proposedPayment ?? null).toBeNull(); // but every candidate is linked
  }, 30_000);

  it("proposedPayment matches on the RAW donor name even when the response name is masked", async () => {
    const orgAnon = await seedOrg({
      label: "Prop Anon Org",
      anonymous: true,
    });
    const gift = await seedGift({
      organizationId: orgAnon,
      amount: "100.00",
      dateReceived: "2026-03-15",
    });
    // payerName carries the org's REAL (unmasked) name — the proposal must still
    // find it via the raw name even though the non-owner viewer sees "Anonymous".
    const staged = await seedStaged({
      label: "Prop Anon Org",
      amount: "100.00",
      dateReceived: "2026-03-15",
    });

    const { rows } = await listGifts(
      `q=${encodeURIComponent(`${MARKER} Prop Anon Org`)}&limit=200`,
    );
    const row = rows.find((r) => r.id === gift);
    expect(row?.donorName).toBe("Anonymous"); // DISPLAY masked
    expect(row?.proposedPayment?.stagedPaymentId).toBe(staged); // matched on RAW name
  }, 30_000);
});

describe.skipIf(!HAS_DB)("GET /reconciliation/qb-search (integration)", () => {
  it("returns [] without text or amount, and finds the staged row by text and by amount", async () => {
    const staged = await seedStaged({
      label: "QB Search Payer",
      amount: "250.00",
      dateReceived: "2026-03-20",
    });

    // No criteria ⇒ empty (the box only searches once given text/amount).
    const empty = await apiGet(`/api/reconciliation/qb-search`);
    expect(empty.status).toBe(200);
    expect(empty.json.data).toEqual([]);

    // Single char is below the 2-char text threshold ⇒ still empty.
    const tooShort = await apiGet(`/api/reconciliation/qb-search?q=a`);
    expect(tooShort.status).toBe(200);
    expect(tooShort.json.data).toEqual([]);

    // By text.
    const byText = await apiGet(
      `/api/reconciliation/qb-search?q=${encodeURIComponent(MARKER)}&limit=50`,
    );
    expect(byText.status).toBe(200);
    const textIds = (byText.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(textIds).toContain(staged);

    // By amount (generous fee band around 250) — dev has no other QB data.
    const byAmount = await apiGet(`/api/reconciliation/qb-search?amount=250&limit=50`);
    expect(byAmount.status).toBe(200);
    const amountIds = (byAmount.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(amountIds).toContain(staged);

    // Shape: qb candidates carry nodeType + label.
    const card = (byText.json.data as Array<{ id: string; nodeType: string }>).find(
      (c) => c.id === staged,
    );
    expect(card?.nodeType).toBe("qb");
  }, 30_000);

  it("rejects a malformed date with 400 (not a DB 500)", async () => {
    const bad = await apiGet(`/api/reconciliation/qb-search?date=2026-13-40`);
    expect(bad.status).toBe(400);
  }, 30_000);
});
