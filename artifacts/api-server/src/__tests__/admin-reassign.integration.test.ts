import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the admin-only offboarding / owner-reassignment flow
 * (routes/adminReassign.ts):
 *   - GET  /admin/owned-record-counts?userId=…
 *   - POST /admin/reassign-owner  { fromUserId, toUserId, archiveSource }
 *
 * Seeds one record owned by the source user in EVERY owner-bearing table
 * (people, organizations, opportunities, gifts, interactions, tasks via
 * assignee, grant_leads via assignee) so the count + the transactional move are
 * exercised across the full surface. A task whose `created_by_user_id` is the
 * source user verifies that provenance column is deliberately NOT reassigned.
 *
 * Asserts:
 *   - non-admins get 403 on both endpoints
 *   - the count preview reports 1 per table (total 7) for the source user
 *   - same-user / unknown-user / archived-destination requests are rejected
 *   - a successful reassign moves all 7 rows to the destination, leaves
 *     `tasks.created_by_user_id` untouched, archives the source user, and writes
 *     a single `bulk_update` audit row
 *
 * Only the Clerk auth gate (`requireAuth`) is mocked, injecting a mutable app
 * user so each test can switch viewer/role. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `reassignspec_${Date.now()}`;
const FROM_ID = `${RUN}_from`;
const TO_ID = `${RUN}_to`;
const ADMIN_ID = `${RUN}_admin`;
const ARCHIVED_ID = `${RUN}_archived`;
const OTHER_ID = `${RUN}_other`;

const ORG_ID = `${RUN}_org`;
const ORG_DONOR_ID = `${RUN}_orgdonor`;
const PERSON_ID = `${RUN}_person`;
const OPP_ID = `${RUN}_opp`;
const GIFT_ID = `${RUN}_gift`;
const INTERACTION_ID = `${RUN}_interaction`;
const TASK_ID = `${RUN}_task`;
const GRANT_LEAD_ID = `${RUN}_grantlead`;

