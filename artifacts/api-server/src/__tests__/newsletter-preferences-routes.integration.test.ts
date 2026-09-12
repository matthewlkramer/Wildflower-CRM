import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@workspace/db";
import {
  auditLog,
  newsletterPreferenceEvents,
  people,
  users,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const fixture = vi.hoisted(() => ({
  id: `newsletter_routes_${Date.now()}`,
  role: "team_member",
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: fixture.id, role: fixture.role };
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../lib/flodeskSync", () => ({
  syncPersonToFlodeskInBackground: vi.fn(),
  reconcileFlodeskUnsubscribes: vi.fn(),
}));
let server: Server;
let url: string;
async function post(
  body: object,
  path = `/people/${fixture.id}/newsletter-preferences`,
) {
  return fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeAll(async () => {
  await db
    .insert(users)
    .values({
      id: fixture.id,
      clerkId: fixture.id,
      email: `${fixture.id}@example.org`,
      role: "team_member",
    });
  await db
    .insert(people)
    .values({ id: fixture.id, fullName: "Newsletter route fixture" });
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, () => resolve(running));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(auditLog).where(eq(auditLog.entityId, fixture.id));
  await db
    .delete(newsletterPreferenceEvents)
    .where(eq(newsletterPreferenceEvents.personId, fixture.id));
  await db.delete(people).where(eq(people.id, fixture.id));
  await db.delete(users).where(eq(users.id, fixture.id));
});
describe("newsletter preference API", () => {
  const evidence = {
    eventType: "consent_given",
    occurredAt: null,
    source: "Preserved Fillout form",
    evidence: "Explicit Yes answer; date unknown",
    requestId: "bd092b49-15d2-474f-9911-11c0e0045ac5",
  };
  it("records undated evidence and retries without duplicating its event or audit", async () => {
    const first = await post(evidence);
    expect(first.status).toBe(201);
    const row = await first.json();
    expect((await (await post(evidence)).json()).id).toBe(row.id);
    expect(
      (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.entityId, fixture.id))
      ).length,
    ).toBe(1);
    const history = await (
      await fetch(url + `/people/${fixture.id}/newsletter-preferences`)
    ).json();
    expect(history.data.length).toBe(1);
    expect(history.data[0].occurredAt).toBeNull();
    expect(history.newsletter).toBe(true);
  });
  it("rejects changed evidence under the same request identity", async () => {
    expect(
      (await post({ ...evidence, evidence: "Changed payload" })).status,
    ).toBe(409);
  });
  it("rejects unsafe links and future dates", async () => {
    expect(
      (await post({ ...evidence, sourceUrl: "javascript:alert(1)" })).status,
    ).toBe(400);
    expect(
      (await post({ ...evidence, occurredAt: "2099-01-01T12:00:00Z" })).status,
    ).toBe(400);
  });
  it("blocks read-only evidence writes and the legacy selection path", async () => {
    fixture.role = "read_only";
    expect((await post(evidence)).status).toBe(403);
    const legacy = await fetch(url + `/people/${fixture.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newsletter: true }),
    });
    expect(legacy.status).toBe(403);
    fixture.role = "team_member";
  });
  it("rejects an independent unsubscribe flag write", async () => {
    const legacy = await fetch(url + `/people/${fixture.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unsubscribedToNewsletter: false }),
    });
    expect(legacy.status).toBe(400);
  });
});
