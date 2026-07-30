import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `donortrigger_${Date.now()}`;
const PERSON_ID = `${RUN}_person`;
const ORG_ID = `${RUN}_org`;
const HOUSEHOLD_ID = `${RUN}_household`;
const PI_ID = `${RUN}_pi`;
const PREF_ID = `${RUN}_preference`;
const LINK_ID = `${RUN}_link`;
const giftIds: string[] = [];

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");

async function setPreference(
  mode: "self" | "target" | "ask",
  targetOrganizationId: string | null = null,
) {
  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourcePersonId, PERSON_ID));
  await db.insert(schema.donorRoutingPreferences).values({
    id: PREF_ID,
    sourceKind: "individual",
    sourcePersonId: PERSON_ID,
    mode,
    targetKind: mode === "target" ? "organization" : null,
    targetOrganizationId,
  });
}

async function insertGift(
  label: string,
  paymentIntermediaryId: string | null = null,
) {
  const id = `${RUN}_${label}`;
  giftIds.push(id);
  const [gift] = await db
    .insert(schema.giftsAndPayments)
    .values({
      id,
      amount: "100.00",
      dateReceived: "2026-07-30",
      individualGiverPersonId: PERSON_ID,
      paymentIntermediaryId,
    })
    .returning();
  return gift;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: "Trigger Household",
  });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    firstName: "Trigger",
    lastName: "Person",
    fullName: "Trigger Person",
    primaryHouseholdId: HOUSEHOLD_ID,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: "Trigger Organization",
  });
  await db.insert(schema.paymentIntermediaries).values({
    id: PI_ID,
    name: "Trigger DAF",
    type: "daf",
  });
  await db.insert(schema.donorPaymentIntermediaries).values({
    id: LINK_ID,
    organizationId: ORG_ID,
    paymentIntermediaryId: PI_ID,
    isDefault: true,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (giftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArray(schema.giftsAndPayments.id, giftIds));
  }
  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourcePersonId, PERSON_ID));
  await db
    .delete(schema.donorPaymentIntermediaries)
    .where(eq(schema.donorPaymentIntermediaries.id, LINK_ID));
  await db.delete(schema.people).where(eq(schema.people.id, PERSON_ID));
  await db
    .delete(schema.households)
    .where(eq(schema.households.id, HOUSEHOLD_ID));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.paymentIntermediaries)
    .where(eq(schema.paymentIntermediaries.id, PI_ID));
});

describe.skipIf(!HAS_DB)("gift donor-routing trigger", () => {
  it("uses the primary household as the automatic individual default", async () => {
    const gift = await insertGift("automatic");
    expect(gift).toMatchObject({
      individualGiverPersonId: null,
      householdId: HOUSEHOLD_ID,
      organizationId: null,
    });
  });

  it("honors an explicit self override", async () => {
    await setPreference("self");
    const gift = await insertGift("self");
    expect(gift).toMatchObject({
      individualGiverPersonId: PERSON_ID,
      householdId: null,
      organizationId: null,
    });
  });

  it("routes to an organization and applies its default intermediary", async () => {
    await setPreference("target", ORG_ID);
    const gift = await insertGift("target");
    expect(gift).toMatchObject({
      individualGiverPersonId: null,
      householdId: null,
      organizationId: ORG_ID,
      paymentIntermediaryId: PI_ID,
    });
  });

  it("preserves an explicitly selected intermediary", async () => {
    await setPreference("target", ORG_ID);
    const gift = await insertGift("explicit-pi", PI_ID);
    expect(gift.paymentIntermediaryId).toBe(PI_ID);
  });

  it("blocks gift creation for ask-each-time pathways", async () => {
    await setPreference("ask");
    let thrown: unknown;
    try {
      await insertGift("ask");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect(String((thrown as { cause?: unknown }).cause ?? thrown)).toContain(
      "donor_routing_decision_required",
    );
  });
});
