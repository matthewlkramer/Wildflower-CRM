/**
 * Backend behavior behind the "Add sender as person" action:
 * 1. GET /emails?email= does a case-insensitive exact-address lookup
 *    (the frontend preflight that prevents duplicate people).
 * 2. POST /emails with a personId re-attributes HISTORY: existing
 *    email_messages involving that address (from/to/cc/bcc, any case) get
 *    the person appended to matched_person_ids, exactly once.
 *
 * Mocks only the Clerk auth gate; uses the real DB. Skips with no DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `emaillink_test_user_${Date.now()}`,
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

const RUN = `emaillink_${Date.now()}`;
const PERSON_ID = `${RUN}_person`;
const ADDR = `Jane.Doe.${RUN}@kern.org`; // mixed case on purpose
const MSG_FROM = `${RUN}_msg_from`;
const MSG_TO = `${RUN}_msg_to`;
const MSG_UNRELATED = `${RUN}_msg_other`;
const MSG_ALREADY = `${RUN}_msg_already`;

describe.skipIf(!HAS_DB)("emails: sender-linking backend", () => {
  type Db = typeof import("@workspace/db");
  let db: Db["db"];
  let users: Db["users"];
  let people: Db["people"];
  let emails: Db["emails"];
  let emailMessages: Db["emailMessages"];
  let eqFn: (typeof import("drizzle-orm"))["eq"];
  let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    users = dbMod.users;
    people = dbMod.people;
    emails = dbMod.emails;
    emailMessages = dbMod.emailMessages;
    ({ eq: eqFn, inArray: inArrayFn } = await import("drizzle-orm"));

    await db.insert(users).values({
      id: TEST_USER_ID,
      clerkId: `clerk_${TEST_USER_ID}`,
      email: `${TEST_USER_ID}@wildflowerschools.org`,
      role: "admin",
    });
    await db.insert(people).values({
      id: PERSON_ID,
      fullName: `Email Link Person ${RUN}`,
    });
    await db.insert(emailMessages).values([
      {
        id: MSG_FROM,
        gmailMessageId: `${RUN}_gm_from`,
        mailboxUserId: TEST_USER_ID,
        direction: "received",
        sentAt: new Date("2026-01-05T12:00:00Z"),
        fromEmail: ADDR.toLowerCase(),
        toEmails: ["me@wildflowerschools.org"],
      },
      {
        id: MSG_TO,
        gmailMessageId: `${RUN}_gm_to`,
        mailboxUserId: TEST_USER_ID,
        direction: "sent",
        sentAt: new Date("2026-01-06T12:00:00Z"),
        fromEmail: "me@wildflowerschools.org",
        // Different casing than the linked address — must still match.
        toEmails: [ADDR.toUpperCase()],
      },
      {
        id: MSG_UNRELATED,
        gmailMessageId: `${RUN}_gm_other`,
        mailboxUserId: TEST_USER_ID,
        direction: "received",
        sentAt: new Date("2026-01-07T12:00:00Z"),
        fromEmail: `someone.else.${RUN}@kern.org`,
        toEmails: ["me@wildflowerschools.org"],
      },
      {
        id: MSG_ALREADY,
        gmailMessageId: `${RUN}_gm_already`,
        mailboxUserId: TEST_USER_ID,
        direction: "received",
        sentAt: new Date("2026-01-08T12:00:00Z"),
        fromEmail: ADDR.toLowerCase(),
        toEmails: ["me@wildflowerschools.org"],
        // Already matched — the backfill must not double-append.
        matchedPersonIds: [PERSON_ID],
      },
    ]);

    const { default: app } = await import("../app");
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (!HAS_DB) return;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await db
      .delete(emailMessages)
      .where(
        inArrayFn(emailMessages.id, [
          MSG_FROM,
          MSG_TO,
          MSG_UNRELATED,
          MSG_ALREADY,
        ]),
      );
    await db.delete(emails).where(eqFn(emails.personId, PERSON_ID));
    await db.delete(people).where(eqFn(people.id, PERSON_ID));
    await db.delete(users).where(eqFn(users.id, TEST_USER_ID));
  }, 30_000);

  it("GET /emails?email= finds the address case-insensitively; empty when absent", async () => {
    // Not linked yet → no rows.
    const before = await fetch(
      `${baseUrl}/api/emails?email=${encodeURIComponent(ADDR)}`,
    );
    expect(before.status).toBe(200);
    expect((await before.json()).data).toHaveLength(0);

    // Link, then look up with different casing.
    const post = await fetch(`${baseUrl}/api/emails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADDR, personId: PERSON_ID, type: "work" }),
    });
    expect(post.status).toBe(201);

    const after = await fetch(
      `${baseUrl}/api/emails?email=${encodeURIComponent(ADDR.toUpperCase())}`,
    );
    const rows = (await after.json()).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe(PERSON_ID);
  }, 30_000);

  it("POST /emails re-attributes existing messages involving the address", async () => {
    // The POST in the previous test already ran the backfill.
    const rows = await db
      .select({
        id: emailMessages.id,
        matched: emailMessages.matchedPersonIds,
      })
      .from(emailMessages)
      .where(
        inArrayFn(emailMessages.id, [
          MSG_FROM,
          MSG_TO,
          MSG_UNRELATED,
          MSG_ALREADY,
        ]),
      );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.matched]));
    expect(byId[MSG_FROM]).toEqual([PERSON_ID]); // sender match
    expect(byId[MSG_TO]).toEqual([PERSON_ID]); // recipient match, case-insensitive
    expect(byId[MSG_UNRELATED] ?? []).toEqual([]); // untouched
    expect(byId[MSG_ALREADY]).toEqual([PERSON_ID]); // no duplicate append
  }, 30_000);
});
