import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Forward gift intake — POST /opportunities-and-pledges/:id/mint-gift
 * (Task #794 step 1).
 *
 * Money-correctness invariants locked in here:
 *
 *   - evidence-only guard: minting without offBooksException is 409
 *     manual_gift_on_pledge_blocked (payments come from QuickBooks evidence);
 *   - the off-books exception is finance/admin gated (403 for team_member);
 *   - the minted gift derives EVERYTHING from the opportunity: donor XOR FKs
 *     copied verbatim, amount = awarded ?? ask, loanOrGrant inherited;
 *   - pledge allocations are copied SCALED so the gift's allocation rows sum
 *     EXACTLY to the gift amount (header == sum invariant);
 *   - a scope-less opportunity still mints a gift with ONE seeded fallback
 *     allocation (gift-has-allocations invariant);
 *   - a write-off record can never mint (409 invalid_mint_target).
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `mintgift_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const ORG_ID = `${RUN}_org`;
const FY_ID = `${RUN}_fy`; // own FY row so grantYear FK is guaranteed
const OPP_SCOPED = `${RUN}_opp_scoped`; // 2 allocations, awarded 1000
const OPP_BARE = `${RUN}_opp_bare`; // no allocations, ask only
const OPP_WRITEOFF = `${RUN}_opp_wo`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "" } as { id: string; role: string },
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

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  fiscalYears: Db["fiscalYears"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  auditLog: Db["auditLog"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";
const mintedGiftIds: string[] = [];

async function mint(
  oppId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/api/opportunities-and-pledges/${oppId}/mint-gift`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status === 201 && typeof json.id === "string")
    mintedGiftIds.push(json.id);
  return { status: res.status, json };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    fiscalYears: dbMod.fiscalYears,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    auditLog: dbMod.auditLog,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `MintGift Org ${RUN}` });
  await db
    .insert(schema.fiscalYears)
    .values({ id: FY_ID, label: `MintGift FY ${RUN}` })
    .onConflictDoNothing();

  await db.insert(schema.opportunitiesAndPledges).values([
    {
      id: OPP_SCOPED,
      name: `MintGift scoped pledge ${RUN}`,
      organizationId: ORG_ID,
      stage: "verbal_confirmation",
      writtenPledge: true,
      askAmount: "1500.00",
      awardedAmount: "1000.00",
      loanOrGrant: "grant",
    },
    {
      id: OPP_BARE,
      name: `MintGift bare opp ${RUN}`,
      organizationId: ORG_ID,
      stage: "in_conversation",
      askAmount: "750.00",
      // no awardedAmount → amount falls back to the ask
    },
    {
      id: OPP_WRITEOFF,
      name: `MintGift write-off ${RUN}`,
      organizationId: ORG_ID,
      stage: "verbal_confirmation",
      writtenPledge: true,
      awardedAmount: "-200.00",
      isWriteOff: true,
    },
  ]);

  // Uneven plan lines (1/3 – 2/3 of the awarded amount) so proportional
  // scaling + last-line remainder absorption is actually exercised.
  await db.insert(schema.pledgeAllocations).values([
    {
      id: `${RUN}_pa1`,
      pledgeOrOpportunityId: OPP_SCOPED,
      subAmount: "333.33",
      grantYear: FY_ID,
    },
    {
      id: `${RUN}_pa2`,
      pledgeOrOpportunityId: OPP_SCOPED,
      subAmount: "666.67",
      grantYear: FY_ID,
    },
  ]);

  auth.current = { id: ADMIN_ID, role: "admin" };
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
  if (mintedGiftIds.length) {
    await db
      .delete(schema.auditLog)
      .where(inArrayFn(schema.auditLog.entityId, mintedGiftIds));
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, mintedGiftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, mintedGiftIds));
  }
  await db
    .delete(schema.pledgeAllocations)
    .where(inArrayFn(schema.pledgeAllocations.id, [`${RUN}_pa1`, `${RUN}_pa2`]));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(
      inArrayFn(schema.opportunitiesAndPledges.id, [
        OPP_SCOPED,
        OPP_BARE,
        OPP_WRITEOFF,
      ]),
    );
  await db.delete(schema.fiscalYears).where(eqFn(schema.fiscalYears.id, FY_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [ADMIN_ID, MEMBER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("mint-gift forward intake", () => {
  it("blocks manual minting without the off-books exception (evidence-only guard)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await mint(OPP_SCOPED, {});
    expect(status).toBe(409);
    expect(json.error).toBe("manual_gift_on_pledge_blocked");
  });

  it("gates the off-books exception to finance/admin (403 for team_member)", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const { status, json } = await mint(OPP_SCOPED, { offBooksException: true });
    expect(status).toBe(403);
    expect(json.error).toBe("finance_role_required");
  });

  it("never mints from a write-off record", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await mint(OPP_WRITEOFF, { offBooksException: true });
    expect(status).toBe(409);
    expect(json.error).toBe("invalid_mint_target");
  });

  it("mints from a scoped pledge: donor copied, amount = awarded, allocations scaled to sum EXACTLY", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await mint(OPP_SCOPED, { offBooksException: true });
    expect(status).toBe(201);
    const giftId = json.id as string;

    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, giftId));
    // Donor XOR copied verbatim (org donor, other two null).
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.individualGiverPersonId).toBeNull();
    expect(gift.householdId).toBeNull();
    // Amount = awardedAmount (1000), NOT the ask (1500); flags inherited.
    expect(Number(gift.amount)).toBeCloseTo(1000);
    expect(gift.opportunityId).toBe(OPP_SCOPED);
    expect(gift.loanOrGrant).toBe("grant");

    // Allocations: copied from the pledge plan, scaled so they sum EXACTLY to
    // the gift amount, stamped with their source pledge allocation.
    const allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, giftId));
    expect(allocs.length).toBe(2);
    const sum = allocs.reduce((acc, a) => acc + Number(a.subAmount ?? 0), 0);
    expect(sum).toBeCloseTo(1000, 2);
    expect(
      allocs.map((a) => a.sourcePledgeAllocationId).sort(),
    ).toEqual([`${RUN}_pa1`, `${RUN}_pa2`]);
    for (const a of allocs) expect(a.grantYear).toBe(FY_ID);
  });

  it("a scope-less opportunity still mints, with ONE seeded fallback allocation and amount = ask", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await mint(OPP_BARE, { offBooksException: true });
    expect(status).toBe(201);
    const giftId = json.id as string;

    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, giftId));
    expect(Number(gift.amount)).toBeCloseTo(750); // awarded null → ask

    const allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, giftId));
    expect(allocs.length).toBe(1); // gift never lands scope-less
  });
});
