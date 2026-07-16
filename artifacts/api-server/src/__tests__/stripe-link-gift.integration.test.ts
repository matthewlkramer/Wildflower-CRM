import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  stripeCountedRowForCharge,
  stripeGiftIdForCharge,
} from "./paymentApplicationsTestUtil";
import { chargeStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for POST /api/stripe-staged-charges/:id/link-gift — the
 * per-charge money path for a MULTI-charge Stripe payout whose QB deposit approve
 * can't route a single charge (the reported "Ayeisha" bug: the deposit-level
 * graph's evidence.stripe.chargeId is null when a payout fans out to >1 charge,
 * so the per-charge Approve 409s `stripe_charge_required`).
 *
 * The endpoint LINKS the charge to an EXISTING gift (adopting the gift's donor),
 * stamps the gift's final amount to the charge GROSS, and never mints a new gift.
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked to
 * inject a seeded admin; the link SQL is the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `link_gift_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID };
    next();
  },
}));

const RUN = `linkgift_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const giftIds: string[] = [];
const allocationIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function apiPost(
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedGift(
  amount: string,
  opts: { archived?: boolean } = {},
): Promise<string> {
  const id = nextId("gift");
  const allocId = nextId("alloc");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "link-gift test gift",
    dateReceived: "2026-03-15",
    archivedAt: opts.archived ? new Date() : null,
  });
  await db.insert(schema.giftAllocations).values({
    id: allocId,
    giftId: id,
    subAmount: amount,
  });
  giftIds.push(id);
  allocationIds.push(allocId);
  return id;
}

async function seedCharge(opts: {
  gross: string;
  fee?: string;
  net?: string;
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: opts.gross,
    feeAmount: opts.fee ?? "3.58",
    netAmount: opts.net ?? "100.84",
    dateReceived: "2026-03-15",
    payerName: `${RUN} payer`,
    matchStatus: "unmatched",
  });
  chargeIds.push(id);
  return id;
}

async function readCharge(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(schema.stripeStagedCharges),
      status: chargeStatusSql,
    })
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, id));
  return row;
}

