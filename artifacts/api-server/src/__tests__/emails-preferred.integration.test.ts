import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `preferred_email_${Date.now()}`;
const PERSON_ID = `${RUN}_person`;
const USER_ID = `${RUN}_user`;
const MESSAGE_ID = `${RUN}_message`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

describe.skipIf(!HAS_DB)("preferred contact email", () => {
  let server: Server;
  let baseUrl: string;
  let db: typeof import("@workspace/db")["db"];
  let emails: typeof import("@workspace/db")["emails"];
  let people: typeof import("@workspace/db")["people"];
  let users: typeof import("@workspace/db")["users"];
  let emailMessages: typeof import("@workspace/db")["emailMessages"];
  let eq: typeof import("drizzle-orm")["eq"];

  beforeAll(async () => {
    ({ db, emails, people, users, emailMessages } = await import("@workspace/db"));
    ({ eq } = await import("drizzle-orm"));
    await db.insert(users).values({
      id: USER_ID,
      clerkId: `clerk_${USER_ID}`,
      email: `${USER_ID}@wildflowerschools.org`,
      role: "admin",
    });
    await db.insert(people).values({ id: PERSON_ID, fullName: RUN });
    const { default: app } = await import("../app");
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db) await db.delete(emailMessages).where(eq(emailMessages.id, MESSAGE_ID));
    if (db) await db.delete(people).where(eq(people.id, PERSON_ID));
    if (db) await db.delete(users).where(eq(users.id, USER_ID));
  });

  it("moves preferred status to the newly chosen address", async () => {
    const create = async (suffix: string) => {
      const response = await fetch(`${baseUrl}/api/emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: PERSON_ID,
          email: `${RUN}.${suffix}@example.org`,
          isPreferred: true,
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const first = await create("first");
    const second = await create("second");
    let rows = await db.select().from(emails).where(eq(emails.personId, PERSON_ID));
    expect(rows.filter((row) => row.isPreferred).map((row) => row.id)).toEqual([second.id]);

    const response = await fetch(`${baseUrl}/api/emails/${first.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPreferred: true }),
    });
    expect(response.status).toBe(200);
    rows = await db.select().from(emails).where(eq(emails.personId, PERSON_ID));
    expect(rows.filter((row) => row.isPreferred).map((row) => row.id)).toEqual([first.id]);
  });

  it("derives unknown validity from an inbound exchange but preserves invalidation", async () => {
    const address = `${RUN}.exchange@example.org`;
    const [email] = await db.insert(emails).values({
      id: `${RUN}_exchange`,
      personId: PERSON_ID,
      email: address,
      validity: "unknown",
    }).returning();
    await db.insert(emailMessages).values({
      id: MESSAGE_ID,
      gmailMessageId: MESSAGE_ID,
      mailboxUserId: USER_ID,
      direction: "received",
      sentAt: new Date(),
      fromEmail: address,
      matchedPersonIds: [PERSON_ID],
      isPrivate: true,
    });
    const readValidity = async () => {
      const response = await fetch(`${baseUrl}/api/emails?email=${encodeURIComponent(address)}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ validity: string }> };
      return body.data[0]?.validity;
    };
    expect(await readValidity()).toBe("valid");
    await db.update(emails).set({ validity: "invalid" }).where(eq(emails.id, email.id));
    expect(await readValidity()).toBe("invalid");
  });

  it("counts a private email in the shared last-contact date", async () => {
    const response = await fetch(`${baseUrl}/api/people/${PERSON_ID}`);
    expect(response.status).toBe(200);
    const person = await response.json() as { lastContacted: string | null };
    expect(person.lastContacted?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });
});
