import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `donor_phase3_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const PERSON_ID = `${RUN}_person`;
const HOUSEHOLD_ID = `${RUN}_household`;
const ORG_ID = `${RUN}_org`;
const PI_ID = `${RUN}_pi`;
const GIFT_ID = `${RUN}_gift`;
const GIFT_PROPOSAL_ID = `${RUN}_gift_proposal`;
const PI_PROPOSAL_ID = `${RUN}_pi_proposal`;

const auth = vi.hoisted(() => ({ current: { id: "", role: "admin" } }));
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
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let server: Server;
let baseUrl = "";

async function post(path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: response.status === 204 ? null : await response.json(),
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
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
  await db
    .insert(schema.households)
    .values({ id: HOUSEHOLD_ID, name: "Phase 3 Household" });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    firstName: "Phase",
    lastName: "Three",
    fullName: "Phase Three",
    primaryHouseholdId: HOUSEHOLD_ID,
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: "Phase 3 Organization" });
  await db
    .insert(schema.paymentIntermediaries)
    .values({ id: PI_ID, name: "Phase 3 DAF", type: "daf" });

  // Explicit self lets us create a historical direct-person gift despite the
  // phase-2 insert trigger. Remove it immediately after the insert.
  await db.insert(schema.donorRoutingPreferences).values({
    id: `${RUN}_self`,
    sourceKind: "individual",
    sourcePersonId: PERSON_ID,
    mode: "self",
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "125.00",
    dateReceived: "2025-01-15",
    individualGiverPersonId: PERSON_ID,
    paymentIntermediaryId: PI_ID,
  });
  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourcePersonId, PERSON_ID));

  await db.insert(schema.cleanupQueue).values([
    {
      id: GIFT_PROPOSAL_ID,
      targetType: "gift",
      targetId: GIFT_ID,
      reasonCode: "donor_attribution_review",
      note: "Move to primary household",
      proposalKind: "gift_donor",
      proposalConfidence: "medium",
      proposedChanges: {
        fromDonor: { kind: "individual", id: PERSON_ID, name: "Phase Three" },
        toDonor: {
          kind: "household",
          id: HOUSEHOLD_ID,
          name: "Phase 3 Household",
        },
      },
    },
    {
      id: PI_PROPOSAL_ID,
      targetType: "organization",
      targetId: ORG_ID,
      reasonCode: "donor_intermediary_review",
      note: "Set DAF default",
      proposalKind: "default_intermediary",
      proposalConfidence: "medium",
      proposedChanges: {
        donor: {
          kind: "organization",
          id: ORG_ID,
          name: "Phase 3 Organization",
        },
        paymentIntermediary: { id: PI_ID, name: "Phase 3 DAF", type: "daf" },
      },
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
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(schema.auditLog)
    .where(inArray(schema.auditLog.entityId, [GIFT_ID, ORG_ID, PERSON_ID]));
  await db
    .delete(schema.cleanupQueue)
    .where(inArray(schema.cleanupQueue.id, [GIFT_PROPOSAL_ID, PI_PROPOSAL_ID]));
  await db
    .delete(schema.donorPaymentIntermediaries)
    .where(
      and(
        eq(schema.donorPaymentIntermediaries.organizationId, ORG_ID),
        eq(schema.donorPaymentIntermediaries.paymentIntermediaryId, PI_ID),
      ),
    );
  await db
    .delete(schema.giftsAndPayments)
    .where(eq(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.peopleEntityRoles)
    .where(eq(schema.peopleEntityRoles.personId, PERSON_ID));
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
  await db
    .delete(schema.users)
    .where(inArray(schema.users.id, [ADMIN_ID, MEMBER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("donor attribution phase 3", () => {
  it("applies a historical gift donor proposal without changing intermediary evidence", async () => {
    const result = await post(
      `/api/cleanup-queue/${GIFT_PROPOSAL_ID}/apply-proposal`,
    );
    expect(result.status).toBe(200);
    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eq(schema.giftsAndPayments.id, GIFT_ID));
    expect(gift).toMatchObject({
      organizationId: null,
      individualGiverPersonId: null,
      householdId: HOUSEHOLD_ID,
      paymentIntermediaryId: PI_ID,
      amount: "125.00",
      dateReceived: "2025-01-15",
    });
    const [item] = await db
      .select()
      .from(schema.cleanupQueue)
      .where(eq(schema.cleanupQueue.id, GIFT_PROPOSAL_ID));
    expect(item.status).toBe("resolved");
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, GIFT_ID));
    expect(
      audits.some((row) => row.metadata?.accountingEvidenceChanged === false),
    ).toBe(true);
  });

  it("applies an intermediary-default proposal", async () => {
    const result = await post(
      `/api/cleanup-queue/${PI_PROPOSAL_ID}/apply-proposal`,
    );
    expect(result.status).toBe(200);
    const [link] = await db
      .select()
      .from(schema.donorPaymentIntermediaries)
      .where(
        and(
          eq(schema.donorPaymentIntermediaries.organizationId, ORG_ID),
          eq(schema.donorPaymentIntermediaries.paymentIntermediaryId, PI_ID),
        ),
      );
    expect(link?.isDefault).toBe(true);
  });

  it("rejects applying proposals for non-admin users", async () => {
    await db
      .update(schema.cleanupQueue)
      .set({ status: "open", resolvedAt: null, resolvedByUserId: null })
      .where(eq(schema.cleanupQueue.id, PI_PROPOSAL_ID));
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const result = await post(
      `/api/cleanup-queue/${PI_PROPOSAL_ID}/apply-proposal`,
    );
    expect(result.status).toBe(403);
    auth.current = { id: ADMIN_ID, role: "admin" };
  });

  it("rejects household membership rows at the API and database boundaries", async () => {
    const api = await post("/api/people-entity-roles", {
      personId: PERSON_ID,
      entityType: "household",
      householdId: HOUSEHOLD_ID,
      current: "current",
    });
    expect(api.status).toBe(409);
    await expect(
      db.insert(schema.peopleEntityRoles).values({
        id: `${RUN}_forbidden_household_role`,
        personId: PERSON_ID,
        entityType: "household",
        householdId: HOUSEHOLD_ID,
        current: "current",
      }),
    ).rejects.toThrow();
  });

  it("returns household members from people.primary_household_id", async () => {
    const response = await fetch(`${baseUrl}/api/households/${HOUSEHOLD_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      people: Array<{ personId: string }>;
    };
    expect(body.people.map((member) => member.personId)).toContain(PERSON_ID);
    const roles = await db
      .select()
      .from(schema.peopleEntityRoles)
      .where(eq(schema.peopleEntityRoles.personId, PERSON_ID));
    expect(
      roles.filter((role) => role.entityType === "household"),
    ).toHaveLength(0);
  });
});
