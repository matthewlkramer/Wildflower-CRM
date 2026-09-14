import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@workspace/db";
import { users, auditLog } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

const HAS_DB = Boolean(
  process.env.DATABASE_URL &&
  !/test:test@localhost:5432\/test/.test(process.env.DATABASE_URL),
);
const run = `usermgmtspec_${Date.now()}`;
const adminId = `${run}_admin`;
const otherId = `${run}_other`;
const ids = [adminId, otherId];
const auth = vi.hoisted(() => ({ id: "", role: "admin" }));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { ...auth };
    next();
  },
}));
let server: Server;
let url: string;
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await db.insert(users).values([
    {
      id: adminId,
      clerkId: adminId,
      email: `${adminId}@wildflowerschools.org`,
      role: "admin",
      extensionToken: `${run}_secret`,
    },
    {
      id: otherId,
      clerkId: otherId,
      email: `${otherId}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);
  auth.id = adminId;
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(auditLog).where(inArray(auditLog.entityId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}, 60_000);

describe.skipIf(!HAS_DB)("admin user management", () => {
  it("denies every directory and mutation operation to non-admins", async () => {
    auth.id = otherId;
    auth.role = "team_member";
    for (const [path, method] of [
      ["/admin/users", "GET"],
      ["/admin/users", "POST"],
      [`/admin/users/${adminId}`, "PATCH"],
      [`/users/${adminId}/archive`, "POST"],
      [`/users/${adminId}/unarchive`, "POST"],
      ["/users?includeArchived=true", "GET"],
    ]) {
      expect(
        (await request(path, method, method === "GET" ? undefined : {})).status,
      ).toBe(403);
    }
    auth.id = adminId;
    auth.role = "admin";
  });
  it("adds a normalized profile, rejects duplicates without changing access, and never returns tokens", async () => {
    const email = `${run}_new@wildflowerschools.org`;
    const res = await request("/admin/users", "POST", {
      email: email.toUpperCase(),
      role: "team_member",
      firstName: " New ",
      extensionToken: "malicious",
      archivedAt: "2026-01-01",
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    ids.push(created.id);
    expect(created).toMatchObject({
      email,
      role: "team_member",
      firstName: "New",
      archivedAt: null,
    });
    expect(created.clerkId).toMatch(/^pending_/);
    expect(created).not.toHaveProperty("extensionToken");
    const duplicate = await request("/admin/users", "POST", {
      email,
      role: "admin",
    });
    expect(duplicate.status).toBe(409);
    expect(
      (await db.select().from(users).where(eq(users.id, created.id)))[0].role,
    ).toBe("team_member");
    const directory = await (await request("/admin/users")).json();
    expect(
      directory.find((u: { id: string }) => u.id === adminId),
    ).not.toHaveProperty("extensionToken");
    expect(
      (await (await request("/users")).json()).find(
        (u: { id: string }) => u.id === adminId,
      ),
    ).not.toHaveProperty("extensionToken");
  });
  it("rejects invalid domains and roles", async () => {
    expect(
      (
        await request("/admin/users", "POST", {
          email: "outsider@example.org",
          role: "team_member",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/admin/users", "POST", {
          email: "valid@wildflowerschools.org",
          role: "super_admin",
        })
      ).status,
    ).toBe(400);
  });
  it("updates only allowed fields, records audit, and preserves the login identity", async () => {
    const res = await request(`/admin/users/${otherId}`, "PATCH", {
      role: "finance",
      displayName: "Colleague",
      email: "replacement@wildflowerschools.org",
      clerkId: "replacement",
      extensionToken: "bad",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      role: "finance",
      email: `${otherId}@wildflowerschools.org`,
      clerkId: otherId,
      displayName: "Colleague",
    });
    const logs = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, otherId));
    expect(
      logs.some(
        (log) => log.action === "update" && log.actorUserId === adminId,
      ),
    ).toBe(true);
  });
  it("deactivates and restores the same user without losing history", async () => {
    expect((await request(`/users/${otherId}/archive`, "POST")).status).toBe(
      200,
    );
    const directory = await (await request("/admin/users")).json();
    expect(
      directory.find((u: { id: string }) => u.id === otherId).archivedAt,
    ).toBeTruthy();
    expect(
      (await (await request("/users")).json()).some(
        (u: { id: string }) => u.id === otherId,
      ),
    ).toBe(false);
    const restored = await request(`/users/${otherId}/unarchive`, "POST");
    expect(await restored.json()).toMatchObject({
      id: otherId,
      role: "finance",
      displayName: "Colleague",
      archivedAt: null,
    });
  });
  it("prevents self lockout and refuses a stale admin session after demotion", async () => {
    expect(
      (
        await request(`/admin/users/${adminId}`, "PATCH", {
          role: "team_member",
        })
      ).status,
    ).toBe(400);
    expect((await request(`/users/${adminId}/archive`, "POST")).status).toBe(
      400,
    );
    auth.id = otherId;
    auth.role = "admin";
    expect((await request(`/users/${adminId}/archive`, "POST")).status).toBe(
      403,
    );
    auth.id = adminId;
  });
  it("returns not found for unknown user edits", async () => {
    expect(
      (
        await request(`/admin/users/${run}_missing`, "PATCH", {
          role: "finance",
        })
      ).status,
    ).toBe(404);
  });
});
