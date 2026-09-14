import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
const run = `discovery_${Date.now()}`;
const owner = `${run}_owner`,
  other = `${run}_other`,
  person = `${run}_person`;
const { caller } = vi.hoisted(() => ({ caller: { id: "", role: "admin" } }));
caller.id = owner;
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = caller;
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
let schema: typeof import("@workspace/db");
let drizzle: typeof import("drizzle-orm");
let server: Server;
let base: string;
const unknown = `${run}@new.example.org`,
  old = `${run}@old.example.org`;
const hidden = `${run}@hidden.example.org`,
  shared = `${run}@shared.example.org`;
beforeAll(async () => {
  schema = await import("@workspace/db");
  drizzle = await import("drizzle-orm");
  const { db } = schema;
  await db
    .insert(schema.users)
    .values(
      [owner, other].map((id) => ({
        id,
        clerkId: id,
        email: `${id}@wildflowerschools.org`,
        role: "admin" as const,
      })),
    );
  await db.insert(schema.people).values({ id: person, fullName: "Sara Allan" });
  await db
    .insert(schema.emails)
    .values({ id: `${run}_email`, personId: person, email: old });
  const now = new Date();
  await db
    .insert(schema.emailSyncSkip)
    .values([
      ...[1, 2].map((n) => ({
        mailboxUserId: owner,
        gmailMessageId: `${run}_${n}`,
        fromAddrs: [`${owner}@wildflowerschools.org`],
        toAddrs: [unknown, old],
        sentAt: now,
      })),
      ...[1, 2].map((n) => ({
        mailboxUserId: other,
        gmailMessageId: `${run}_hidden_${n}`,
        fromAddrs: [`${other}@wildflowerschools.org`],
        toAddrs: [hidden],
        sentAt: now,
      })),
      {
        mailboxUserId: owner,
        gmailMessageId: `${run}_inbound`,
        fromAddrs: [hidden],
        toAddrs: [`${owner}@wildflowerschools.org`],
        sentAt: now,
      },
    ]);
  await db
    .insert(schema.emailMessages)
    .values([
      {
        id: `${run}_promoted`,
        mailboxUserId: owner,
        gmailMessageId: `${run}_1`,
        gmailThreadId: `${run}_thread`,
        direction: "sent",
        toEmails: [unknown, old],
        sentAt: new Date(Date.now() - 60_000),
        isPrivate: true,
      },
      ...[1, 2].map((n) => ({
        id: `${run}_shared_${n}`,
        mailboxUserId: other,
        gmailMessageId: `${run}_shared_${n}`,
        gmailThreadId: `${run}_shared_thread`,
        direction: "sent" as const,
        toEmails: [shared],
        sentAt: now,
        isPrivate: false,
      })),
    ]);
  const { default: app } = await import("../app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  const { db } = schema;
  await db
    .delete(schema.emailProposals)
    .where(drizzle.eq(schema.emailProposals.mailboxUserId, owner));
  await db
    .delete(schema.users)
    .where(drizzle.inArray(schema.users.id, [owner, other]));
  await db.delete(schema.people).where(drizzle.eq(schema.people.id, person));
});
describe("new correspondent discovery", () => {
  it("includes unmatched sent headers without inferring identity or double counting promoted mail", async () => {
    const response = await fetch(`${base}/api/correspondents/unrecognized`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(
      data.find((r: { emailAddress: string }) => r.emailAddress === unknown),
    ).toMatchObject({
      sentMessageCount: 2,
      threadCount: 1,
      threadCountComplete: false,
    });
    expect(
      data.some((r: { emailAddress: string }) =>
        [old, hidden, shared].includes(r.emailAddress),
      ),
    ).toBe(false);
  });
  it("all-mailboxes includes shared mail but never another owner's unmatched headers", async () => {
    const { data } = await (
      await fetch(`${base}/api/correspondents/unrecognized?allMailboxes=true`)
    ).json();
    expect(
      data.some((r: { emailAddress: string }) => r.emailAddress === shared),
    ).toBe(true);
    expect(
      data.some((r: { emailAddress: string }) => r.emailAddress === hidden),
    ).toBe(false);
  });
  it("requires same-mailbox thread evidence before suggesting a changed address, and preserves prior review", async () => {
    const { processReplyAddressChange } =
      await import("../lib/emailIntelligence");
    const args = {
      mailboxUserId: owner,
      mailboxEmail: `${owner}@wildflowerschools.org`,
      fromAddresses: [unknown],
      fromHeader: `Sara Allan <${unknown}>`,
      gmailThreadId: `${run}_thread`,
      gmailMessageId: `${run}_reply`,
      sentAt: new Date(),
    };
    await processReplyAddressChange({
      ...args,
      gmailThreadId: `${run}_unrelated`,
    });
    expect(
      await schema.db
        .select()
        .from(schema.emailProposals)
        .where(drizzle.eq(schema.emailProposals.mailboxUserId, owner)),
    ).toHaveLength(0);
    await processReplyAddressChange(args);
    const proposals = await schema.db
      .select()
      .from(schema.emailProposals)
      .where(drizzle.eq(schema.emailProposals.mailboxUserId, owner));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposedActions).toEqual([
      expect.objectContaining({
        type: "add_email",
        personId: person,
        emailAddress: unknown,
        setPrimary: true,
      }),
    ]);
    expect(proposals[0].actionsAnalyzedAt).not.toBeNull();
    await processReplyAddressChange(args);
    expect(
      await schema.db
        .select()
        .from(schema.emailProposals)
        .where(drizzle.eq(schema.emailProposals.mailboxUserId, owner)),
    ).toHaveLength(1);
    expect(
      await schema.db
        .select()
        .from(schema.emails)
        .where(drizzle.eq(schema.emails.personId, person)),
    ).toHaveLength(1);
  });
});
