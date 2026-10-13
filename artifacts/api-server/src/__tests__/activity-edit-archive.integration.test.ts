import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
const RUN = `activity_feedback_${Date.now()}`;
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: `${RUN}_user`, role: "admin" };
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
let schema: typeof import("@workspace/db");
let server: Server;
let url: string;
beforeAll(async () => {
  schema = await import("@workspace/db");
  await schema.db
    .insert(schema.users)
    .values({
      id: `${RUN}_user`,
      clerkId: `${RUN}_clerk`,
      email: `${RUN}@example.test`,
      role: "admin",
    });
  await schema.db
    .insert(schema.people)
    .values({ id: `${RUN}_person`, fullName: RUN });
  const { default: app } = await import("../app");
  server = app.listen(0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60000);
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!schema) return;
  await schema.db
    .delete(schema.notes)
    .where(eq(schema.notes.authorUserId, `${RUN}_user`));
  await schema.db
    .delete(schema.interactions)
    .where(eq(schema.interactions.ownerUserId, `${RUN}_user`));
  await schema.db
    .delete(schema.people)
    .where(eq(schema.people.id, `${RUN}_person`));
  await schema.db
    .delete(schema.users)
    .where(eq(schema.users.id, `${RUN}_user`));
});
async function request(path: string, method = "GET", body?: unknown) {
  const r = await fetch(url + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
describe("activity corrections preserve history", () => {
  it("edits and logically deletes a note without losing its author or linked records", async () => {
    const created = await request("/api/notes", "POST", {
      body: "Original note",
      personIds: [`${RUN}_person`],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const updated = await request(`/api/notes/${id}`, "PATCH", {
      body: "Corrected note",
    });
    expect(updated.body.authorUserId).toBe(`${RUN}_user`);
    expect(updated.body.personIds).toEqual([`${RUN}_person`]);
    expect((await request(`/api/notes/${id}`, "DELETE")).status).toBe(204);
    expect(
      (await request(`/api/notes?personId=${RUN}_person`)).body.data,
    ).toEqual([]);
    const row = await schema.db
      .select()
      .from(schema.notes)
      .where(eq(schema.notes.id, id));
    expect(row[0].body).toBe("Corrected note");
    expect(row[0].archivedAt).toBeInstanceOf(Date);
  });
  it("edits and logically deletes an interaction, removing it from last contact", async () => {
    const created = await request("/api/interactions", "POST", {
      kind: "phone_call",
      occurredAt: "2026-10-01T12:00:00Z",
      summary: "Original call",
      notes: "Notes",
      ownerUserId: `${RUN}_user`,
      personIds: [`${RUN}_person`],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(
      (
        await request(`/api/interactions/${id}`, "PATCH", {
          summary: "Corrected call",
          notes: null,
        })
      ).body.summary,
    ).toBe("Corrected call");
    const activePerson = await request(`/api/people?search=${RUN}`);
    expect(activePerson.body.data[0].lastContacted).toBe("2026-10-01");
    expect((await request(`/api/interactions/${id}`, "DELETE")).status).toBe(
      204,
    );
    expect(
      (await request(`/api/interactions?personId=${RUN}_person`)).body.data,
    ).toEqual([]);
    expect(
      (await request(`/api/people?search=${RUN}`)).body.data[0].lastContacted,
    ).toBeNull();
    const row = await schema.db
      .select()
      .from(schema.interactions)
      .where(eq(schema.interactions.id, id));
    expect(row[0].archivedAt).toBeInstanceOf(Date);
  });
});
