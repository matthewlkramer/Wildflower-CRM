import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Coverage for the reviewer-driven re-run path of `proposeActionsForProposal`
 * (the engine behind POST /api/email-proposals/:id/revise).
 *
 * The "Propose alternative" action lets a reviewer re-run the AI with a
 * plain-English correction. A core requirement is that the proposal STAYS in
 * the review queue (status `pending`) afterwards — even when the model decides
 * the whole thing is noise and returns suppress=true with no actions. The
 * reviewer explicitly asked to re-run it, so it must not be auto-ignored out
 * from under them. The `disableAutoSuppress` flag (set by the revise route)
 * enforces that.
 *
 * Asserts:
 *   - re-run with { disableAutoSuppress: true } on a suppress+no-actions
 *     response leaves the row `pending` (refreshed actions/error still recorded)
 *   - the normal (non-revise) path with the SAME response still auto-ignores,
 *     proving the suppression behavior is intact and only gated by the flag
 *
 * Only the Anthropic SDK is mocked (so no real model call / tokens); the DB
 * writes and the suppress predicate are the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

// Mock the Anthropic SDK BEFORE importing the module under test. Every call
// returns "this is noise" — suppress=true with no actions — which is exactly
// the response that would auto-ignore a proposal on the normal path.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create } },
  // Pass-through: the real wrapper only adds rate-limit backoff, which we
  // don't exercise here.
  withRateLimitRetry: (fn: () => unknown) => fn(),
}));

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  emailProposals: Db["emailProposals"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let proposeActionsForProposal: (typeof import("../lib/proposeActions"))["proposeActionsForProposal"];

const RUN = `revise_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PENDING_ID = `${RUN}_keep_pending`;
const IGNORE_ID = `${RUN}_auto_ignore`;

function suppressResponse() {
  return {
    content: [
      {
        type: "tool_use",
        name: "propose_actions",
        input: {
          actions: [],
          suppress: { shouldSuppress: true, reason: "test noise" },
        },
      },
    ],
  };
}

async function seedProposal(id: string) {
  await db.insert(schema.emailProposals).values({
    id,
    mailboxUserId: USER_ID,
    kind: "signature_update",
    status: "pending",
    payload: {},
    proposedActions: [],
    actionsAnalyzedAt: null,
    dedupeKey: id,
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  create.mockResolvedValue(suppressResponse());

  const dbMod = await import("@workspace/db");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    emailProposals: dbMod.emailProposals,
  };
  eqFn = (await import("drizzle-orm")).eq;
  proposeActionsForProposal = (await import("../lib/proposeActions"))
    .proposeActionsForProposal;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${USER_ID}_clerk`,
    email: `${USER_ID}@example.com`,
    displayName: "Revise Test User",
  });
  await seedProposal(PENDING_ID);
  await seedProposal(IGNORE_ID);
}, 30000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.emailProposals)
    .where(eqFn(schema.emailProposals.mailboxUserId, USER_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 30000);

describe.skipIf(!HAS_DB)("proposeActionsForProposal revise path", () => {
  it("keeps the proposal pending when disableAutoSuppress is set", async () => {
    const out = await proposeActionsForProposal(PENDING_ID, {
      reviewerGuidance: "This is actually a real change — keep it visible.",
      disableAutoSuppress: true,
    });
    expect(out.ranAI).toBe(true);

    const [row] = await db
      .select()
      .from(schema.emailProposals)
      .where(eqFn(schema.emailProposals.id, PENDING_ID));
    expect(row.status).toBe("pending");
    expect(row.resolvedAt).toBeNull();
    // The analysis result is still recorded (in-flight sentinel cleared).
    expect(row.actionsAnalyzedAt).not.toBeNull();
    expect(row.actionsError).toBeNull();
  });

  it("still auto-ignores on the normal path with the same response", async () => {
    const out = await proposeActionsForProposal(IGNORE_ID);
    expect(out.ranAI).toBe(true);

    const [row] = await db
      .select()
      .from(schema.emailProposals)
      .where(eqFn(schema.emailProposals.id, IGNORE_ID));
    expect(row.status).toBe("ignored");
    expect(row.resolvedAt).not.toBeNull();
  });
});
