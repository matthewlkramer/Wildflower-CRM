import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `stripe_reads_user_${Date.now()}`,
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

const RUN = `stripe_reads_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_stale_gift`;
const CHARGE_ID = `${RUN}_charge`;
const MARKER = `${RUN}_payer`;

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
    name: `Stripe Reads Org ${RUN}`,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "156.48",
    organizationId: ORG_ID,
    dateReceived: "2026-07-01",
    details: "Stale pointer target for Stripe read regression",
  });
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_ID,
    stripeAccountId: `${RUN}_acct`,
    grossAmount: "156.48",
    feeAmount: "7.58",
    netAmount: "148.90",
    dateReceived: "2026-07-01",
    payerName: MARKER,
    organizationId: ORG_ID,
    matchStatus: "matched",
    // Deliberately stale: no payment_application exists.
    matchedGiftId: GIFT_ID,
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
    .delete(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, CHARGE_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("ledger-first Stripe read routes", () => {
  it("keeps a pointer-only charge in needs-review and hides the pointer fields", async () => {
    const response = await fetch(
      `${baseUrl}/api/stripe-staged-charges?queue=needs_review&search=${encodeURIComponent(MARKER)}`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    const row = payload.data.find((candidate) => candidate.id === CHARGE_ID);

    expect(row).toBeDefined();
    expect(row?.status).toBe("pending");
    expect(row?.queue).toBe("needs_review");
    expect(row?.resolvedGiftId).toBeNull();
    expect("matchedGiftId" in (row ?? {})).toBe(false);
    expect("createdGiftId" in (row ?? {})).toBe(false);
  });
});
