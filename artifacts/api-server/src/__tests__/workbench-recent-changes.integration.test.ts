import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `wb_recent_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "team_member" };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const RUN = `wbrecent_${Date.now()}`;
const OTHER_USER_ID = `${RUN}_other_user`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: { users: Db["users"]; auditLog: Db["auditLog"] };
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const auditIds: string[] = [];
let seq = 0;
const nextId = (prefix: string) =>
  `${RUN}_${prefix}_${String(++seq).padStart(3, "0")}`;

async function seedAudit(opts: {
  actorUserId?: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  createdAt?: Date;
}): Promise<string> {
  const id = nextId("audit");
  await db.insert(schema.auditLog).values({
    id,
    actorUserId: opts.actorUserId ?? TEST_USER_ID,
    action: "update",
    entityType: "staged_payment",
    entityId: nextId("sp"),
    summary: opts.summary,
    metadata: opts.metadata,
    createdAt: opts.createdAt ?? new Date(Date.now() + 1_000_000_000_000),
  });
  auditIds.push(id);
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = { users: dbMod.users, auditLog: dbMod.auditLog };
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: TEST_USER_ID,
      clerkId: `clerk_${TEST_USER_ID}`,
      email: `${TEST_USER_ID}@wildflowerschools.org`,
      displayName: `Recent Rail Tester ${RUN}`,
      role: "team_member",
    },
    {
      id: OTHER_USER_ID,
      clerkId: `clerk_${OTHER_USER_ID}`,
      email: `${OTHER_USER_ID}@wildflowerschools.org`,
      displayName: `Other Reviewer ${RUN}`,
      role: "team_member",
    },
  ]);

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (auditIds.length)
    await db
      .delete(schema.auditLog)
      .where(inArrayFn(schema.auditLog.id, auditIds));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [TEST_USER_ID, OTHER_USER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)(
  "GET /api/reconciliation/workbench-recent-changes",
  () => {
    it("returns only the signed-in user's reversible reconciliation actions", async () => {
      const reversibleId = await seedAudit({
        summary: `${RUN} linked a Stripe charge`,
        metadata: {
          domain: "reconciliation",
          undo: { kind: "revert_stripe_charge", targetId: "ch_target_1" },
        },
      });
      const nonReversibleId = await seedAudit({
        summary: `${RUN} set a donor as an intermediate step`,
        metadata: { domain: "reconciliation", undo: null },
      });
      const malformedUndoId = await seedAudit({
        summary: `${RUN} action with bogus undo`,
        metadata: {
          domain: "reconciliation",
          undo: { kind: "not_a_real_kind", targetId: "x" },
        },
      });
      const otherUserId = await seedAudit({
        actorUserId: OTHER_USER_ID,
        summary: `${RUN} another reviewer action`,
        metadata: {
          domain: "reconciliation",
          undo: { kind: "revert_staged_payment", targetId: "sp_other" },
        },
      });
      const otherDomainId = await seedAudit({
        summary: `${RUN} unrelated audit row`,
        metadata: {
          domain: "something_else",
          undo: { kind: "revert_staged_payment", targetId: "sp_unrelated" },
        },
      });

      const response = await fetch(
        `${baseUrl}/api/reconciliation/workbench-recent-changes`,
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const json = JSON.parse(body) as {
        items: Array<{
          id: string;
          actorName: string | null;
          summary: string;
          undo: { kind: string; targetId: string };
        }>;
      };
      const byId = new Map(json.items.map((item) => [item.id, item]));

      expect(byId.get(reversibleId)).toMatchObject({
        actorName: `Recent Rail Tester ${RUN}`,
        undo: { kind: "revert_stripe_charge", targetId: "ch_target_1" },
      });
      expect(byId.has(nonReversibleId)).toBe(false);
      expect(byId.has(malformedUndoId)).toBe(false);
      expect(byId.has(otherUserId)).toBe(false);
      expect(byId.has(otherDomainId)).toBe(false);
      expect(json.items.every((item) => item.undo != null)).toBe(true);
    });
  },
);
