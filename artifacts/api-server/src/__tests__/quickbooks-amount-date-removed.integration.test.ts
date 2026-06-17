import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for the removal of the donor-less "amount + date" guess
 * in the QuickBooks matcher.
 *
 * Before: a staged payment with NO donor evidence (no email / payer-name / memo
 * hit) but a single existing CRM gift of the SAME amount within ±10 days would
 * borrow that gift's donor as a `amount_date` suggestion — a coincidental
 * amount/date collision masquerading as a real attribution.
 *
 * After: that fallback is gone. Such a payment resolves to NO donor (method
 * null) and stays unmatched for a human. The corroborated "name + amount + date"
 * path is unchanged — it still requires a real name hit first.
 *
 * Calls the real `scoreStagedPayment` against a live DB (it reads gifts /
 * organizations via SQL). Skips automatically when no real DATABASE_URL is set.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qbad_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
// A distinctive, unlikely-to-collide name so the trigram name matcher resolves
// it unambiguously when (and only when) we feed it as the payer name.
const ORG_NAME = `Zzyzx Quokka Foundation ${RUN}`;
// A date and amount the seeded gift shares; the staged input reuses them.
const GIFT_AMOUNT = "31337.00";
const GIFT_DATE = "2025-03-15";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let scoreStagedPayment: (typeof import("../lib/quickbooksMatch"))["scoreStagedPayment"];

const seededGiftIds: string[] = [];
let giftId = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  scoreStagedPayment = (await import("../lib/quickbooksMatch"))
    .scoreStagedPayment;

  await db.insert(schema.organizations).values({ id: ORG_ID, name: ORG_NAME });
  giftId = `${RUN}_gift`;
  await db.insert(schema.giftsAndPayments).values({
    id: giftId,
    amount: GIFT_AMOUNT,
    dateReceived: GIFT_DATE,
    organizationId: ORG_ID,
  });
  seededGiftIds.push(giftId);
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[quickbooks-amount-date-removed] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "QuickBooks matcher — donor-less amount+date guess removed (integration)",
  () => {
    it("returns NO donor for a payment with no email/payer/memo evidence even when a single same-amount in-window gift exists", async () => {
      const result = await scoreStagedPayment({
        payerName: null,
        payerEmail: null,
        rawReference: null,
        lineDescription: null,
        amount: GIFT_AMOUNT,
        dateReceived: GIFT_DATE,
      });

      // No evidence axis hit → no method, no donor, no suggestion.
      expect(result.method).toBeNull();
      expect(result.tier).toBe("none");
      expect(result.donor.organizationId).toBeNull();
      expect(result.donor.individualGiverPersonId).toBeNull();
      expect(result.donor.householdId).toBeNull();
      // It must never report the deprecated amount_date method.
      expect(result.method).not.toBe("amount_date");
    });

    it("memo with no resolvable name (only the colliding amount/date) stays unmatched", async () => {
      const result = await scoreStagedPayment({
        payerName: null,
        payerEmail: null,
        // No extractable donor name — an acronym after a keyword is dropped.
        rawReference: "Wire from ACH",
        lineDescription: null,
        amount: GIFT_AMOUNT,
        dateReceived: GIFT_DATE,
      });

      expect(result.method).toBeNull();
      expect(result.donor.organizationId).toBeNull();
    });

    it("still corroborates a real name hit into name_amount_date when amount+date line up", async () => {
      const result = await scoreStagedPayment({
        payerName: ORG_NAME,
        payerEmail: null,
        rawReference: null,
        lineDescription: null,
        amount: GIFT_AMOUNT,
        dateReceived: GIFT_DATE,
      });

      // Real name evidence first, then amount+date corroboration upgrades it.
      expect(result.donor.organizationId).toBe(ORG_ID);
      expect(result.method).toBe("name_amount_date");
      expect(result.tier).toBe("high");
      expect(result.matchedGiftId).toBe(giftId);
    });
  },
);
