import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the bounce → person-context link.
 *
 * A `bounce_invalid` proposal must carry the bounced address's CRM owner so
 * the action-proposal step can act on that person's roles. Previously the
 * bounce row stored only `targetEmailId` (not `targetPersonId`), so
 * `proposeActionsForProposal` saw "No matched person on file" and could never
 * emit a role action — reviewer guidance like "mark the role inactive" had no
 * person/role (perId) to target.
 *
 * This asserts the propose-time fallback: when a proposal has no
 * `targetPersonId` but its `subjectEmail` is on file for a person, that
 * person's context (incl. their current role + perId) is rendered into the
 * prompt sent to the model.
 *
 * Only the Anthropic SDK is mocked (we assert on the captured request, no
 * tokens spent); the DB writes and the real context-building code run. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create } },
  withRateLimitRetry: (fn: () => unknown) => fn(),
}));

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  people: Db["people"];
  organizations: Db["organizations"];
  emails: Db["emails"];
  peopleEntityRoles: Db["peopleEntityRoles"];
  emailProposals: Db["emailProposals"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let proposeActionsForProposal: (typeof import("../lib/proposeActions"))["proposeActionsForProposal"];

const RUN = `bouncelink_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const ORG_ID = `${RUN}_org`;
const ORG_NAME = `${RUN} Business Partnership`;
const EMAIL_ID = `${RUN}_email`;
const EMAIL_ADDR = `jim.${RUN}@example.com`;
const ROLE_ID = `${RUN}_role`;
const PROPOSAL_ID = `${RUN}_proposal`;

function noActionsResponse() {
  return {
    content: [
      {
        type: "tool_use",
        name: "propose_actions",
        input: { actions: [], suppress: null },
      },
    ],
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  create.mockResolvedValue(noActionsResponse());

  const dbMod = await import("@workspace/db");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    people: dbMod.people,
    organizations: dbMod.organizations,
    emails: dbMod.emails,
    peopleEntityRoles: dbMod.peopleEntityRoles,
    emailProposals: dbMod.emailProposals,
  };
  eqFn = (await import("drizzle-orm")).eq;
  proposeActionsForProposal = (await import("../lib/proposeActions"))
    .proposeActionsForProposal;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${USER_ID}_clerk`,
    email: `${USER_ID}@example.com`,
    displayName: "Bounce Link Test User",
  });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    firstName: "Jim",
    lastName: "Tester",
    fullName: "Jim Tester",
  });
  await db.insert(schema.organizations).values({ id: ORG_ID, name: ORG_NAME });
  await db.insert(schema.emails).values({
    id: EMAIL_ID,
    email: EMAIL_ADDR,
    personId: PERSON_ID,
    type: "work",
    validity: "invalid",
  });
  await db.insert(schema.peopleEntityRoles).values({
    id: ROLE_ID,
    personId: PERSON_ID,
    entityType: "organization",
    organizationId: ORG_ID,
    connection: "employee",
    current: "current",
  });
  // Bounce proposal WITHOUT targetPersonId — exactly the shape older bounce
  // rows have. subjectEmail matches the person's address on file.
  await db.insert(schema.emailProposals).values({
    id: PROPOSAL_ID,
    mailboxUserId: USER_ID,
    kind: "bounce_invalid",
    status: "pending",
    targetEmailId: EMAIL_ID,
    targetPersonId: null,
    subjectEmail: EMAIL_ADDR,
    subjectDomain: "example.com",
    payload: { recipient: EMAIL_ADDR },
    proposedActions: [],
    actionsAnalyzedAt: null,
    dedupeKey: PROPOSAL_ID,
  });
}, 30000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.emailProposals)
    .where(eqFn(schema.emailProposals.mailboxUserId, USER_ID));
  await db.delete(schema.peopleEntityRoles).where(eqFn(schema.peopleEntityRoles.id, ROLE_ID));
  await db.delete(schema.emails).where(eqFn(schema.emails.id, EMAIL_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.people).where(eqFn(schema.people.id, PERSON_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 30000);

describe.skipIf(!HAS_DB)("bounce proposal person-context fallback", () => {
  it("loads the subject email's owner + current role into the prompt", async () => {
    const out = await proposeActionsForProposal(PROPOSAL_ID, {
      reviewerGuidance: "He no longer works there — mark his role inactive.",
      disableAutoSuppress: true,
    });
    expect(out.ranAI).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);

    const req = create.mock.calls[0][0] as {
      messages: { role: string; content: string }[];
    };
    const userPrompt = req.messages[0].content;

    // The person who was previously invisible to the model is now matched...
    expect(userPrompt).toContain(`Matched person: id=${PERSON_ID}`);
    expect(userPrompt).not.toContain("No matched person on file");
    // ...and their CURRENT role (with the perId the model needs for
    // deactivate_per) is rendered.
    expect(userPrompt).toContain(`id=${ROLE_ID}`);
    expect(userPrompt).toContain("CURRENT");
    expect(userPrompt).toContain(ORG_NAME);
    // The authoritative reviewer guidance is carried through.
    expect(userPrompt).toContain("mark his role inactive");
  });
});
