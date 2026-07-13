import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the outbound thank-you / acknowledgment detector
 * (`processIntelForOutbound` → `detectThankYou`) and the accept-path link in
 * routes/emailProposals.
 *
 * The detector resolves every recipient of an attachment-bearing, "thank"-
 * subject outbound email to the THREE donor kinds a gift can carry under
 * Donor XOR (organization / individual giver / household) and emits one
 * pending proposal per unlinked candidate gift within the ±30-day window.
 * This suite asserts detection + linking for all three donor types, plus the
 * no-candidate and already-linked no-op cases, and that accepting a proposal
 * stamps the gift regardless of donor type.
 *
 * Mirrors the gift-merge suite: the only seam mocked is the Clerk auth gate;
 * a seeded user is injected. AI action fan-out is disabled via
 * SKIP_INLINE_ACTION_PROPOSAL=1. All rows use a unique run prefix and are
 * cleaned up. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `ty_test_user_${Date.now()}`,
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

const RUN = `tydetect_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const PERSON_INDIV_ID = `${RUN}_person_indiv`;
const PERSON_HH_MEMBER_ID = `${RUN}_person_hhmember`;
const HOUSEHOLD_ID = `${RUN}_household`;
const ROLE_ID = `${RUN}_role`;
const MSG_ID = `${RUN}_msg`;

const ORG_EMAIL = `org-${RUN}@example-funder.org`;
const INDIV_EMAIL = `indiv-${RUN}@example-donor.com`;
const HH_MEMBER_EMAIL = `hhmember-${RUN}@example-family.com`;
const NO_CANDIDATE_EMAIL = `nobody-${RUN}@example-nowhere.com`;

const GIFT_ORG_ID = `${RUN}_gift_org`;
const GIFT_INDIV_ID = `${RUN}_gift_indiv`;
const GIFT_HH_ID = `${RUN}_gift_hh`;
const GIFT_LINKED_ID = `${RUN}_gift_linked`;

const SENT_AT = new Date();
const DATE_RECEIVED = SENT_AT.toISOString().slice(0, 10);

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  households: Db["households"];
  peopleEntityRoles: Db["peopleEntityRoles"];
  emails: Db["emails"];
  emailMessages: Db["emailMessages"];
  emailProposals: Db["emailProposals"];
  giftsAndPayments: Db["giftsAndPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let processIntelForOutbound: typeof import("../lib/emailIntelligence")["processIntelForOutbound"];
let server: Server;
let baseUrl = "";
let prevSkipFlag: string | undefined;

async function seedGift(
  id: string,
  donor: {
    organizationId?: string | null;
    individualGiverPersonId?: string | null;
    householdId?: string | null;
  },
  opts: { thankYouEmailMessageId?: string | null } = {},
): Promise<void> {
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: "250.00",
    dateReceived: DATE_RECEIVED,
    organizationId: donor.organizationId ?? null,
    individualGiverPersonId: donor.individualGiverPersonId ?? null,
    householdId: donor.householdId ?? null,
    thankYouEmailMessageId: opts.thankYouEmailMessageId ?? null,
  });
}

async function runDetector(recipient: string): Promise<void> {
  await processIntelForOutbound({
    mailboxUserId: TEST_USER_ID,
    messageRowId: MSG_ID,
    fromEmail: `${TEST_USER_ID}@wildflowerschools.org`,
    toEmails: [recipient],
    subject: "Thank you for your generous gift!",
    sentAt: SENT_AT,
    attachmentMimeTypes: ["application/pdf"],
  });
}

async function proposalsForGift(giftId: string) {
  const rows = await db
    .select()
    .from(schema.emailProposals)
    .where(eqFn(schema.emailProposals.mailboxUserId, TEST_USER_ID));
  return rows.filter(
    (r) =>
      (r.payload as Record<string, unknown> | null)?.giftId === giftId,
  );
}

async function readGift(id: string) {
  const [row] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
  return row;
}

async function accept(
  proposalId: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(
    `${baseUrl}/api/email-proposals/${proposalId}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  prevSkipFlag = process.env.SKIP_INLINE_ACTION_PROPOSAL;
  process.env.SKIP_INLINE_ACTION_PROPOSAL = "1";

  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    people: dbMod.people,
    households: dbMod.households,
    peopleEntityRoles: dbMod.peopleEntityRoles,
    emails: dbMod.emails,
    emailMessages: dbMod.emailMessages,
    emailProposals: dbMod.emailProposals,
    giftsAndPayments: dbMod.giftsAndPayments,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  likeFn = drizzle.like;
  ({ processIntelForOutbound } = await import("../lib/emailIntelligence"));

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `TY Detector Org ${RUN}`,
  });
  await db.insert(schema.people).values([
    { id: PERSON_INDIV_ID, fullName: `TY Indiv Donor ${RUN}` },
    { id: PERSON_HH_MEMBER_ID, fullName: `TY Household Member ${RUN}` },
  ]);
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: `TY Detector Household ${RUN}`,
  });
  // Current household membership for the member person (exercises the
  // emails → people_entity_roles household-join resolution path).
  await db.insert(schema.peopleEntityRoles).values({
    id: ROLE_ID,
    personId: PERSON_HH_MEMBER_ID,
    entityType: "household",
    householdId: HOUSEHOLD_ID,
    current: "current",
  });
  // Recipient email rows: each is owned by exactly one entity (Donor XOR
  // at the email level). Org-level email, person email for the individual
  // donor, and person email for the household member.
  await db.insert(schema.emails).values([
    { id: `${RUN}_email_org`, email: ORG_EMAIL, organizationId: ORG_ID },
    {
      id: `${RUN}_email_indiv`,
      email: INDIV_EMAIL,
      personId: PERSON_INDIV_ID,
    },
    {
      id: `${RUN}_email_hhmember`,
      email: HH_MEMBER_EMAIL,
      personId: PERSON_HH_MEMBER_ID,
    },
  ]);
  await db.insert(schema.emailMessages).values({
    id: MSG_ID,
    gmailMessageId: `gmail_${RUN}`,
    mailboxUserId: TEST_USER_ID,
    direction: "sent",
    sentAt: SENT_AT,
    subject: "Thank you for your generous gift!",
    hasAttachments: true,
  });

  await seedGift(GIFT_ORG_ID, { organizationId: ORG_ID });
  await seedGift(GIFT_INDIV_ID, {
    individualGiverPersonId: PERSON_INDIV_ID,
  });
  await seedGift(GIFT_HH_ID, { householdId: HOUSEHOLD_ID });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) {
    await db
      .delete(schema.emailProposals)
      .where(eqFn(schema.emailProposals.mailboxUserId, TEST_USER_ID));
    await db
      .delete(schema.giftsAndPayments)
      .where(likeFn(schema.giftsAndPayments.id, `${RUN}_gift_%`));
    await db
      .delete(schema.emailMessages)
      .where(eqFn(schema.emailMessages.id, MSG_ID));
    await db
      .delete(schema.emails)
      .where(likeFn(schema.emails.id, `${RUN}_email_%`));
    await db
      .delete(schema.peopleEntityRoles)
      .where(eqFn(schema.peopleEntityRoles.id, ROLE_ID));
    await db
      .delete(schema.households)
      .where(eqFn(schema.households.id, HOUSEHOLD_ID));
    await db
      .delete(schema.people)
      .where(likeFn(schema.people.id, `${RUN}_person_%`));
    await db
      .delete(schema.organizations)
      .where(eqFn(schema.organizations.id, ORG_ID));
    await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
  }
  if (prevSkipFlag === undefined) delete process.env.SKIP_INLINE_ACTION_PROPOSAL;
  else process.env.SKIP_INLINE_ACTION_PROPOSAL = prevSkipFlag;
}, 60_000);

