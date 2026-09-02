import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `fundraising_actions_${Date.now()}`;

const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const ORG_A = `${RUN}_org_a`;
const ORG_B = `${RUN}_org_b`;

const CONVERT_PLEDGE = `${RUN}_convert_pledge`;
const CONVERT_GIFT = `${RUN}_convert_gift`;
const CONVERT_ALLOC = `${RUN}_convert_alloc`;
const CONVERT_PLAN = `${RUN}_convert_plan`;
const CONVERT_UNIT = `${RUN}_convert_unit`;

const MULTI_UNIT_PLEDGE = `${RUN}_multi_unit_pledge`;
const MULTI_UNIT_GIFT = `${RUN}_multi_unit_gift`;
const MULTI_UNIT_ALLOC = `${RUN}_multi_unit_alloc`;
const MULTI_UNIT_1 = `${RUN}_multi_unit_1`;
const MULTI_UNIT_2 = `${RUN}_multi_unit_2`;

const ARCHIVED_EXTRA_PLEDGE = `${RUN}_archived_extra_pledge`;
const ARCHIVED_EXTRA_ACTIVE_GIFT = `${RUN}_archived_extra_active_gift`;
const ARCHIVED_EXTRA_GIFT = `${RUN}_archived_extra_gift`;
const ARCHIVED_EXTRA_ALLOC = `${RUN}_archived_extra_alloc`;
const ARCHIVED_EXTRA_UNIT = `${RUN}_archived_extra_unit`;

const REVERT_VERBAL_PLEDGE = `${RUN}_revert_verbal_pledge`;
const REVERT_VERBAL_ALLOC = `${RUN}_revert_verbal_alloc`;
const REVERT_VERBAL_PLAN = `${RUN}_revert_verbal_plan`;
const REVERT_GENERAL_PLEDGE = `${RUN}_revert_general_pledge`;
const REVERT_GENERAL_ALLOC = `${RUN}_revert_general_alloc`;
const REVERT_GENERAL_PLAN = `${RUN}_revert_general_plan`;

const DETACH_PLEDGE = `${RUN}_detach_pledge`;
const DETACH_GIFT = `${RUN}_detach_gift`;
const DETACH_ALLOC = `${RUN}_detach_alloc`;
const DETACH_UNIT = `${RUN}_detach_unit`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "admin" } as { id: string; role: string },
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

vi.mock("@clerk/express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...actual,
    clerkMiddleware:
      () =>
      (_req: unknown, _res: unknown, next: () => void): void =>
        next(),
  };
});

type DbModule = typeof import("@workspace/db");
let db: DbModule["db"];
let schema: DbModule;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

