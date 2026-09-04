import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `fundraising_freeze_${Date.now()}`;

const USER_ID = `${RUN}_admin`;
const ORG_ID = `${RUN}_org`;
const FY_ID = `${RUN}_fy`;
const CLOSED_DATE = "2188-11-15";

const CONVERT_PLEDGE = `${RUN}_convert_pledge`;
const CONVERT_GIFT = `${RUN}_convert_gift`;
const CONVERT_UNIT = `${RUN}_convert_unit`;
const REVERT_PLEDGE = `${RUN}_revert_pledge`;
const DETACH_PLEDGE = `${RUN}_detach_pledge`;
const DETACH_GIFT = `${RUN}_detach_gift`;
const VERBAL_OPP = `${RUN}_verbal_opp`;
const FINALIZE_CURRENT = `${RUN}_finalize_current`;
const FINALIZE_TARGET = `${RUN}_finalize_target`;
const DEDUP_GIFT_PRIMARY = `${RUN}_dedup_gift_primary`;
const DEDUP_GIFT_LOSER = `${RUN}_dedup_gift_loser`;
const DEDUP_OPP_PRIMARY = `${RUN}_dedup_opp_primary`;
const DEDUP_OPP_LOSER = `${RUN}_dedup_opp_loser`;

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

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
}));

type DbModule = typeof import("@workspace/db");
let db: DbModule["db"];
let schema: DbModule;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";

function finalizedPledge(id: string, actualCompletionDate: string | null) {
  return {
    id,
    name: `Pledge ${id}`,
    organizationId: ORG_ID,
    askAmount: "100.00",
    awardedAmount: "100.00",
    stage: "verbal_confirmation" as const,
    commitmentPath: "written_pledge" as const,
    verbalCommitmentAt: "2188-10-01",
    pledgeCommittedAt: "2188-10-15",
    actualCompletionDate,
    grantLetterUrl: "https://example.org/pledge.pdf",
    writtenPledge: true,
  };
}

