import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Integration coverage for the admin-only QuickBooks handling-rules HTTP
 * endpoints: list / create / update (PATCH) / reorder / delete.
 *
 * The only seam we mock is requireAuth — we inject the seeded user object
 * directly so the in-route requireAdmin check (which reads req.appUser.role)
 * works with the real DB-backed user. The `state` wrapper lets individual
 * tests switch between the admin and the non-admin user.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qb_rules_${Date.now()}`;

// Mutable state the mock reads. Populated in beforeAll once users are seeded.
const state = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: null as any,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = state.user;
    next();
  },
}));

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  quickbooksHandlingRules: Db["quickbooksHandlingRules"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const ADMIN_ID = `${RUN}_admin`;
const NON_ADMIN_ID = `${RUN}_member`;
const ORG_ID = `${RUN}_org`;

// Track rules created during tests so afterAll can clean them up.
const createdRuleIds: string[] = [];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
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
  return { status: res.status, json };
}

async function patch(
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function del(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── Minimal valid rule bodies ────────────────────────────────────────────────

const VALID_EXCLUDE_BODY = {
  name: `${RUN} loan filter`,
  action: "exclude",
  exclusionReason: "loan",
  conditions: [{ field: "payer_name", mode: "contains", value: "Loan" }],
};

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!HAS_DB) return;

  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    quickbooksHandlingRules: dbMod.quickbooksHandlingRules,
  };
  eqFn = drizzle.eq;

  // Seed two users: one admin, one team_member.
  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: NON_ADMIN_ID,
      clerkId: `clerk_${NON_ADMIN_ID}`,
      email: `${NON_ADMIN_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);

  // Seed an org that auto_create_approve rules can reference.
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `QB Rules Test Org ${RUN}`,
  });

  // Default injection: admin user.
  state.user = { id: ADMIN_ID, role: "admin" };

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));

  // Delete test rules first (FK-safe: nothing references them).
  for (const id of createdRuleIds) {
    await db
      .delete(schema.quickbooksHandlingRules)
      .where(eqFn(schema.quickbooksHandlingRules.id, id));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, NON_ADMIN_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[quickbooks-rules-admin] skipped: no live DATABASE_URL configured",
    );
  }
  // Reset to admin before each test; individual tests that need a non-admin
  // switch state.user at the top of the test body.
  state.user = { id: ADMIN_ID, role: "admin" };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)(
  "QuickBooks rules admin API (integration)",
  () => {
    // ── Auth gating ──────────────────────────────────────────────────────────

    it("returns 403 for a non-admin user on every method", async () => {
      state.user = { id: NON_ADMIN_ID, role: "team_member" };

      const list = await get("/api/admin/quickbooks-rules");
      expect(list.status).toBe(403);
      expect((list.json as { error: string }).error).toBe("admin_required");

      const create = await post("/api/admin/quickbooks-rules", VALID_EXCLUDE_BODY);
      expect(create.status).toBe(403);

      const reorder = await post("/api/admin/quickbooks-rules/reorder", {
        ids: [],
      });
      expect(reorder.status).toBe(403);

      const update = await patch(
        "/api/admin/quickbooks-rules/nonexistent-id",
        { enabled: false },
      );
      expect(update.status).toBe(403);

      const remove = await del("/api/admin/quickbooks-rules/nonexistent-id");
      expect(remove.status).toBe(403);
    }, 30_000);

    it("allows an admin to list rules", async () => {
      const { status, json } = await get("/api/admin/quickbooks-rules");
      expect(status).toBe(200);
      expect(Array.isArray(json)).toBe(true);
    }, 30_000);

    // ── validateRuleSemantics rejections ─────────────────────────────────────

    it("rejects create with no conditions", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        ...VALID_EXCLUDE_BODY,
        conditions: [],
      });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toBe("validation_error");
    }, 30_000);

    it("rejects a condition with an empty value", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        ...VALID_EXCLUDE_BODY,
        conditions: [{ field: "payer_name", mode: "contains", value: "" }],
      });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toBe("validation_error");
    }, 30_000);

    it("rejects an 'amount' field that does not use mode 'lte'", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        ...VALID_EXCLUDE_BODY,
        conditions: [{ field: "amount", mode: "contains", value: "100" }],
      });
      expect(res.status).toBe(400);
      const body = res.json as { error: string; message: string };
      expect(body.error).toBe("validation_error");
      expect(body.message).toMatch(/amount.*lte/i);
    }, 30_000);

    it("rejects 'lte' mode on a non-amount field", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        ...VALID_EXCLUDE_BODY,
        conditions: [{ field: "payer_name", mode: "lte", value: "100" }],
      });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toBe("validation_error");
    }, 30_000);

    it("rejects an 'lte' condition whose value is not numeric", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        ...VALID_EXCLUDE_BODY,
        conditions: [{ field: "amount", mode: "lte", value: "not-a-number" }],
      });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toBe("validation_error");
    }, 30_000);

    it("rejects a regex condition with an invalid pattern", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        ...VALID_EXCLUDE_BODY,
        conditions: [{ field: "payer_name", mode: "regex", value: "(" }],
      });
      expect(res.status).toBe(400);
      const body = res.json as { error: string; message: string };
      expect(body.error).toBe("validation_error");
      expect(body.message).toMatch(/invalid regular expression/i);
    }, 30_000);

    it("rejects an exclude rule with no exclusionReason", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        name: `${RUN} no-reason`,
        action: "exclude",
        conditions: [{ field: "payer_name", mode: "contains", value: "X" }],
      });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toBe("validation_error");
    }, 30_000);

    it("rejects auto_create_approve with a non-existent org", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        name: `${RUN} bad-org`,
        action: "auto_create_approve",
        conditions: [{ field: "payer_name", mode: "contains", value: "X" }],
        targetOrganizationId: "nonexistent_org_id_xyz",
        targetIntendedUsage: "gen_ops",
      });
      expect(res.status).toBe(400);
      const body = res.json as { error: string; message: string };
      expect(body.error).toBe("validation_error");
      expect(body.message).toMatch(/targetOrganizationId/i);
    }, 30_000);

    it("rejects auto_create_approve with a non-existent fundable project", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        name: `${RUN} bad-proj`,
        action: "auto_create_approve",
        conditions: [{ field: "payer_name", mode: "contains", value: "X" }],
        targetOrganizationId: ORG_ID,
        targetIntendedUsage: "project",
        targetFundableProjectId: "nonexistent_project_id_xyz",
      });
      expect(res.status).toBe(400);
      const body = res.json as { error: string; message: string };
      expect(body.error).toBe("validation_error");
      expect(body.message).toMatch(/targetFundableProjectId/i);
    }, 30_000);

    // ── Full round-trip ───────────────────────────────────────────────────────

    it("round-trips create → list → update → reorder → delete", async () => {
      // ── CREATE (two rules so the incomplete-reorder rejection is reliable) ──
      const created = await post("/api/admin/quickbooks-rules", {
        name: `${RUN} roundtrip rule`,
        action: "exclude",
        exclusionReason: "interest",
        conditions: [{ field: "payer_name", mode: "contains", value: "Test" }],
        enabled: true,
      });
      expect(created.status).toBe(201);
      const rule = created.json as {
        id: string;
        name: string;
        enabled: boolean;
        action: string;
        exclusionReason: string;
        priority: number;
      };
      expect(rule.id).toBeTruthy();
      expect(rule.name).toBe(`${RUN} roundtrip rule`);
      expect(rule.action).toBe("exclude");
      expect(rule.exclusionReason).toBe("interest");
      expect(rule.enabled).toBe(true);
      createdRuleIds.push(rule.id);

      // Second rule — guarantees the DB has ≥2 rules so the incomplete-reorder
      // sub-assertion below is always triggered.
      const created2 = await post("/api/admin/quickbooks-rules", {
        name: `${RUN} roundtrip rule 2`,
        action: "exclude",
        exclusionReason: "loan",
        conditions: [
          { field: "payer_name", mode: "contains", value: "Test2" },
        ],
        enabled: true,
      });
      expect(created2.status).toBe(201);
      const rule2 = created2.json as { id: string };
      createdRuleIds.push(rule2.id);

      // ── LIST ─────────────────────────────────────────────────────────────────
      const listed = await get("/api/admin/quickbooks-rules");
      expect(listed.status).toBe(200);
      const allRules = listed.json as Array<{ id: string; priority: number }>;
      const found = allRules.find((r) => r.id === rule.id);
      expect(found).toBeTruthy();

      // Rules should be sorted by ascending priority.
      const priorities = allRules.map((r) => r.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));

      // ── UPDATE (PATCH) ──────────────────────────────────────────────────────
      const updated = await patch(`/api/admin/quickbooks-rules/${rule.id}`, {
        name: `${RUN} roundtrip rule (updated)`,
        enabled: false,
      });
      expect(updated.status).toBe(200);
      const updatedRule = updated.json as {
        id: string;
        name: string;
        enabled: boolean;
      };
      expect(updatedRule.id).toBe(rule.id);
      expect(updatedRule.name).toBe(`${RUN} roundtrip rule (updated)`);
      expect(updatedRule.enabled).toBe(false);

      // ── PATCH: merged-state validation on action switch ──────────────────
      // Switching to auto_create_approve without providing targetOrganizationId
      // should fail on the merged state even though current rule has no target.
      const switchFail = await patch(`/api/admin/quickbooks-rules/${rule.id}`, {
        action: "auto_create_approve",
        // Omit targetOrganizationId → merged state has no org → 400
      });
      expect(switchFail.status).toBe(400);
      expect(
        (switchFail.json as { error: string }).error,
      ).toBe("validation_error");

      // ── REORDER ──────────────────────────────────────────────────────────────
      // Collect all existing rule IDs, then move our rule to the front.
      const beforeReorder = await get("/api/admin/quickbooks-rules");
      const allIds = (
        beforeReorder.json as Array<{ id: string }>
      ).map((r) => r.id);

      // Move our rule to position 0.
      const withoutOurs = allIds.filter((id) => id !== rule.id);
      const reordered = [rule.id, ...withoutOurs];

      const reorderRes = await post(
        "/api/admin/quickbooks-rules/reorder",
        { ids: reordered },
      );
      expect(reorderRes.status).toBe(200);
      const reorderedList = reorderRes.json as Array<{ id: string }>;
      expect(reorderedList[0].id).toBe(rule.id);

      // ── REORDER: incomplete id list rejected ──────────────────────────────
      const badReorder = await post("/api/admin/quickbooks-rules/reorder", {
        ids: [rule.id], // missing all other rules
      });
      expect(badReorder.status).toBe(400);

      // ── DELETE ───────────────────────────────────────────────────────────────
      const deleted = await del(`/api/admin/quickbooks-rules/${rule.id}`);
      expect(deleted.status).toBe(200);
      expect((deleted.json as { ok: boolean }).ok).toBe(true);

      // Rule should no longer appear in the list.
      const afterDelete = await get("/api/admin/quickbooks-rules");
      const remaining = afterDelete.json as Array<{ id: string }>;
      expect(remaining.find((r) => r.id === rule.id)).toBeUndefined();

      // Remove from cleanup list since we already deleted it.
      const idx = createdRuleIds.indexOf(rule.id);
      if (idx !== -1) createdRuleIds.splice(idx, 1);
    }, 60_000);

    it("returns 404 when updating or deleting a non-existent rule", async () => {
      const updateRes = await patch(
        "/api/admin/quickbooks-rules/nonexistent_rule_id",
        { enabled: false },
      );
      expect(updateRes.status).toBe(404);

      const deleteRes = await del(
        "/api/admin/quickbooks-rules/nonexistent_rule_id",
      );
      expect(deleteRes.status).toBe(404);
    }, 30_000);

    it("creates a valid auto_create_approve rule pointing to a real org", async () => {
      const res = await post("/api/admin/quickbooks-rules", {
        name: `${RUN} auto-create rule`,
        action: "auto_create_approve",
        conditions: [
          { field: "payer_name", mode: "contains", value: "AmazonSmile" },
        ],
        targetOrganizationId: ORG_ID,
        targetIntendedUsage: "gen_ops",
        enabled: true,
      });
      expect(res.status).toBe(201);
      const rule = res.json as {
        id: string;
        action: string;
        targetOrganizationId: string;
        targetIntendedUsage: string;
      };
      expect(rule.action).toBe("auto_create_approve");
      expect(rule.targetOrganizationId).toBe(ORG_ID);
      expect(rule.targetIntendedUsage).toBe("gen_ops");
      createdRuleIds.push(rule.id);
    }, 30_000);
  },
);