function pledgeValues(id: string, amount = "100.00") {
  return {
    id,
    name: `Pledge ${id}`,
    organizationId: ORG_A,
    askAmount: amount,
    awardedAmount: amount,
    stage: "verbal_confirmation" as const,
    commitmentPath: "written_pledge" as const,
    verbalCommitmentAt: "2026-01-15",
    pledgeCommittedAt: "2026-01-20",
    grantLetterUrl: "https://example.org/pledge.pdf",
    writtenPledge: true,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  likeFn = drizzle.like;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@example.org`,
      role: "admin",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@example.org`,
      role: "team_member",
    },
  ]);
  await db.insert(schema.organizations).values([
    { id: ORG_A, name: `Fundraising actions A ${RUN}` },
    { id: ORG_B, name: `Fundraising actions B ${RUN}` },
  ]);

  await db.insert(schema.opportunitiesAndPledges).values([
    pledgeValues(CONVERT_PLEDGE),
    pledgeValues(MULTI_UNIT_PLEDGE),
    pledgeValues(ARCHIVED_EXTRA_PLEDGE),
    {
      ...pledgeValues(REVERT_VERBAL_PLEDGE, "250.00"),
      projectedCloseDate: "2026-06-30",
    },
    {
      ...pledgeValues(REVERT_GENERAL_PLEDGE, "300.00"),
      askAmount: null,
      projectedCloseDate: "2026-08-15",
    },
    pledgeValues(DETACH_PLEDGE, "80.00"),
  ]);

  await db.insert(schema.giftsAndPayments).values([
    {
      id: CONVERT_GIFT,
      name: `One payment ${RUN}`,
      organizationId: ORG_A,
      opportunityId: CONVERT_PLEDGE,
      amount: "100.00",
      dateReceived: "2026-02-01",
    },
    {
      id: MULTI_UNIT_GIFT,
      organizationId: ORG_A,
      opportunityId: MULTI_UNIT_PLEDGE,
      amount: "100.00",
      dateReceived: "2026-02-02",
    },
    {
      id: ARCHIVED_EXTRA_ACTIVE_GIFT,
      organizationId: ORG_A,
      opportunityId: ARCHIVED_EXTRA_PLEDGE,
      amount: "100.00",
      dateReceived: "2026-02-03",
    },
    {
      id: ARCHIVED_EXTRA_GIFT,
      organizationId: ORG_A,
      opportunityId: ARCHIVED_EXTRA_PLEDGE,
      amount: "25.00",
      dateReceived: "2025-01-01",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: DETACH_GIFT,
      organizationId: ORG_A,
      opportunityId: DETACH_PLEDGE,
      amount: "80.00",
      dateReceived: "2026-02-04",
    },
  ]);

  await db.insert(schema.giftAllocations).values([
    { id: CONVERT_ALLOC, giftId: CONVERT_GIFT, subAmount: "100.00" },
    { id: MULTI_UNIT_ALLOC, giftId: MULTI_UNIT_GIFT, subAmount: "100.00" },
    {
      id: ARCHIVED_EXTRA_ALLOC,
      giftId: ARCHIVED_EXTRA_ACTIVE_GIFT,
      subAmount: "100.00",
    },
    { id: DETACH_ALLOC, giftId: DETACH_GIFT, subAmount: "80.00" },
  ]);

  await db.insert(schema.pledgeAllocations).values([
    {
      id: `${RUN}_pa_convert`,
      pledgeOrOpportunityId: CONVERT_PLEDGE,
      subAmount: "100.00",
      status: "committed",
    },
    {
      id: `${RUN}_pa_multi`,
      pledgeOrOpportunityId: MULTI_UNIT_PLEDGE,
      subAmount: "100.00",
      status: "committed",
    },
    {
      id: `${RUN}_pa_archived`,
      pledgeOrOpportunityId: ARCHIVED_EXTRA_PLEDGE,
      subAmount: "100.00",
      status: "committed",
    },
    {
      id: REVERT_VERBAL_ALLOC,
      pledgeOrOpportunityId: REVERT_VERBAL_PLEDGE,
      subAmount: "250.00",
      status: "committed",
    },
    {
      id: REVERT_GENERAL_ALLOC,
      pledgeOrOpportunityId: REVERT_GENERAL_PLEDGE,
      subAmount: "300.00",
      status: "committed_with_conditions",
    },
    {
      id: `${RUN}_pa_detach`,
      pledgeOrOpportunityId: DETACH_PLEDGE,
      subAmount: "80.00",
      status: "committed",
    },
  ]);

  await db.insert(schema.pledgeExpectedPayments).values([
    {
      id: CONVERT_PLAN,
      pledgeOrOpportunityId: CONVERT_PLEDGE,
      expectedDate: "2026-02-01",
      amount: "100.00",
    },
    {
      id: REVERT_VERBAL_PLAN,
      pledgeOrOpportunityId: REVERT_VERBAL_PLEDGE,
      expectedDate: "2026-05-01",
      amount: "250.00",
    },
    {
      id: REVERT_GENERAL_PLAN,
      pledgeOrOpportunityId: REVERT_GENERAL_PLEDGE,
      expectedDate: "2026-05-01",
      amount: "300.00",
    },
  ]);

  await db.insert(schema.paymentUnits).values([
    {
      id: CONVERT_UNIT,
      kind: "other",
      giftId: CONVERT_GIFT,
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: "2026-02-01",
      lifecycle: "received",
      createdTheGift: true,
    },
    {
      id: MULTI_UNIT_1,
      kind: "other",
      giftId: MULTI_UNIT_GIFT,
      grossAmount: "60.00",
      netAmount: "60.00",
      receivedDate: "2026-02-02",
      lifecycle: "received",
    },
    {
      id: MULTI_UNIT_2,
      kind: "other",
      giftId: MULTI_UNIT_GIFT,
      grossAmount: "40.00",
      netAmount: "40.00",
      receivedDate: "2026-02-02",
      lifecycle: "received",
    },
    {
      id: ARCHIVED_EXTRA_UNIT,
      kind: "other",
      giftId: ARCHIVED_EXTRA_ACTIVE_GIFT,
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: "2026-02-03",
      lifecycle: "received",
    },
    {
      id: DETACH_UNIT,
      kind: "other",
      giftId: DETACH_GIFT,
      grossAmount: "80.00",
      netAmount: "80.00",
      receivedDate: "2026-02-04",
      lifecycle: "received",
    },
  ]);

  auth.current = { id: ADMIN_ID, role: "admin" };
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db
    .delete(schema.auditLog)
    .where(likeFn(schema.auditLog.entityId, `${RUN}%`));
  await db
    .delete(schema.paymentUnits)
    .where(likeFn(schema.paymentUnits.id, `${RUN}%`));
  await db
    .delete(schema.pledgeExpectedPayments)
    .where(likeFn(schema.pledgeExpectedPayments.id, `${RUN}%`));
  await db
    .delete(schema.giftAllocations)
    .where(likeFn(schema.giftAllocations.id, `${RUN}%`));
  await db
    .delete(schema.giftsAndPayments)
    .where(likeFn(schema.giftsAndPayments.id, `${RUN}%`));
  await db
    .delete(schema.pledgeAllocations)
    .where(likeFn(schema.pledgeAllocations.id, `${RUN}%`));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(likeFn(schema.opportunitiesAndPledges.id, `${RUN}%`));
  await db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, [ORG_A, ORG_B]));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [ADMIN_ID, MEMBER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("record-local fundraising corrections", () => {
  it("rewrites a one-payment pledge exactly as an original stand-alone gift", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const result = await request(
      "POST",
      `/api/opportunities-and-pledges/${CONVERT_PLEDGE}/convert-to-standalone-gift`,
      { reason: "The award was never a pledge." },
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      giftId: CONVERT_GIFT,
      opportunityId: CONVERT_PLEDGE,
    });

    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, CONVERT_GIFT));
    expect(gift.opportunityId).toBe(CONVERT_PLEDGE);

    const [opportunity] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, CONVERT_PLEDGE));
    expect(opportunity).toMatchObject({
      archivedAt: null,
      commitmentPath: "gift",
      verbalCommitmentAt: "2026-01-15",
      pledgeCommittedAt: null,
      writtenPledge: false,
      stage: "verbal_confirmation",
      status: "cash_in",
      actualCompletionDate: "2026-02-01",
    });
    expect(Number(opportunity.awardedAmount)).toBeCloseTo(100);

    const schedule = await db
      .select()
      .from(schema.pledgeExpectedPayments)
      .where(
        eqFn(
          schema.pledgeExpectedPayments.pledgeOrOpportunityId,
          CONVERT_PLEDGE,
        ),
      );
    expect(schedule).toHaveLength(0);

    const [plan] = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.id, `${RUN}_pa_convert`));
    expect(plan.status).toBe("working");

    const [unit] = await db
      .select()
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, CONVERT_UNIT));
    expect(unit).toMatchObject({ giftId: CONVERT_GIFT, grossAmount: "100.00" });

    const giftDetail = await request(
      "GET",
      `/api/gifts-and-payments/${CONVERT_GIFT}`,
    );
    expect(giftDetail.status).toBe(200);
    expect(giftDetail.json.type).toBe("standard_gift");
  });

  it("requires exactly one received payment unit for pledge-to-gift conversion", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const result = await request(
      "POST",
      `/api/opportunities-and-pledges/${MULTI_UNIT_PLEDGE}/convert-to-standalone-gift`,
      {},
    );
    expect(result.status).toBe(409);
    expect(result.json.error).toBe("one_received_payment_required");
  });

  it("counts archived linked gifts when enforcing the one-payment correction", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const result = await request(
      "POST",
      `/api/opportunities-and-pledges/${ARCHIVED_EXTRA_PLEDGE}/convert-to-standalone-gift`,
      {},
    );
    expect(result.status).toBe(409);
    expect(result.json.error).toBe("one_payment_required");
  });

  it("restricts pledge-to-gift conversion to administrators", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const result = await request(
      "POST",
      `/api/opportunities-and-pledges/${MULTI_UNIT_PLEDGE}/convert-to-standalone-gift`,
      {},
    );
    expect(result.status).toBe(403);
    auth.current = { id: ADMIN_ID, role: "admin" };
  });

  it("reverts an unpaid pledge to a verbal gift commitment awaiting payment", async () => {
    const result = await request(
      "POST",
      `/api/opportunities-and-pledges/${REVERT_VERBAL_PLEDGE}/revert-to-verbal-gift`,
      {
        commitmentDate: "2026-03-01",
        expectedDate: "2026-04-01",
        reason: "The donor only promised a single gift.",
      },
    );
    expect(result.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, REVERT_VERBAL_PLEDGE));
    expect(row).toMatchObject({
      commitmentPath: "gift",
      verbalCommitmentAt: "2026-03-01",
      pledgeCommittedAt: null,
      writtenPledge: false,
      stage: "verbal_confirmation",
      status: "open",
      projectedCloseDate: "2026-04-01",
    });
    const [allocation] = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.id, REVERT_VERBAL_ALLOC));
    expect(allocation.status).toBe("working");
    const schedule = await db
      .select()
      .from(schema.pledgeExpectedPayments)
      .where(eqFn(schema.pledgeExpectedPayments.id, REVERT_VERBAL_PLAN));
    expect(schedule).toHaveLength(0);
  });

  it("reverts an unpaid pledge to a general opportunity", async () => {
    const result = await request(
      "POST",
      `/api/opportunities-and-pledges/${REVERT_GENERAL_PLEDGE}/revert-to-opportunity`,
      {
        stage: "warm_lead",
        projectedCloseDate: "2026-09-15",
        reason: "No commitment was actually made.",
      },
    );
    expect(result.status).toBe(200);
    const [row] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, REVERT_GENERAL_PLEDGE));
    expect(row).toMatchObject({
      askAmount: "300.00",
      awardedAmount: null,
      commitmentPath: null,
      verbalCommitmentAt: null,
      pledgeCommittedAt: null,
      writtenPledge: false,
      stage: "warm_lead",
      status: "open",
      projectedCloseDate: "2026-09-15",
    });
  });

  it("detaches a mislinked pledge payment without changing its received money", async () => {
    const before = await db
      .select()
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, DETACH_UNIT))
      .then((rows) => rows[0]);
    const result = await request(
      "POST",
      `/api/gifts-and-payments/${DETACH_GIFT}/detach-from-pledge`,
      { reason: "This was a direct gift." },
    );
    expect(result.status).toBe(200);

    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, DETACH_GIFT));
    expect(gift.opportunityId).toBeNull();
    const after = await db
      .select()
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, DETACH_UNIT))
      .then((rows) => rows[0]);
    expect(after).toMatchObject({
      giftId: before.giftId,
      grossAmount: before.grossAmount,
      receivedDate: before.receivedDate,
      lifecycle: before.lifecycle,
    });
  });

  it("blocks generic gift linkage and donor edits that need correction workflows", async () => {
    const relink = await request(
      "PATCH",
      `/api/gifts-and-payments/${CONVERT_GIFT}`,
      { opportunityId: null },
    );
    expect(relink.status).toBe(409);
    expect(relink.json.error).toBe("gift_pledge_link_correction_required");

    const donor = await request(
      "PATCH",
      `/api/gifts-and-payments/${CONVERT_GIFT}`,
      {
        organizationId: ORG_B,
        individualGiverPersonId: null,
        householdId: null,
      },
    );
    expect(donor.status).toBe(409);
    expect(donor.json.error).toBe("gift_pledge_donor_conflict");
  });

  it("blocks changing an opportunity donor after a linked gift exists", async () => {
    const result = await request(
      "PATCH",
      `/api/opportunities-and-pledges/${CONVERT_PLEDGE}`,
      {
        organizationId: ORG_B,
        individualGiverPersonId: null,
        householdId: null,
      },
    );
    expect(result.status).toBe(409);
    expect(result.json.error).toBe("opportunity_donor_correction_required");
  });
});