describe.skipIf(!HAS_DB)("thank-you detector — all donor types", () => {
  it("detects + proposes for an ORGANIZATION donor gift", async () => {
    await runDetector(ORG_EMAIL);
    const props = await proposalsForGift(GIFT_ORG_ID);
    expect(props).toHaveLength(1);
    const p = props[0];
    expect(p.kind).toBe("thank_you_acknowledgment");
    expect(p.status).toBe("pending");
    expect(p.sourceMessageId).toBe(MSG_ID);
    expect(p.targetOrganizationId).toBe(ORG_ID);
    expect(p.targetPersonId).toBeNull();
  });

  it("detects + proposes for an INDIVIDUAL giver gift", async () => {
    await runDetector(INDIV_EMAIL);
    const props = await proposalsForGift(GIFT_INDIV_ID);
    expect(props).toHaveLength(1);
    const p = props[0];
    expect(p.kind).toBe("thank_you_acknowledgment");
    expect(p.targetPersonId).toBe(PERSON_INDIV_ID);
    expect(p.targetOrganizationId).toBeNull();
    expect(
      (p.payload as Record<string, unknown>).individualGiverPersonId,
    ).toBe(PERSON_INDIV_ID);
  });

  it("detects + proposes for a HOUSEHOLD donor gift (via member role)", async () => {
    await runDetector(HH_MEMBER_EMAIL);
    const props = await proposalsForGift(GIFT_HH_ID);
    expect(props).toHaveLength(1);
    const p = props[0];
    expect(p.kind).toBe("thank_you_acknowledgment");
    // Households have no proposal target column; the payload carries it.
    expect(p.targetOrganizationId).toBeNull();
    expect((p.payload as Record<string, unknown>).householdId).toBe(
      HOUSEHOLD_ID,
    );
  });

  it("emits NO proposal when a recipient resolves to no candidate gift", async () => {
    await runDetector(NO_CANDIDATE_EMAIL);
    const rows = await db
      .select()
      .from(schema.emailProposals)
      .where(
        andFn(
          eqFn(schema.emailProposals.mailboxUserId, TEST_USER_ID),
          eqFn(schema.emailProposals.subjectEmail, NO_CANDIDATE_EMAIL),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("emits NO proposal for a gift that already has a thank-you linked", async () => {
    // A second org gift, pre-stamped as already acknowledged.
    await seedGift(
      GIFT_LINKED_ID,
      { organizationId: ORG_ID },
      { thankYouEmailMessageId: MSG_ID },
    );
    await runDetector(ORG_EMAIL);
    const props = await proposalsForGift(GIFT_LINKED_ID);
    expect(props).toHaveLength(0);
  });

  it("accepting a proposal stamps the gift regardless of donor type", async () => {
    // Use the household proposal — the donor-agnostic accept path keys
    // purely off payload.giftId, so a non-org/-person donor still links.
    const [proposal] = await proposalsForGift(GIFT_HH_ID);
    expect(proposal).toBeTruthy();
    const res = await accept(proposal.id);
    expect(res.status).toBe(200);
    const gift = await readGift(GIFT_HH_ID);
    expect(gift.thankYouEmailMessageId).toBe(MSG_ID);
    expect(gift.thankYouSentAt).toBe(DATE_RECEIVED);
  });
});