async function readGift(id: string) {
  const [row] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
  return row;
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
    stripeStagedCharges: dbMod.stripeStagedCharges,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Link-Gift Test Org ${RUN}`,
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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Delete order matters (all these FKs are RESTRICT / block the parent):
  //  1. payment_applications — gift-anchored (payment_id NULL, gift_id RESTRICT).
  //  2. gift_allocations — RESTRICT to the gift.
  //  3. gifts — releases final_amount_stripe_charge_id, which FK-references the
  //     charge, so gifts MUST be deleted BEFORE the charges.
  //  4. charges.
  await clearPaymentApplicationsForGiftIds(giftIds);
  if (allocationIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocationIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[stripe-link-gift] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)(
  "POST /stripe-staged-charges/:id/link-gift (integration)",
  () => {
    it("links a pending charge to an existing gift, stamping gift amount to GROSS", async () => {
      // The Ayeisha shape: gift booked at a rounded amount, charge GROSS differs.
      const giftId = await seedGift("100.00");
      const chargeId = await seedCharge({ gross: "104.42" });

      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId },
      );
      expect(res.status).toBe(200);

      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("match_confirmed");
      // Ledger (not the retired pointer columns) records the link: a counted
      // stripe row anchored on the charge, NOT a mint.
      const ledgerRow = await stripeCountedRowForCharge(chargeId);
      expect(ledgerRow?.giftId).toBe(giftId);
      expect(ledgerRow?.createdTheGift).toBe(false);
      expect(charge.matchStatus).toBe("matched");
      // Charge adopted the gift's donor.
      expect(charge.organizationId).toBe(ORG_ID);

      // The gift is now sourced from this Stripe charge (GROSS). The stamp
      // records provenance in the ledger (finalAmountStripeChargeId @deprecated);
      // the settled GROSS is derived at read time from the linked charge
      // (see giftPaymentSummary). No fee-band gate.
      const gift = await readGift(giftId);
      expect(gift.finalAmountSource).toBe("stripe");
      expect(await stripeGiftIdForCharge(chargeId)).toBe(giftId);
    });

    it("is idempotent: re-linking the same charge to the same gift is a 200 no-op", async () => {
      const giftId = await seedGift("50.00");
      const chargeId = await seedCharge({ gross: "50.00" });

      const first = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId },
      );
      expect(first.status).toBe(200);

      const second = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId },
      );
      expect(second.status).toBe(200);

      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("match_confirmed");
      expect(await stripeGiftIdForCharge(chargeId)).toBe(giftId);
    });

    it("404s when the gift does not exist", async () => {
      const chargeId = await seedCharge({ gross: "25.00" });
      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId: `${RUN}_missing_gift` },
      );
      expect(res.status).toBe(404);
      // Charge is untouched.
      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("pending");
    });

    it("409s when the gift is archived", async () => {
      const giftId = await seedGift("75.00", { archived: true });
      const chargeId = await seedCharge({ gross: "75.00" });
      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId },
      );
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("gift_archived");
    });

    it("404s when the charge does not exist", async () => {
      const giftId = await seedGift("60.00");
      const res = await apiPost(
        `/api/stripe-staged-charges/${RUN}_missing_charge/link-gift`,
        { giftId },
      );
      expect(res.status).toBe(404);
    });

    it("409s when the charge is already reconciled to a DIFFERENT gift", async () => {
      const giftA = await seedGift("80.00");
      const giftB = await seedGift("80.00");
      const chargeId = await seedCharge({ gross: "80.00" });

      const first = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId: giftA },
      );
      expect(first.status).toBe(200);

      const second = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId: giftB },
      );
      expect(second.status).toBe(409);
      expect(second.json.error).toBe("not_pending");

      // The original link is intact.
      expect(await stripeGiftIdForCharge(chargeId)).toBe(giftA);
    });

    it("409s (consistency_gate / gift_already_stripe_sourced) when another charge already owns the target gift", async () => {
      const giftId = await seedGift("90.00");
      const chargeA = await seedCharge({ gross: "90.00" });
      const chargeB = await seedCharge({ gross: "90.00" });

      const first = await apiPost(
        `/api/stripe-staged-charges/${chargeA}/link-gift`,
        { giftId },
      );
      expect(first.status).toBe(200);

      const second = await apiPost(
        `/api/stripe-staged-charges/${chargeB}/link-gift`,
        { giftId },
      );
      expect(second.status).toBe(409);
      // Gate-shaped payload (same shape as the deposit-approve re-target gate)
      // so the workbench can offer the confirm-the-swap dialog: the issue
      // carries the incumbent charge's details + the target charge id.
      expect(second.json.error).toBe("consistency_gate");
      const issues = second.json.details?.issues as Array<{
        code: string;
        details?: {
          currentStripeCharge?: { id: string; amount: string };
          targetStripeChargeId?: string;
        };
      }>;
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("gift_already_stripe_sourced");
      expect(issues[0].details?.currentStripeCharge?.id).toBe(chargeA);
      expect(issues[0].details?.currentStripeCharge?.amount).toBe("90.00");
      expect(issues[0].details?.targetStripeChargeId).toBe(chargeB);

      // Charge B stays open (untouched) for a different gift.
      const chargeBRow = await readCharge(chargeB);
      expect(chargeBRow.status).toBe("pending");
      // The original link is intact.
      const chargeARow = await readCharge(chargeA);
      expect(chargeARow.status).toBe("match_confirmed");
      expect(await stripeGiftIdForCharge(chargeA)).toBe(giftId);
    });

    it("switchStripeSource=true re-sources the gift: incumbent orphaned back to pending, new charge linked", async () => {
      const giftId = await seedGift("120.00");
      const chargeA = await seedCharge({ gross: "120.00" });
      const chargeB = await seedCharge({ gross: "121.75" });

      const first = await apiPost(
        `/api/stripe-staged-charges/${chargeA}/link-gift`,
        { giftId },
      );
      expect(first.status).toBe(200);

      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeB}/link-gift`,
        { giftId, switchStripeSource: true },
      );
      expect(res.status).toBe(200);

      // The incumbent charge is orphaned back to the unmatched-money queue:
      // pending, no gift links, no confirmations. It adopted the gift's donor
      // when it was linked, so it comes back as a SUGGESTED match, ready to be
      // tied to the right money later.
      const chargeARow = await readCharge(chargeA);
      expect(chargeARow.status).toBe("pending");
      expect(await stripeCountedRowForCharge(chargeA)).toBeNull();
      expect(chargeARow.matchConfirmedAt).toBeNull();
      expect(chargeARow.matchStatus).toBe("suggested");

      // The new charge now backs the gift.
      const chargeBRow = await readCharge(chargeB);
      expect(chargeBRow.status).toBe("match_confirmed");
      expect(await stripeGiftIdForCharge(chargeB)).toBe(giftId);
      expect(chargeBRow.matchStatus).toBe("matched");

      // The gift's Stripe provenance moved to the new charge (via ledger).
      const gift = await readGift(giftId);
      expect(gift.finalAmountSource).toBe("stripe");
      expect(await stripeGiftIdForCharge(chargeB)).toBe(giftId);
    });

    it("switchStripeSource=true is a plain link when no incumbent exists", async () => {
      const giftId = await seedGift("40.00");
      const chargeId = await seedCharge({ gross: "40.00" });

      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        { giftId, switchStripeSource: true },
      );
      expect(res.status).toBe(200);
      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("match_confirmed");
      expect(await stripeGiftIdForCharge(chargeId)).toBe(giftId);
    });

    it("400s on an invalid body (missing giftId)", async () => {
      const chargeId = await seedCharge({ gross: "30.00" });
      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/link-gift`,
        {},
      );
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("validation_error");
    });
  },
);
