import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed HTTP coverage for GET /api/reconciliation/workbench-recent-changes
 * — the recent-changes rail on the reconciliation workbench. Guards against
 * the route silently disappearing (a stale build / unmounted router shows up
 * to the client as an intermittent 404 on the clusters page):
 *   - the route is REGISTERED and returns 200 (never 404) for an
 *     authenticated caller,
 *   - only audit rows tagged metadata.domain = "reconciliation" appear,
 *   - a valid undo pointer round-trips; a malformed/unknown-kind undo
 *     degrades to null instead of breaking the rail.
 *
 * Same seam as the sibling workbench suites: only `requireAuth` is mocked;
 * everything else is the real app. Skips without a real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `wb_recent_user_${Date.now()}`,
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

const RUN = `wbrecent_${Date.now()}`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: { users: Db["users"]; auditLog: Db["auditLog"] };
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const auditIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedAudit(opts: {
  summary: string;
  metadata: Record<string, unknown> | null;
  createdAt?: Date;
}): Promise<string> {
  const id = nextId("audit");
  await db.insert(schema.auditLog).values({
    id,
    actorUserId: TEST_USER_ID,
    action: "update",
    entityType: "staged_payment",
    entityId: nextId("sp"),
    summary: opts.summary,
    metadata: opts.metadata,
    // Far-future so the rows land inside the rail's LIMIT 20 window even on a
    // busy dev DB.
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
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    displayName: `Recent Rail Tester ${RUN}`,
    role: "team_member",
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
  if (auditIds.length)
    await db
      .delete(schema.auditLog)
      .where(inArrayFn(schema.auditLog.id, auditIds));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)(
  "GET /api/reconciliation/workbench-recent-changes",
  () => {
    it("is registered (200, never 404) and returns only reconciliation-domain rows", async () => {
      const withUndoId = await seedAudit({
        summary: `${RUN} excluded a staged payment`,
        metadata: {
          domain: "reconciliation",
          undo: { kind: "reinclude_staged_payment", targetId: "sp_target_1" },
        },
      });
      const malformedUndoId = await seedAudit({
        summary: `${RUN} action with bogus undo`,
        metadata: {
          domain: "reconciliation",
          undo: { kind: "not_a_real_kind", targetId: "x" },
        },
      });
      const otherDomainId = await seedAudit({
        summary: `${RUN} unrelated audit row`,
        metadata: { domain: "something_else" },
      });

      const res = await fetch(
        `${baseUrl}/api/reconciliation/workbench-recent-changes`,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        items: Array<{
          id: string;
          at: string;
          actorName: string | null;
          summary: string;
          undo: { kind: string; targetId: string } | null;
        }>;
      };
      expect(Array.isArray(json.items)).toBe(true);

      const byId = new Map(json.items.map((i) => [i.id, i]));

      const withUndo = byId.get(withUndoId);
      expect(withUndo).toBeDefined();
      expect(withUndo!.undo).toEqual({
        kind: "reinclude_staged_payment",
        targetId: "sp_target_1",
      });
      expect(withUndo!.actorName).toBe(`Recent Rail Tester ${RUN}`);
      expect(withUndo!.summary).toContain(RUN);

      const malformed = byId.get(malformedUndoId);
      expect(malformed).toBeDefined();
      expect(malformed!.undo).toBeNull();

      expect(byId.has(otherDomainId)).toBe(false);
    });
  },
);
