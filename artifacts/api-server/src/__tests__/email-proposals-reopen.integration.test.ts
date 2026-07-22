import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Re-open ignored email proposal.
 *
 * POST /api/email-proposals/:id/reopen (routes/emailProposals.ts):
 *   - flips an IGNORED proposal back to pending, clears resolution fields,
 *     and appends a "Re-opened by reviewer" note;
 *   - is mailbox-owner-scoped: another user's proposal is a 404 (not leaked
 *     as a 403);
 *   - a proposal that isn't ignored is a 409 `proposal_not_ignored` — reopen
 *     never touches pending/accepted/rejected rows.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `reopenspec_${Date.now()}`;
const OWNER_ID = `${RUN}_owner`;
const OTHER_ID = `${RUN}_other`;
const PROP_IGNORED = `${RUN}_prop_ignored`;
const PROP_PENDING = `${RUN}_prop_pending`;
const PROP_FOREIGN = `${RUN}_prop_foreign`;

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
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function reopen(id: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}/api/email-proposals/${id}/reopen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(dbMod.users).values([
    {
      id: OWNER_ID,
      clerkId: `clerk_${OWNER_ID}`,
      email: `${OWNER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: OTHER_ID,
      clerkId: `clerk_${OTHER_ID}`,
      email: `${OTHER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);
  await db.insert(dbMod.emailProposals).values([
    {
      id: PROP_IGNORED,
      mailboxUserId: OWNER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PROP_IGNORED}`,
      status: "ignored",
      resolvedAt: new Date(),
      reviewerNote: "not relevant",
    },
    {
      id: PROP_PENDING,
      mailboxUserId: OWNER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PROP_PENDING}`,
      status: "pending",
    },
    {
      id: PROP_FOREIGN,
      mailboxUserId: OTHER_ID,
      kind: "bounce_soft" as const,
      dedupeKey: `dedupe_${PROP_FOREIGN}`,
      status: "ignored",
      resolvedAt: new Date(),
    },
  ]);

  auth.current = { id: OWNER_ID, role: "team_member" };
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
        PROP_IGNORED,
        PROP_PENDING,
        PROP_FOREIGN,
      ]),
    );
  await db
    .delete(dbMod.users)
    .where(inArrayFn(dbMod.users.id, [OWNER_ID, OTHER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("reopen ignored email proposal", () => {
  it("flips own ignored proposal back to pending and appends the reopen note", async () => {
    const { status } = await reopen(PROP_IGNORED);
    expect(status).toBe(200);
    const [row] = await db
      .select()
      .from(dbMod.emailProposals)
      .where(eqFn(dbMod.emailProposals.id, PROP_IGNORED));
    expect(row.status).toBe("pending");
    expect(row.resolvedAt).toBeNull();
    expect(row.reviewerNote ?? "").toContain("Re-opened by reviewer");
    // The pre-existing reviewer note is preserved, not overwritten.
    expect(row.reviewerNote ?? "").toContain("not relevant");
  }, 30_000);

  it("rejects reopening a non-ignored proposal with 409 proposal_not_ignored", async () => {
    const { status, json } = await reopen(PROP_PENDING);
    expect(status).toBe(409);
    expect(JSON.stringify(json)).toContain("proposal_not_ignored");
    const [row] = await db
      .select()
      .from(dbMod.emailProposals)
      .where(eqFn(dbMod.emailProposals.id, PROP_PENDING));
    expect(row.status).toBe("pending");
  }, 30_000);

  it("another user's proposal is a 404 (mailbox-owner scoped)", async () => {
    const { status } = await reopen(PROP_FOREIGN);
    expect(status).toBe(404);
    const [row] = await db
      .select()
      .from(dbMod.emailProposals)
      .where(eqFn(dbMod.emailProposals.id, PROP_FOREIGN));
    expect(row.status).toBe("ignored");
  }, 30_000);
});
