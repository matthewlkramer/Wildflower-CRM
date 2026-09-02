/**
 * Integration tests for POST /pledge-expected-payments schedule generation
 * (repeatCount + repeatIntervalMonths) plus unit tests for the month-add
 * date helper. Pattern follows gift-merge.integration.test.ts: mock the
 * Clerk auth gate, boot the real app on an ephemeral port, hit it via fetch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { addMonthsClamped } from "../routes/pledgeExpectedPayments";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `pep_repeat_test_user_${Date.now()}`,
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

const RUN = `peprepeat_${Date.now()}`;
const PLEDGE_ID = `${RUN}_pledge`;

describe("addMonthsClamped", () => {
  it("advances plain dates", () => {
    expect(addMonthsClamped("2026-12-01", 12)).toBe("2027-12-01");
    expect(addMonthsClamped("2026-01-15", 1)).toBe("2026-02-15");
    expect(addMonthsClamped("2026-11-30", 3)).toBe("2027-02-28");
  });
  it("clamps to month end", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonthsClamped("2026-03-31", 1)).toBe("2026-04-30");
  });
  it("crosses year boundaries", () => {
    expect(addMonthsClamped("2026-10-15", 6)).toBe("2027-04-15");
  });
});

describe.skipIf(!HAS_DB)("POST /pledge-expected-payments repeat", () => {
  type Db = typeof import("@workspace/db");
  let db: Db["db"];
  let users: Db["users"];
  let organizations: Db["organizations"];
  let opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  let pledgeExpectedPayments: Db["pledgeExpectedPayments"];
  let eqFn: (typeof import("drizzle-orm"))["eq"];
  let server: Server;
  let baseUrl: string;

  const post = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/api/pledge-expected-payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const rowsForPledge = () =>
    db
      .select()
      .from(pledgeExpectedPayments)
      .where(eqFn(pledgeExpectedPayments.pledgeOrOpportunityId, PLEDGE_ID));

  const clearRows = () =>
    db
      .delete(pledgeExpectedPayments)
      .where(eqFn(pledgeExpectedPayments.pledgeOrOpportunityId, PLEDGE_ID));

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    users = dbMod.users;
    organizations = dbMod.organizations;
    opportunitiesAndPledges = dbMod.opportunitiesAndPledges;
    pledgeExpectedPayments = dbMod.pledgeExpectedPayments;
    ({ eq: eqFn } = await import("drizzle-orm"));

    await db.insert(users).values({
      id: TEST_USER_ID,
      clerkId: `clerk_${TEST_USER_ID}`,
      email: `${TEST_USER_ID}@wildflowerschools.org`,
      role: "admin",
    });
    await db.insert(organizations).values({
      id: `${RUN}_org`,
      name: `Repeat Schedule Org ${RUN}`,
    });
    await db.insert(opportunitiesAndPledges).values({
      id: PLEDGE_ID,
      name: `Repeat schedule pledge ${RUN}`,
      organizationId: `${RUN}_org`,
      awardedAmount: "5000000.00",
      stage: "written_commitment",
      writtenPledge: true,
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
    await clearRows();
    await db
      .delete(opportunitiesAndPledges)
      .where(eqFn(opportunitiesAndPledges.id, PLEDGE_ID));
    await db.delete(organizations).where(eqFn(organizations.id, `${RUN}_org`));
    await db.delete(users).where(eqFn(users.id, TEST_USER_ID));
  }, 30_000);

  it("creates the full schedule with stepped dates and copied amount", async () => {
    const res = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2026-12-01",
      amount: "1000000",
      notes: "annual installment",
      repeatCount: 5,
      repeatIntervalMonths: 12,
    });
    expect(res.status).toBe(201);
    // Response contract unchanged: the FIRST row comes back.
    expect(res.json.expectedDate).toBe("2026-12-01");

    const rows = await rowsForPledge();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.expectedDate).sort()).toEqual([
      "2026-12-01",
      "2027-12-01",
      "2028-12-01",
      "2029-12-01",
      "2030-12-01",
    ]);
    for (const r of rows) {
      expect(Number(r.amount)).toBe(1000000);
      expect(r.notes).toBe("annual installment");
    }
    await clearRows();
  }, 30_000);

  it("clamps month-end dates when stepping monthly", async () => {
    const res = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2027-01-31",
      repeatCount: 3,
      repeatIntervalMonths: 1,
    });
    expect(res.status).toBe(201);
    const rows = await rowsForPledge();
    expect(rows.map((r) => r.expectedDate).sort()).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
    await clearRows();
  }, 30_000);

  it("still inserts a single row without repeat fields", async () => {
    const res = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2027-06-15",
    });
    expect(res.status).toBe(201);
    expect(await rowsForPledge()).toHaveLength(1);
    await clearRows();
  }, 30_000);

  it("400s when only one repeat field is sent (and inserts nothing)", async () => {
    const a = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2026-12-01",
      repeatCount: 3,
    });
    expect(a.status).toBe(400);
    const b = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2026-12-01",
      repeatIntervalMonths: 12,
    });
    expect(b.status).toBe(400);
    expect(await rowsForPledge()).toHaveLength(0);
  }, 30_000);

  it("400s on fractional repeat values (no partial rows)", async () => {
    const a = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2026-12-01",
      repeatCount: 2.5,
      repeatIntervalMonths: 12,
    });
    expect(a.status).toBe(400);
    const b = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      expectedDate: "2026-12-01",
      repeatCount: 3,
      repeatIntervalMonths: 1.5,
    });
    expect(b.status).toBe(400);
    expect(await rowsForPledge()).toHaveLength(0);
  }, 30_000);
});
