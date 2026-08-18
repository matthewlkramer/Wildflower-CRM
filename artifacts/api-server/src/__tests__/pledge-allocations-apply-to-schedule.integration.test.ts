/**
 * Integration tests for POST /pledge-allocations/apply-to-schedule: one
 * allocation row per scheduled expected payment, grantYear derived
 * SERVER-SIDE from each payment's expectedDate (Wildflower Jul–Jun FY).
 * Pattern follows pledge-expected-payments-repeat.integration.test.ts:
 * mock the Clerk auth gate, boot the real app on an ephemeral port, fetch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `pa_xapply_test_user_${Date.now()}`,
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

const RUN = `paxapply_${Date.now()}`;
const PLEDGE_ID = `${RUN}_pledge`;
const EMPTY_PLEDGE_ID = `${RUN}_pledge_empty`;

describe.skipIf(!HAS_DB)("POST /pledge-allocations/apply-to-schedule", () => {
  type Db = typeof import("@workspace/db");
  let db: Db["db"];
  let users: Db["users"];
  let organizations: Db["organizations"];
  let opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  let pledgeExpectedPayments: Db["pledgeExpectedPayments"];
  let pledgeAllocations: Db["pledgeAllocations"];
  let fiscalYears: Db["fiscalYears"];
  let schools: Db["schools"];
  let eqFn: (typeof import("drizzle-orm"))["eq"];
  let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
  let server: Server;
  let baseUrl: string;

  const post = async (body: unknown) => {
    const res = await fetch(
      `${baseUrl}/api/pledge-allocations/apply-to-schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const allocsForPledge = (pledgeId = PLEDGE_ID) =>
    db
      .select()
      .from(pledgeAllocations)
      .where(eqFn(pledgeAllocations.pledgeOrOpportunityId, pledgeId));

  const clearAllocs = () =>
    db
      .delete(pledgeAllocations)
      .where(
        inArrayFn(pledgeAllocations.pledgeOrOpportunityId, [
          PLEDGE_ID,
          EMPTY_PLEDGE_ID,
        ]),
      );

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    users = dbMod.users;
    organizations = dbMod.organizations;
    opportunitiesAndPledges = dbMod.opportunitiesAndPledges;
    pledgeExpectedPayments = dbMod.pledgeExpectedPayments;
    pledgeAllocations = dbMod.pledgeAllocations;
    fiscalYears = dbMod.fiscalYears;
    schools = dbMod.schools;
    ({ eq: eqFn, inArray: inArrayFn } = await import("drizzle-orm"));

    await db.insert(users).values({
      id: TEST_USER_ID,
      clerkId: `clerk_${TEST_USER_ID}`,
      email: `${TEST_USER_ID}@wildflowerschools.org`,
      role: "admin",
    });
    await db.insert(organizations).values({
      id: `${RUN}_org`,
      name: `Cross-apply Org ${RUN}`,
    });
    await db.insert(schools).values({
      id: `${RUN}_school`,
      name: `Cross-apply School ${RUN}`,
    });
    await db.insert(opportunitiesAndPledges).values([
      {
        id: PLEDGE_ID,
        name: `Cross-apply pledge ${RUN}`,
        organizationId: `${RUN}_org`,
        awardedAmount: "5000000.00",
        stage: "written_commitment",
        writtenPledge: true,
      },
      {
        id: EMPTY_PLEDGE_ID,
        name: `Cross-apply empty pledge ${RUN}`,
        organizationId: `${RUN}_org`,
        stage: "written_commitment",
        writtenPledge: true,
      },
    ]);
    // Ensure the fiscal_years rows the schedule dates map to exist (grant_year
    // is a RESTRICT FK). Insert-if-missing; never delete in cleanup.
    const wanted = ["fy2027", "fy2028", "fy2029"];
    const existing = await db
      .select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(inArrayFn(fiscalYears.id, wanted));
    const have = new Set(existing.map((r) => r.id));
    const missing = wanted.filter((id) => !have.has(id));
    if (missing.length) {
      await db.insert(fiscalYears).values(
        missing.map((id) => ({
          id,
          label: `FY${id.slice(2)}`,
          startDate: `${Number(id.slice(2)) - 1}-07-01`,
          endDate: `${id.slice(2)}-06-30`,
        })),
      );
    }
    // 5-payment schedule spanning an FY boundary: Dec 2026 + Jun 2027 are both
    // fy2027; Jul 2027 rolls to fy2028; Dec 2097 maps to fy2098 which is not
    // expected to exist → exercises the null-grant-year fallback (checked
    // dynamically since the dev DB decides which fiscal_years rows exist).
    await db.insert(pledgeExpectedPayments).values([
      { id: `${RUN}_pep1`, pledgeOrOpportunityId: PLEDGE_ID, expectedDate: "2026-12-01", amount: "1000000" },
      { id: `${RUN}_pep2`, pledgeOrOpportunityId: PLEDGE_ID, expectedDate: "2027-06-15", amount: "1000000" },
      { id: `${RUN}_pep3`, pledgeOrOpportunityId: PLEDGE_ID, expectedDate: "2027-07-15", amount: "1000000" },
      { id: `${RUN}_pep4`, pledgeOrOpportunityId: PLEDGE_ID, expectedDate: "2028-12-01", amount: "1000000" },
      { id: `${RUN}_pep5`, pledgeOrOpportunityId: PLEDGE_ID, expectedDate: "2097-12-01", amount: "1000000" },
    ]);

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
    await clearAllocs();
    await db
      .delete(pledgeExpectedPayments)
      .where(eqFn(pledgeExpectedPayments.pledgeOrOpportunityId, PLEDGE_ID));
    await db
      .delete(opportunitiesAndPledges)
      .where(
        inArrayFn(opportunitiesAndPledges.id, [PLEDGE_ID, EMPTY_PLEDGE_ID]),
      );
    await db.delete(organizations).where(eqFn(organizations.id, `${RUN}_org`));
    await db.delete(schools).where(eqFn(schools.id, `${RUN}_school`));
    await db.delete(users).where(eqFn(users.id, TEST_USER_ID));
  }, 30_000);

  // Leftovers from a previously failed run must never skew row counts.
  beforeEach(async () => {
    await clearAllocs();
  });

  it("creates one allocation per scheduled payment with per-row grant years", async () => {
    const res = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      subAmount: "1000000",
      intendedUsage: "gen_ops",
      notes: "cross-applied",
    });
    expect(res.status).toBe(201);
    expect(res.json.createdCount).toBe(5);
    expect(res.json.data).toHaveLength(5);

    const rows = await allocsForPledge();
    expect(rows).toHaveLength(5);
    // Jul–Jun FY named by ending year. The 2097 payment maps to fy2098 — only
    // stamped when that fiscal_years row exists (RESTRICT FK), else null.
    const [fy2098Row] = await db
      .select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(eqFn(fiscalYears.id, "fy2098"));
    const farExpected = fy2098Row ? "fy2098" : null;
    expect(
      rows.map((r) => r.grantYear).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      ["fy2027", "fy2027", "fy2028", "fy2029", farExpected].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    );
    for (const r of rows) {
      expect(r.subAmount).toBe("1000000.00");
      expect(r.intendedUsage).toBe("gen_ops");
      expect(r.notes).toBe("cross-applied");
    }
    await clearAllocs();
  }, 30_000);

  it("forces directToSchool when a school recipient is set", async () => {
    const res = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      subAmount: "500",
      schoolRecipientId: `${RUN}_school`,
      directToSchool: false,
    });
    expect(res.status).toBe(201);
    const rows = await allocsForPledge();
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.directToSchool).toBe(true);
    await clearAllocs();
  }, 30_000);

  it("400s when the pledge has no scheduled payments (inserts nothing)", async () => {
    const res = await post({
      pledgeOrOpportunityId: EMPTY_PLEDGE_ID,
      subAmount: "1000",
    });
    expect(res.status).toBe(400);
    expect(await allocsForPledge(EMPTY_PLEDGE_ID)).toHaveLength(0);
  }, 30_000);

  it("rejects a caller-supplied grantYear (schema is strict about it)", async () => {
    const res = await post({
      pledgeOrOpportunityId: PLEDGE_ID,
      subAmount: "1000",
      grantYear: "fy2026",
    });
    // Either the schema strips/rejects it — in no case may fy2026 be stamped.
    if (res.status === 201) {
      const rows = await allocsForPledge();
      expect(rows.every((r) => r.grantYear !== "fy2026")).toBe(true);
      await clearAllocs();
    } else {
      expect(res.status).toBe(400);
      expect(await allocsForPledge()).toHaveLength(0);
    }
  }, 30_000);
});
