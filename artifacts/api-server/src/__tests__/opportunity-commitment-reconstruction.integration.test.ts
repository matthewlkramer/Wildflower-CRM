import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `opp_reconstruct_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;

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
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: USER_ID, role: "admin" };
    next();
  },
}));

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  pledgeExpectedPayments: Db["pledgeExpectedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  bulkOperations: Db["bulkOperations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";
let sequence = 0;
const giftIds: string[] = [];
const opportunityIds: string[] = [];
const nextId = (kind: string) => `${RUN}_${kind}_${++sequence}`;

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function seedGift(
  amount: string,
  dateReceived: string,
  allocations: string[] = [amount],
): Promise<string> {
  const id = nextId("gift");
  giftIds.push(id);
  await db.insert(schema.giftsAndPayments).values({
    id,
    name: `Gift ${id}`,
    organizationId: ORG_ID,
    amount,
    dateReceived,
  });
  for (const subAmount of allocations) {
    await db.insert(schema.giftAllocations).values({
      id: nextId("allocation"),
      giftId: id,
      subAmount,
    });
  }
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    pledgeExpectedPayments: dbMod.pledgeExpectedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    bulkOperations: dbMod.bulkOperations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  likeFn = drizzle.like;
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Reconstruction ${RUN}`,
  });
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, () => resolve(running));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (opportunityIds.length) {
    await db
      .delete(schema.pledgeExpectedPayments)
      .where(
        inArrayFn(
          schema.pledgeExpectedPayments.pledgeOrOpportunityId,
          opportunityIds,
        ),
      );
  }
  await db
    .delete(schema.bulkOperations)
    .where(likeFn(schema.bulkOperations.entity, "gifts-and-payments/%pledge%"));
  await db
    .delete(schema.giftAllocations)
    .where(likeFn(schema.giftAllocations.id, `${RUN}%`));
  if (giftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (opportunityIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(
        inArrayFn(
          schema.pledgeAllocations.pledgeOrOpportunityId,
          opportunityIds,
        ),
      );
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, opportunityIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("historical pledge reconstruction", () => {
  it("merge-into-pledge creates a finalized verbal pledge with a schedule", async () => {
    const first = await seedGift("40.00", "2099-06-01");
    const second = await seedGift("60.00", "2099-06-15");
    const result = await post("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [first, second],
      name: `Merged pledge ${RUN}`,
    });
    expect(result.status).toBe(200);
    const pledgeId = result.json.pledgeId as string;
    opportunityIds.push(pledgeId);

    const [pledge] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, pledgeId));
    expect(pledge.commitmentPath).toBe("verbal_pledge");
    expect(pledge.verbalCommitmentAt).toBe("2099-06-01");
    expect(pledge.pledgeCommittedAt).toBe("2099-06-01");
    expect(pledge.writtenPledge).toBe(true);
    expect(pledge.stage).toBe("verbal_confirmation");
    expect(pledge.status).toBe("cash_in");

    const schedule = await db
      .select()
      .from(schema.pledgeExpectedPayments)
      .where(
        eqFn(schema.pledgeExpectedPayments.pledgeOrOpportunityId, pledgeId),
      );
    expect(schedule.map((row) => row.amount).sort()).toEqual([
      "40.00",
      "60.00",
    ]);
    expect(schedule.map((row) => row.expectedDate).sort()).toEqual([
      "2099-06-01",
      "2099-06-15",
    ]);
  }, 30_000);

  it("refuses to attach payments to an unfinalized pledge setup", async () => {
    const giftId = await seedGift("25.00", "2099-07-01");
    const opportunityId = nextId("opportunity");
    opportunityIds.push(opportunityId);
    await db.insert(schema.opportunitiesAndPledges).values({
      id: opportunityId,
      name: `Unfinalized ${RUN}`,
      organizationId: ORG_ID,
      stage: "verbal_confirmation",
      commitmentPath: "verbal_pledge",
      verbalCommitmentAt: "2099-06-20",
      awardedAmount: "25.00",
    });

    const result = await post("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [giftId],
      pledgeId: opportunityId,
    });
    expect(result.status).toBe(409);
    expect(result.json.error).toBe("not_finalized_pledge");
  }, 30_000);

  it("split-into-pledge creates lifecycle authority and installment rows", async () => {
    const giftId = await seedGift("100.00", "2099-08-01", ["40.00", "60.00"]);
    const result = await post(
      `/api/gifts-and-payments/${giftId}/split-into-pledge`,
      { name: `Split pledge ${RUN}` },
    );
    expect(result.status).toBe(200);
    const pledgeId = result.json.pledgeId as string;
    opportunityIds.push(pledgeId);
    for (const id of result.json.giftIds as string[]) {
      if (!giftIds.includes(id)) giftIds.push(id);
    }

    const [pledge] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, pledgeId));
    expect(pledge.commitmentPath).toBe("verbal_pledge");
    expect(pledge.pledgeCommittedAt).toBe("2099-08-01");
    expect(pledge.stage).toBe("verbal_confirmation");
    expect(pledge.status).toBe("cash_in");

    const schedule = await db
      .select()
      .from(schema.pledgeExpectedPayments)
      .where(
        eqFn(schema.pledgeExpectedPayments.pledgeOrOpportunityId, pledgeId),
      );
    expect(schedule.map((row) => row.amount).sort()).toEqual([
      "40.00",
      "60.00",
    ]);
  }, 30_000);
});
