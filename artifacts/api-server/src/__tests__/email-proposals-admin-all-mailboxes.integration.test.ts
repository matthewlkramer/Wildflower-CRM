import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Admin all-mailboxes email-intelligence review (routes/emailProposals.ts,
 * routes/correspondents.ts):
 *   - GET /email-proposals?allMailboxes=true returns rows across mailboxes
 *     WITH mailboxUserName only for admins; non-admins passing the flag stay
 *     scoped to their own mailbox;
 *   - proposal mutations (reject here as representative) work cross-mailbox
 *     for admins (resolvedByUserId records the acting admin) but remain a
 *     404 for non-admins;
 *   - POST /correspondent-ignore with a foreign mailboxUserId is a 403 for
 *     non-admins and writes to the TARGET mailbox's ignore list for admins.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `adminallmb_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const OWNER_ID = `${RUN}_owner`;
const PROP_OWNER_A = `${RUN}_prop_a`;
const PROP_OWNER_B = `${RUN}_prop_b`;
const PROP_MEMBER = `${RUN}_prop_m`;
const PRIVATE_SOURCE_MESSAGE = `${RUN}_private_source_message`;
const PRIVATE_PROP = `${RUN}_private_prop`;
const IGNORE_ADDR = `${RUN}@example.org`.toLowerCase();
const PRIVATE_CORRESPONDENT = `${RUN}.private@example.org`.toLowerCase();
const PUBLIC_CORRESPONDENT = `${RUN}.public@example.org`.toLowerCase();
const CORRESPONDENT_MESSAGE_IDS = Array.from(
  { length: 4 },
  (_, index) => `${RUN}_correspondent_message_${index}`,
);

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
let dbMod: Db;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function listProposals(
  qs: string,
): Promise<{ status: number; json: { data?: Array<Record<string, unknown>> } }> {
  const res = await fetch(`${baseUrl}/api/email-proposals?${qs}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;

  await db.insert(dbMod.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
      displayName: "Admin Reviewer",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@wildflowerschools.org`,
      role: "team_member",
      displayName: "Team Member",
    },
    {
      id: OWNER_ID,
      clerkId: `clerk_${OWNER_ID}`,
      email: `${OWNER_ID}@wildflowerschools.org`,
      role: "team_member",
      displayName: "Mailbox Owner",
    },
  ]);
  const now = Date.now();
  await db.insert(dbMod.emailMessages).values([
    {
      id: PRIVATE_SOURCE_MESSAGE,
      gmailMessageId: `${PRIVATE_SOURCE_MESSAGE}_gmail`,
      gmailThreadId: `${PRIVATE_SOURCE_MESSAGE}_thread`,
      mailboxUserId: OWNER_ID,
      direction: "received" as const,
      sentAt: new Date(now - 60_000),
      subject: "Private proposal source",
      fromEmail: "private-source@example.org",
      isPrivate: true,
    },
    ...CORRESPONDENT_MESSAGE_IDS.map((id, index) => ({
      id,
      gmailMessageId: `${id}_gmail`,
      gmailThreadId: `${id}_thread`,
      mailboxUserId: OWNER_ID,
      direction: "sent" as const,
      sentAt: new Date(now - (index + 2) * 60_000),
      subject: index < 2 ? "Private correspondent" : "Public correspondent",
      fromEmail: `${OWNER_ID}@wildflowerschools.org`,
      toEmails: [index < 2 ? PRIVATE_CORRESPONDENT : PUBLIC_CORRESPONDENT],
      isPrivate: index < 2,
    })),
  ]);
  await db.insert(dbMod.emailProposals).values([
    {
      id: PROP_OWNER_A,
      mailboxUserId: OWNER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PROP_OWNER_A}`,
      status: "pending",
    },
    {
      id: PROP_OWNER_B,
      mailboxUserId: OWNER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PROP_OWNER_B}`,
      status: "pending",
    },
    {
      id: PROP_MEMBER,
      mailboxUserId: MEMBER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PROP_MEMBER}`,
      status: "pending",
    },
    {
      id: PRIVATE_PROP,
      mailboxUserId: OWNER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PRIVATE_PROP}`,
      status: "pending",
      sourceMessageId: PRIVATE_SOURCE_MESSAGE,
    },
  ]);

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
    .delete(dbMod.emailProposals)
    .where(
      inArrayFn(dbMod.emailProposals.id, [
        PROP_OWNER_A,
        PROP_OWNER_B,
        PROP_MEMBER,
        PRIVATE_PROP,
      ]),
    );
  await db
    .delete(dbMod.correspondentIgnore)
    .where(eqFn(dbMod.correspondentIgnore.emailLower, IGNORE_ADDR));
  await db
    .delete(dbMod.emailMessages)
    .where(
      inArrayFn(dbMod.emailMessages.id, [
        PRIVATE_SOURCE_MESSAGE,
        ...CORRESPONDENT_MESSAGE_IDS,
      ]),
    );
  await db
    .delete(dbMod.users)
    .where(inArrayFn(dbMod.users.id, [ADMIN_ID, MEMBER_ID, OWNER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("admin all-mailboxes review", () => {
  it("admin with allMailboxes=true sees other mailboxes' rows with mailboxUserName", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await listProposals(
      "allMailboxes=true&kind=bounce_soft&status=pending&limit=100",
    );
    expect(status).toBe(200);
    const mine = (json.data ?? []).filter((r) =>
      [PROP_OWNER_A, PROP_OWNER_B, PROP_MEMBER].includes(String(r.id)),
    );
    expect(mine.length).toBe(3);
    const ownerRow = mine.find((r) => r.id === PROP_OWNER_A);
    expect(ownerRow?.mailboxUserName).toBe("Mailbox Owner");
    expect((json.data ?? []).map((r) => r.id)).not.toContain(PRIVATE_PROP);
  }, 30_000);

  it("does not expose or mutate another mailbox's private-source proposal", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const denied = await fetch(
      `${baseUrl}/api/email-proposals/${PRIVATE_PROP}/reject`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    expect(denied.status).toBe(404);

    auth.current = { id: OWNER_ID, role: "team_member" };
    const own = await listProposals("kind=bounce_soft&status=pending&limit=100");
    expect(own.status).toBe(200);
    expect((own.json.data ?? []).map((r) => r.id)).toContain(PRIVATE_PROP);
  }, 30_000);

  it("non-admin passing allMailboxes=true stays scoped to their own mailbox", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const { status, json } = await listProposals(
      "allMailboxes=true&kind=bounce_soft&status=pending&limit=100",
    );
    expect(status).toBe(200);
    const ids = (json.data ?? []).map((r) => r.id);
    expect(ids).toContain(PROP_MEMBER);
    expect(ids).not.toContain(PROP_OWNER_A);
    // The owner label is never exposed outside the admin mode.
    const memberRow = (json.data ?? []).find((r) => r.id === PROP_MEMBER);
    expect(memberRow?.mailboxUserName ?? null).toBeNull();
  }, 30_000);

  it("non-admin cannot mutate a foreign proposal (404), admin can (resolvedBy = admin)", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const denied = await fetch(
      `${baseUrl}/api/email-proposals/${PROP_OWNER_A}/reject`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    expect(denied.status).toBe(404);

    auth.current = { id: ADMIN_ID, role: "admin" };
    const ok = await fetch(
      `${baseUrl}/api/email-proposals/${PROP_OWNER_A}/reject`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    expect(ok.status).toBe(200);
    const [row] = await db
      .select()
      .from(dbMod.emailProposals)
      .where(eqFn(dbMod.emailProposals.id, PROP_OWNER_A));
    expect(row.status).toBe("rejected");
    // Audit trail: the acting admin, not the mailbox owner.
    expect(row.resolvedByUserId).toBe(ADMIN_ID);
    // The mailbox attribution is untouched.
    expect(row.mailboxUserId).toBe(OWNER_ID);
  }, 30_000);

  it("correspondent-ignore on behalf of another mailbox: 403 for non-admin, lands in target list for admin", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const denied = await fetch(`${baseUrl}/api/correspondent-ignore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailAddress: IGNORE_ADDR,
        mailboxUserId: OWNER_ID,
      }),
    });
    expect(denied.status).toBe(403);

    auth.current = { id: ADMIN_ID, role: "admin" };
    const ok = await fetch(`${baseUrl}/api/correspondent-ignore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailAddress: IGNORE_ADDR,
        mailboxUserId: OWNER_ID,
      }),
    });
    expect(ok.status).toBe(204);
    const rows = await db
      .select()
      .from(dbMod.correspondentIgnore)
      .where(
        andFn(
          eqFn(dbMod.correspondentIgnore.emailLower, IGNORE_ADDR),
          eqFn(dbMod.correspondentIgnore.mailboxUserId, OWNER_ID),
        ),
      );
    expect(rows.length).toBe(1);
  }, 30_000);

  it("does not derive cross-mailbox correspondent suggestions from private sent mail", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const adminRes = await fetch(
      `${baseUrl}/api/correspondents/unrecognized?allMailboxes=true&days=30&minThreads=2`,
    );
    expect(adminRes.status).toBe(200);
    const adminJson = (await adminRes.json()) as {
      data: Array<{ emailAddress: string }>;
    };
    const adminAddresses = adminJson.data.map((row) => row.emailAddress);
    expect(adminAddresses).toContain(PUBLIC_CORRESPONDENT);
    expect(adminAddresses).not.toContain(PRIVATE_CORRESPONDENT);

    auth.current = { id: OWNER_ID, role: "team_member" };
    const ownerRes = await fetch(
      `${baseUrl}/api/correspondents/unrecognized?days=30&minThreads=2`,
    );
    expect(ownerRes.status).toBe(200);
    const ownerJson = (await ownerRes.json()) as {
      data: Array<{ emailAddress: string }>;
    };
    expect(ownerJson.data.map((row) => row.emailAddress)).toContain(
      PRIVATE_CORRESPONDENT,
    );
  }, 30_000);
});