async function request(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;
  likeFn = drizzle.like;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@example.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Fundraising freeze ${RUN}`,
  });
  await db.insert(schema.fiscalYears).values({
    id: FY_ID,
    label: `Closed FY ${RUN}`,
    startDate: "2188-07-01",
    endDate: "2189-06-30",
    auditClosedAt: new Date(),
    auditClosedByUserId: USER_ID,
  });

  await db.insert(schema.opportunitiesAndPledges).values([
    finalizedPledge(CONVERT_PLEDGE, CLOSED_DATE),
    finalizedPledge(REVERT_PLEDGE, CLOSED_DATE),
    finalizedPledge(DETACH_PLEDGE, null),
    {
      id: VERBAL_OPP,
      name: `Verbal opportunity ${RUN}`,
      organizationId: ORG_ID,
      askAmount: "100.00",
      stage: "in_conversation",
      actualCompletionDate: CLOSED_DATE,
    },
    {
      id: FINALIZE_CURRENT,
      name: `Finalize current ${RUN}`,
      organizationId: ORG_ID,
      askAmount: "100.00",
      awardedAmount: "100.00",
      stage: "verbal_confirmation",
      commitmentPath: "written_pledge",
      verbalCommitmentAt: "2188-10-01",
      actualCompletionDate: CLOSED_DATE,
      grantLetterUrl: "https://example.org/pledge.pdf",
      writtenPledge: false,
    },
    {
      id: FINALIZE_TARGET,
      name: `Finalize target ${RUN}`,
      organizationId: ORG_ID,
      askAmount: "100.00",
      awardedAmount: "100.00",
      stage: "verbal_confirmation",
      commitmentPath: "written_pledge",
      verbalCommitmentAt: "2188-10-01",
      actualCompletionDate: null,
      grantLetterUrl: "https://example.org/pledge.pdf",
      writtenPledge: false,
    },
    {
      id: DEDUP_OPP_PRIMARY,
      name: `Duplicate opportunity primary ${RUN}`,
      organizationId: ORG_ID,
      askAmount: "100.00",
      stage: "in_conversation",
      actualCompletionDate: CLOSED_DATE,
    },
    {
      id: DEDUP_OPP_LOSER,
      name: `Duplicate opportunity loser ${RUN}`,
      organizationId: ORG_ID,
      askAmount: "100.00",
      stage: "in_conversation",
      actualCompletionDate: CLOSED_DATE,
    },
  ]);

  await db.insert(schema.giftsAndPayments).values([
    {
      id: CONVERT_GIFT,
      name: `Convert gift ${RUN}`,
      organizationId: ORG_ID,
      opportunityId: CONVERT_PLEDGE,
      amount: "100.00",
      dateReceived: CLOSED_DATE,
    },
    {
      id: DETACH_GIFT,
      name: `Detach gift ${RUN}`,
      organizationId: ORG_ID,
      opportunityId: DETACH_PLEDGE,
      amount: "100.00",
      dateReceived: CLOSED_DATE,
    },
    {
      id: DEDUP_GIFT_PRIMARY,
      name: `Duplicate gift primary ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: CLOSED_DATE,
    },
    {
      id: DEDUP_GIFT_LOSER,
      name: `Duplicate gift loser ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: CLOSED_DATE,
    },
  ]);
  await db.insert(schema.giftAllocations).values([
    {
      id: `${RUN}_convert_gift_alloc`,
      giftId: CONVERT_GIFT,
      subAmount: "100.00",
    },
    {
      id: `${RUN}_detach_gift_alloc`,
      giftId: DETACH_GIFT,
      subAmount: "100.00",
    },
    {
      id: `${RUN}_dedup_gift_primary_alloc`,
      giftId: DEDUP_GIFT_PRIMARY,
      subAmount: "100.00",
    },
    {
      id: `${RUN}_dedup_gift_loser_alloc`,
      giftId: DEDUP_GIFT_LOSER,
      subAmount: "100.00",
    },
  ]);
  await db.insert(schema.paymentUnits).values([
    {
      id: CONVERT_UNIT,
      kind: "other",
      giftId: CONVERT_GIFT,
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: CLOSED_DATE,
      lifecycle: "received",
      createdTheGift: true,
    },
    {
      id: `${RUN}_detach_unit`,
      kind: "other",
      giftId: DETACH_GIFT,
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: CLOSED_DATE,
      lifecycle: "received",
    },
  ]);

  const pledgeIds = [
    CONVERT_PLEDGE,
    REVERT_PLEDGE,
    DETACH_PLEDGE,
    FINALIZE_CURRENT,
    FINALIZE_TARGET,
  ];
  await db.insert(schema.pledgeAllocations).values(
    pledgeIds.map((pledgeId) => ({
      id: `${pledgeId}_alloc`,
      pledgeOrOpportunityId: pledgeId,
      subAmount: "100.00",
      status: "committed" as const,
    })),
  );
  await db.insert(schema.pledgeExpectedPayments).values(
    pledgeIds.map((pledgeId) => ({
      id: `${pledgeId}_expected`,
      pledgeOrOpportunityId: pledgeId,
      expectedDate: CLOSED_DATE,
      amount: "100.00",
    })),
  );

  auth.current = { id: USER_ID, role: "admin" };
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
  await db.delete(schema.fiscalYears).where(eqFn(schema.fiscalYears.id, FY_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("fundraising action fiscal-year freeze guards", () => {
  it("blocks pledge-to-gift conversion in a closed fiscal year", async () => {
    const result = await request(
      `/api/opportunities-and-pledges/${CONVERT_PLEDGE}/convert-to-standalone-gift`,
    );
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: "fiscal_year_frozen" });
  });

  it("blocks reverting a closed-year pledge", async () => {
    const result = await request(
      `/api/opportunities-and-pledges/${REVERT_PLEDGE}/revert-to-opportunity`,
      { stage: "in_conversation" },
    );
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: "fiscal_year_frozen" });
  });

  it("blocks detaching a closed-year gift from its pledge", async () => {
    const result = await request(
      `/api/gifts-and-payments/${DETACH_GIFT}/detach-from-pledge`,
    );
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: "fiscal_year_frozen" });

    const [gift] = await db
      .select({ opportunityId: schema.giftsAndPayments.opportunityId })
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, DETACH_GIFT));
    expect(gift?.opportunityId).toBe(DETACH_PLEDGE);
  });

  it("blocks deduplicating gifts from a closed fiscal year", async () => {
    const result = await request("/api/gifts-and-payments/merge", {
      primaryId: DEDUP_GIFT_PRIMARY,
      mergeIds: [DEDUP_GIFT_LOSER],
      mode: "deduplicate",
    });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: "fiscal_year_frozen" });
  });

  it("blocks deduplicating opportunities from a closed fiscal year", async () => {
    const result = await request(
      "/api/opportunities-and-pledges/deduplicate",
      {
        primaryId: DEDUP_OPP_PRIMARY,
        mergeIds: [DEDUP_OPP_LOSER],
      },
    );
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: "fiscal_year_frozen" });
  });

  it("blocks recording a verbal commitment on a closed-year record", async () => {
    const result = await request(
      `/api/opportunities-and-pledges/${VERBAL_OPP}/record-verbal-commitment`,
      {
        commitmentPath: "written_pledge",
        verbalCommitmentAt: CLOSED_DATE,
        confirmedAmount: "100.00",
      },
    );
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: "fiscal_year_frozen" });
  });

  it("checks both the current and target fiscal years when finalizing", async () => {
    const current = await request(
      `/api/opportunities-and-pledges/${FINALIZE_CURRENT}/finalize-pledge`,
      { pledgeCommittedAt: "2190-08-01" },
    );
    expect(current.status).toBe(409);
    expect(current.json).toMatchObject({
      error: "fiscal_year_frozen",
      details: { side: "current" },
    });

    const target = await request(
      `/api/opportunities-and-pledges/${FINALIZE_TARGET}/finalize-pledge`,
      { pledgeCommittedAt: CLOSED_DATE },
    );
    expect(target.status).toBe(409);
    expect(target.json).toMatchObject({
      error: "fiscal_year_frozen",
      details: { side: "target" },
    });
  });
});
