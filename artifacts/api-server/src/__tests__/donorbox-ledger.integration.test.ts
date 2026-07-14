import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `donorbox_ledger_user_${Date.now()}`,
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

const RUN = `donorbox_ledger_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_gift`;
const ALLOCATION_ID = `${RUN}_allocation`;
const DONATION_ID = `${RUN}_donation`;

let schema: typeof import("@workspace/db");
let db: typeof import("@workspace/db").db;
let eqFn: typeof import("drizzle-orm").eq;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Donorbox Ledger Org ${RUN}`,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "75.00",
    organizationId: ORG_ID,
    dateReceived: "2026-07-01",
    details: "Donorbox ledger action fixture",
  });
  await db.insert(schema.giftAllocations).values({
    id: ALLOCATION_ID,
    giftId: GIFT_ID,
    subAmount: "75.00",
  });
  await db.insert(schema.donorboxDonations).values({
    id: DONATION_ID,
    donationType: "paypal",
    paypalTransactionId: `${RUN}_paypal`,
    amount: "75.00",
    processingFee: "2.50",
    currency: "usd",
    donationStatus: "paid",
    donatedAt: new Date("2026-07-01T12:00:00Z"),
    dateReceived: "2026-07-01",
    donorName: "Donorbox Ledger Donor",
    donorEmail: `${RUN}@example.test`,
    organizationId: ORG_ID,
    status: "pending",
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));

  await db
    .delete(schema.paymentApplications)
    .where(eqFn(schema.paymentApplications.donorboxDonationId, DONATION_ID));
  await db
    .delete(schema.donorboxDonations)
    .where(eqFn(schema.donorboxDonations.id, DONATION_ID));
  await db
    .delete(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.id, ALLOCATION_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("ledger-authoritative Donorbox review actions", () => {
  it("links through a confirmed application without writing legacy gift pointers", async () => {
    const response = await fetch(
      `${baseUrl}/api/donorbox/donations/${DONATION_ID}/link-gift`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ giftId: GIFT_ID }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.status).toBe("match_confirmed");
    expect(body.queue).toBe("done");
    expect(body.linkedGiftId).toBe(GIFT_ID);
    expect("matchedGiftId" in body).toBe(false);
    expect("createdGiftId" in body).toBe(false);

    const donation = await db
      .select({
        status: schema.donorboxDonations.status,
        matchedGiftId: schema.donorboxDonations.matchedGiftId,
        createdGiftId: schema.donorboxDonations.createdGiftId,
      })
      .from(schema.donorboxDonations)
      .where(eqFn(schema.donorboxDonations.id, DONATION_ID))
      .then((rows) => rows[0]);

    expect(donation.status).toBe("pending");
    expect(donation.matchedGiftId).toBeNull();
    expect(donation.createdGiftId).toBeNull();

    const application = await db
      .select({
        giftId: schema.paymentApplications.giftId,
        lifecycle: schema.paymentApplications.lifecycle,
        linkRole: schema.paymentApplications.linkRole,
        createdTheGift: schema.paymentApplications.createdTheGift,
      })
      .from(schema.paymentApplications)
      .where(
        eqFn(schema.paymentApplications.donorboxDonationId, DONATION_ID),
      )
      .then((rows) => rows[0]);

    expect(application).toEqual(
      expect.objectContaining({
        giftId: GIFT_ID,
        lifecycle: "confirmed",
        linkRole: "counted",
        createdTheGift: false,
      }),
    );
  });
});