type Counts = {
  people: number;
  organizations: number;
  opportunities: number;
  gifts: number;
  interactions: number;
  tasks: number;
  grantLeads: number;
  total: number;
};

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
  people: Db["people"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  giftsAndPayments: Db["giftsAndPayments"];
  interactions: Db["interactions"];
  tasks: Db["tasks"];
  grantLeads: Db["grantLeads"];
  auditLog: Db["auditLog"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function getCounts(
  userId: string,
): Promise<{ status: number; json: Counts }> {
  const res = await fetch(
    `${baseUrl}/api/admin/owned-record-counts?userId=${encodeURIComponent(userId)}`,
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Counts };
}

async function reassign(
  body: unknown,
): Promise<{ status: number; json: { error?: string; reassigned?: Counts; archivedSource?: boolean } }> {
  const res = await fetch(`${baseUrl}/api/admin/reassign-owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as never };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    people: dbMod.people,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    giftsAndPayments: dbMod.giftsAndPayments,
    interactions: dbMod.interactions,
    tasks: dbMod.tasks,
    grantLeads: dbMod.grantLeads,
    auditLog: dbMod.auditLog,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: FROM_ID,
      clerkId: `clerk_${FROM_ID}`,
      email: `${FROM_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: TO_ID,
      clerkId: `clerk_${TO_ID}`,
      email: `${TO_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: ARCHIVED_ID,
      clerkId: `clerk_${ARCHIVED_ID}`,
      email: `${ARCHIVED_ID}@wildflowerschools.org`,
      role: "team_member",
      archivedAt: new Date(),
    },
    {
      id: OTHER_ID,
      clerkId: `clerk_${OTHER_ID}`,
      email: `${OTHER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);

  await db.insert(schema.organizations).values([
    { id: ORG_ID, name: `Reassign Org ${RUN}`, ownerUserId: FROM_ID },
    // Donor org for the opportunity/gift (not owned by FROM_ID).
    { id: ORG_DONOR_ID, name: `Donor Org ${RUN}` },
  ]);

  await db
    .insert(schema.people)
    .values({ id: PERSON_ID, fullName: `Reassign Person ${RUN}`, ownerUserId: FROM_ID });

  await db.insert(schema.opportunitiesAndPledges).values({
    id: OPP_ID,
    name: `Reassign Opp ${RUN}`,
    organizationId: ORG_DONOR_ID,
    ownerUserId: FROM_ID,
  });

  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    name: `Reassign Gift ${RUN}`,
    organizationId: ORG_DONOR_ID,
    ownerUserId: FROM_ID,
  });

  await db.insert(schema.interactions).values({
    id: INTERACTION_ID,
    kind: "meeting",
    occurredAt: new Date(),
    summary: `Reassign Interaction ${RUN}`,
    ownerUserId: FROM_ID,
  });

  await db.insert(schema.tasks).values({
    id: TASK_ID,
    title: `Reassign Task ${RUN}`,
    assigneeUserId: FROM_ID,
    createdByUserId: FROM_ID,
  });

  await db.insert(schema.grantLeads).values({
    id: GRANT_LEAD_ID,
    dedupeKey: `dedupe_${GRANT_LEAD_ID}`,
    title: `Reassign Grant Lead ${RUN}`,
    assigneeUserId: FROM_ID,
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
  await db
    .delete(schema.auditLog)
    .where(
      andFn(
        eqFn(schema.auditLog.entityType, "user"),
        eqFn(schema.auditLog.entityId, FROM_ID),
      ),
    );
  await db.delete(schema.grantLeads).where(eqFn(schema.grantLeads.id, GRANT_LEAD_ID));
  await db.delete(schema.tasks).where(eqFn(schema.tasks.id, TASK_ID));
  await db
    .delete(schema.interactions)
    .where(eqFn(schema.interactions.id, INTERACTION_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db.delete(schema.people).where(eqFn(schema.people.id, PERSON_ID));
  await db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, [ORG_ID, ORG_DONOR_ID]));
  await db
    .delete(schema.users)
    .where(
      inArrayFn(schema.users.id, [
        FROM_ID,
        TO_ID,
        ADMIN_ID,
        ARCHIVED_ID,
        OTHER_ID,
      ]),
    );
}, 60_000);

describe.skipIf(!HAS_DB)("admin owner reassignment", () => {
  it("rejects a non-admin on the count endpoint with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { status } = await getCounts(FROM_ID);
    expect(status).toBe(403);
  }, 30_000);

  it("rejects a non-admin on the reassign endpoint with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { status } = await reassign({
      fromUserId: FROM_ID,
      toUserId: TO_ID,
      archiveSource: false,
    });
    expect(status).toBe(403);
  }, 30_000);

  it("reports one owned record per table (total 7) for the source user", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await getCounts(FROM_ID);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      people: 1,
      organizations: 1,
      opportunities: 1,
      gifts: 1,
      interactions: 1,
      tasks: 1,
      grantLeads: 1,
      total: 7,
    });
  }, 30_000);

  it("rejects reassigning a user to themselves with 400 same_user", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await reassign({
      fromUserId: FROM_ID,
      toUserId: FROM_ID,
      archiveSource: false,
    });
    expect(status).toBe(400);
    expect(json.error).toBe("same_user");
  }, 30_000);

  it("returns 404 when the source user does not exist", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status } = await reassign({
      fromUserId: `${RUN}_ghost`,
      toUserId: TO_ID,
      archiveSource: false,
    });
    expect(status).toBe(404);
  }, 30_000);

  it("rejects reassigning into an archived destination with 400", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await reassign({
      fromUserId: FROM_ID,
      toUserId: ARCHIVED_ID,
      archiveSource: false,
    });
    expect(status).toBe(400);
    expect(json.error).toBe("destination_archived");
  }, 30_000);

  it("moves every owned record to the destination, preserves task provenance, archives the source, and audits", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await reassign({
      fromUserId: FROM_ID,
      toUserId: TO_ID,
      archiveSource: true,
    });
    expect(status).toBe(200);
    expect(json.archivedSource).toBe(true);
    expect(json.reassigned).toMatchObject({
      people: 1,
      organizations: 1,
      opportunities: 1,
      gifts: 1,
      interactions: 1,
      tasks: 1,
      grantLeads: 1,
      total: 7,
    });

    // Source now owns nothing; destination owns everything.
    const after = await getCounts(FROM_ID);
    expect(after.json.total).toBe(0);
    const dest = await getCounts(TO_ID);
    expect(dest.json.total).toBe(7);

    // Provenance: assignee moved, created_by stayed.
    const [task] = await db
      .select({
        assignee: schema.tasks.assigneeUserId,
        createdBy: schema.tasks.createdByUserId,
      })
      .from(schema.tasks)
      .where(eqFn(schema.tasks.id, TASK_ID));
    expect(task?.assignee).toBe(TO_ID);
    expect(task?.createdBy).toBe(FROM_ID);

    // Source user archived.
    const [fromUser] = await db
      .select({ archivedAt: schema.users.archivedAt })
      .from(schema.users)
      .where(eqFn(schema.users.id, FROM_ID));
    expect(fromUser?.archivedAt).not.toBeNull();

    // Exactly one bulk_update audit row for this offboarding.
    const audits = await db
      .select({
        action: schema.auditLog.action,
        entityType: schema.auditLog.entityType,
        entityId: schema.auditLog.entityId,
      })
      .from(schema.auditLog)
      .where(
        andFn(
          eqFn(schema.auditLog.entityType, "user"),
          eqFn(schema.auditLog.entityId, FROM_ID),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("bulk_update");
  }, 30_000);
});
