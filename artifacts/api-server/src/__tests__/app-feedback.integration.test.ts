import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `appfeedback_${Date.now()}`;
const REPORTER_ID = `${RUN}_reporter`;
const ADMIN_ID = `${RUN}_admin`;

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "", role: "team_member" as string },
}));
currentUser.id = REPORTER_ID;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { ...currentUser };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";
let feedbackId: string | null = null;

async function jsonRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
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
  eqFn = (await import("drizzle-orm")).eq;
  await db.insert(schema.users).values([
    {
      id: REPORTER_ID,
      clerkId: `clerk_${REPORTER_ID}`,
      email: `${REPORTER_ID}@wildflowerschools.org`,
      displayName: "Feedback Reporter",
      role: "team_member",
    },
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      displayName: "Feedback Admin",
      role: "admin",
    },
  ]);
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (feedbackId) {
    await db
      .delete(schema.appFeedback)
      .where(eqFn(schema.appFeedback.id, feedbackId));
  }
  await db.delete(schema.users).where(eqFn(schema.users.id, REPORTER_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

describe.skipIf(!HAS_DB)("app feedback API", () => {
  it("accepts team feedback and exposes an admin-only resolution queue", async () => {
    const created = await jsonRequest("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        category: "bug",
        message: "The completed lens still shows this row.",
        pageUrl: "https://crm.example/reconciliation/deposits?lens=all_open",
        pagePath: "/reconciliation/deposits?lens=all_open",
        pageTitle: "Reconciliation",
        context: {
          viewport: { width: 1440, height: 900 },
          visibleTestIds: ["deposit-row-bdep_123"],
        },
        screenshotUrl: "/api/storage/objects/feedback-test.jpg",
        screenshotFilename: "feedback-test.jpg",
        screenshotStatus: "captured",
      }),
    });
    expect(created.status).toBe(201);
    feedbackId = created.json.id;
    expect(created.json).toMatchObject({
      status: "open",
      reporter: { id: REPORTER_ID, name: "Feedback Reporter" },
      screenshotStatus: "captured",
    });

    const forbidden = await jsonRequest("/api/admin/feedback?status=open");
    expect(forbidden.status).toBe(403);

    currentUser.id = ADMIN_ID;
    currentUser.role = "admin";
    const listed = await jsonRequest(
      "/api/admin/feedback?status=open&search=completed%20lens",
    );
    expect(listed.status).toBe(200);
    expect(listed.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: feedbackId,
          pagePath: "/reconciliation/deposits?lens=all_open",
        }),
      ]),
    );

    const updated = await jsonRequest(`/api/admin/feedback/${feedbackId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "resolved",
        adminNotes: "Fixed in the deposit completion patch.",
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      status: "resolved",
      adminNotes: "Fixed in the deposit completion patch.",
      resolvedByUserId: ADMIN_ID,
    });
    expect(updated.json.resolvedAt).toBeTruthy();
  });
});
