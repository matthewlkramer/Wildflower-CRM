import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `trackingqueue_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const OWNER_ID = `${RUN}_owner`;
const MEMBER_ID = `${RUN}_member`;
const ADMIN_EMAIL = `${ADMIN_ID}@wildflowerschools.org`;
const OWNER_EMAIL = `${OWNER_ID}@wildflowerschools.org`;
const MEMBER_EMAIL = `${MEMBER_ID}@wildflowerschools.org`;
const OUT_OWNER = `${RUN}_out_owner`;
const OUT_MEMBER = `${RUN}_out_member`;
const OUT_OLD = `${RUN}_out_old`;
const OUT_NO_CRM = `${RUN}_out_no_crm`;
const IN_OWNER_WAIT = `${RUN}_in_owner_wait`;
const IN_OWNER_YOUNG = `${RUN}_in_owner_young`;
const IN_OWNER_REPLIED = `${RUN}_in_owner_replied`;
const OWNER_REPLY = `${RUN}_owner_reply`;
const OUTBOUND_REPLY = `${RUN}_outbound_reply`;
const IN_MEMBER_WAIT = `${RUN}_in_member_wait`;
const IN_MEMBER_PRIVATE = `${RUN}_in_member_private`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "", email: "" } as {
    id: string;
    role: string;
    email: string;
  },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string; email: string } },
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
let server: Server;
let baseUrl = "";

function asUser(id: string, role: string, email: string) {
  auth.current = { id, role, email };
}

async function getQueue(
  type: "outbound" | "inbound",
  allMailboxes = false,
) {
  const res = await fetch(
    `${baseUrl}/api/email-tracking/${type}?allMailboxes=${allMailboxes}`,
  );
  return {
    status: res.status,
    json: (await res.json()) as { data: Array<Record<string, unknown>> },
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  dbMod = await import("@workspace/db");
  db = dbMod.db;
  await db.insert(dbMod.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: ADMIN_EMAIL,
      role: "admin",
      displayName: "Admin Reviewer",
    },
    {
      id: OWNER_ID,
      clerkId: `clerk_${OWNER_ID}`,
      email: OWNER_EMAIL,
      role: "team_member",
      displayName: "Mailbox Owner",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: MEMBER_EMAIL,
      role: "team_member",
      displayName: "Other Mailbox",
    },
  ]);
  const now = Date.now();
  await db.insert(dbMod.trackedEmails).values([
    {
      id: OUT_OWNER,
      subject: "Owner recent tracked",
      recipient: "crm-person@example.org",
      sender: OWNER_EMAIL,
      gmailThreadId: `${RUN}_thread_out_owner`,
      recipientPersonIds: [`${RUN}_person`],
      createdAt: new Date(now - 2 * 24 * 60 * 60_000),
    },
    {
      id: OUT_MEMBER,
      subject: "Member recent tracked",
      recipient: "member-person@example.org",
      sender: MEMBER_EMAIL,
      gmailThreadId: `${RUN}_thread_out_member`,
      recipientPersonIds: [`${RUN}_person_2`],
      createdAt: new Date(now - 3 * 24 * 60 * 60_000),
    },
    {
      id: OUT_OLD,
      subject: "Too old",
      recipient: "crm-person@example.org",
      sender: OWNER_EMAIL,
      recipientPersonIds: [`${RUN}_person`],
      createdAt: new Date(now - 15 * 24 * 60 * 60_000),
    },
    {
      id: OUT_NO_CRM,
      subject: "No CRM match",
      recipient: "unknown@example.org",
      sender: OWNER_EMAIL,
      createdAt: new Date(now - 24 * 60 * 60_000),
    },
  ]);

  const received = (
    id: string,
    mailboxUserId: string,
    gmailThreadId: string,
    hoursAgo: number,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    gmailMessageId: `${id}_gmail`,
    gmailThreadId,
    mailboxUserId,
    direction: "received" as const,
    sentAt: new Date(now - hoursAgo * 60 * 60_000),
    subject: `Subject ${id}`,
    fromEmail: "crm-person@example.org",
    matchedPersonIds: [`${RUN}_person`],
    ...extra,
  });
  await db.insert(dbMod.emailMessages).values([
    received(
      OUTBOUND_REPLY,
      OWNER_ID,
      `${RUN}_thread_out_owner`,
      24,
    ),
    received(IN_OWNER_WAIT, OWNER_ID, `${RUN}_thread_in_owner_wait`, 30),
    received(IN_OWNER_YOUNG, OWNER_ID, `${RUN}_thread_in_owner_young`, 10),
    received(IN_OWNER_REPLIED, OWNER_ID, `${RUN}_thread_in_replied`, 40),
    {
      id: OWNER_REPLY,
      gmailMessageId: `${OWNER_REPLY}_gmail`,
      gmailThreadId: `${RUN}_thread_in_replied`,
      mailboxUserId: OWNER_ID,
      direction: "sent" as const,
      sentAt: new Date(now - 30 * 60 * 60_000),
      subject: "Replied",
      fromEmail: OWNER_EMAIL,
      toEmails: ["crm-person@example.org"],
    },
    received(IN_MEMBER_WAIT, MEMBER_ID, `${RUN}_thread_in_member`, 32),
    received(
      IN_MEMBER_PRIVATE,
      MEMBER_ID,
      `${RUN}_thread_out_member`,
      34,
      { isPrivate: true },
    ),
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
  const { inArray } = await import("drizzle-orm");
  await db
    .delete(dbMod.emailTrackingResolutions)
    .where(
      inArray(dbMod.emailTrackingResolutions.sourceId, [
        OUT_OWNER,
        OUT_MEMBER,
        IN_OWNER_WAIT,
        IN_MEMBER_WAIT,
        IN_MEMBER_PRIVATE,
      ]),
    );
  await db
    .delete(dbMod.emailMessages)
    .where(
      inArray(dbMod.emailMessages.id, [
        OUTBOUND_REPLY,
        IN_OWNER_WAIT,
        IN_OWNER_YOUNG,
        IN_OWNER_REPLIED,
        OWNER_REPLY,
        IN_MEMBER_WAIT,
        IN_MEMBER_PRIVATE,
      ]),
    );
  await db
    .delete(dbMod.trackedEmails)
    .where(
      inArray(dbMod.trackedEmails.id, [
        OUT_OWNER,
        OUT_MEMBER,
        OUT_OLD,
        OUT_NO_CRM,
      ]),
    );
  await db
    .delete(dbMod.users)
    .where(inArray(dbMod.users.id, [ADMIN_ID, OWNER_ID, MEMBER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("email tracking action queues", () => {
  it("keeps staff mailbox-scoped even when allMailboxes is manipulated", async () => {
    asUser(MEMBER_ID, "team_member", MEMBER_EMAIL);
    const outbound = await getQueue("outbound", true);
    expect(outbound.status).toBe(200);
    const outboundIds = outbound.json.data.map((r) => r.id);
    expect(outboundIds).toContain(OUT_MEMBER);
    expect(outboundIds).not.toContain(OUT_OWNER);
    expect(outbound.json.data.find((r) => r.id === OUT_MEMBER)?.mailboxUserName).toBeNull();

    const inbound = await getQueue("inbound", true);
    const inboundIds = inbound.json.data.map((r) => r.id);
    expect(inboundIds).toContain(IN_MEMBER_WAIT);
    expect(inboundIds).toContain(IN_MEMBER_PRIVATE);
    expect(inboundIds).not.toContain(IN_OWNER_WAIT);
  }, 30_000);

  it("enforces age/contact/reply rules and detects a later reply in the same mailbox thread", async () => {
    asUser(OWNER_ID, "team_member", OWNER_EMAIL);
    const outbound = await getQueue("outbound");
    const ownerOutbound = outbound.json.data.find((r) => r.id === OUT_OWNER);
    expect(ownerOutbound?.laterReply).toBe(true);
    expect(outbound.json.data.map((r) => r.id)).not.toContain(OUT_OLD);
    expect(outbound.json.data.map((r) => r.id)).not.toContain(OUT_NO_CRM);

    const inbound = await getQueue("inbound");
    const inboundIds = inbound.json.data.map((r) => r.id);
    expect(inboundIds).toContain(IN_OWNER_WAIT);
    expect(inboundIds).not.toContain(IN_OWNER_YOUNG);
    expect(inboundIds).not.toContain(IN_OWNER_REPLIED);
  }, 30_000);

  it("lets admins review non-private rows across mailboxes without exposing private source email", async () => {
    asUser(ADMIN_ID, "admin", ADMIN_EMAIL);
    const outbound = await getQueue("outbound", true);
    const owner = outbound.json.data.find((r) => r.id === OUT_OWNER);
    const member = outbound.json.data.find((r) => r.id === OUT_MEMBER);
    expect(owner?.mailboxUserName).toBe("Mailbox Owner");
    expect(member?.mailboxUserName).toBe("Other Mailbox");
    // The only reply in the member's thread is private. Cross-mailbox admins
    // must not infer its existence from the reply-status boolean.
    expect(member?.laterReply).toBe(false);

    const inbound = await getQueue("inbound", true);
    const inboundIds = inbound.json.data.map((r) => r.id);
    expect(inboundIds).toContain(IN_OWNER_WAIT);
    expect(inboundIds).toContain(IN_MEMBER_WAIT);
    expect(inboundIds).not.toContain(IN_MEMBER_PRIVATE);
  }, 30_000);

  it("resolves idempotently, preserves mailbox owner, and records the acting reviewer", async () => {
    asUser(ADMIN_ID, "admin", ADMIN_EMAIL);
    const first = await fetch(
      `${baseUrl}/api/email-tracking/queue/outbound/${OUT_OWNER}/resolve`,
      { method: "POST" },
    );
    const second = await fetch(
      `${baseUrl}/api/email-tracking/queue/outbound/${OUT_OWNER}/resolve`,
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = (await first.json()) as Record<string, unknown>;
    const secondJson = (await second.json()) as Record<string, unknown>;
    expect(secondJson.id).toBe(firstJson.id);
    expect(firstJson.mailboxUserId).toBe(OWNER_ID);
    expect(firstJson.resolvedByUserId).toBe(ADMIN_ID);

    const after = await getQueue("outbound", true);
    expect(after.json.data.map((r) => r.id)).not.toContain(OUT_OWNER);
  }, 30_000);

  it("does not let staff open or resolve another mailbox's tracked item by id", async () => {
    asUser(MEMBER_ID, "team_member", MEMBER_EMAIL);
    const detail = await fetch(`${baseUrl}/api/email-tracking/${OUT_OWNER}`);
    expect(detail.status).toBe(404);
    const resolve = await fetch(
      `${baseUrl}/api/email-tracking/queue/outbound/${OUT_OWNER}/resolve`,
      { method: "POST" },
    );
    expect(resolve.status).toBe(404);
  }, 30_000);
});