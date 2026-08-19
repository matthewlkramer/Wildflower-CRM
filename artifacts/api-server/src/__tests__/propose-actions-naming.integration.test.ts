import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Email-intelligence review UI naming enrichment.
 *
 * The reviewer-facing proposal cards must name the real target instead of the
 * bare word "person"/"organization". Three enrichers in lib/proposeActions.ts
 * own that:
 *   - enrichCreatePerEntityNames: create_per → entityName of the target org;
 *   - enrichPersonActionNames: set_phone / add_email / set_primary_email →
 *     personName, or organizationName when the referenced email row is
 *     org-owned (email-owner XOR);
 *   - enrichRoleActionLabels: deactivate_per / update_per_title → the role's
 *     current title + the entity it's at.
 * Unresolvable ids must leave the action untouched (no crash, no fake name).
 *
 * Calls the enrichers directly against the DB. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `proposenamespec_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ORG_NAME = `Acme Philanthropies ${RUN}`;
const BOARD_ORG_ID = `${RUN}_college_board`;
const BOARD_ORG_NAME = `College Board ${RUN}`;
const HISTORY_ORG_ID = `${RUN}_historical_org`;
const HISTORY_ORG_NAME = `Renamed Sponsor ${RUN}`;
const HISTORY_NAME = `College Board Legacy ${RUN}`;
const CLOSE_ORG_ID = `${RUN}_close_org`;
const CLOSE_ORG_NAME = `College Board Spring Foundation ${RUN}`;
const ACCENT_ORG_ID = `${RUN}_accent_org`;
const ACCENT_ORG_NAME = `Café Foundation ${RUN}`;
const AMBIGUOUS_ORG_NAME = `Ambiguous College Board ${RUN}`;
const AMBIGUOUS_ORG_IDS = Array.from(
  { length: 26 },
  (_, index) => `${RUN}_ambiguous_org_${index}`,
);
const PERSON_ID = `${RUN}_person`;
const PER_ID = `${RUN}_per`;
const EMAIL_PERSON_ID = `${RUN}_email_person`;
const EMAIL_ORG_ID = `${RUN}_email_org`;

type Db = typeof import("@workspace/db");
type Propose = typeof import("../lib/proposeActions");
type Apply = typeof import("../lib/applyProposalActions");

let db: Db["db"];
let dbMod: Db;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let propose: Propose;
let apply: Apply;

beforeAll(async () => {
  if (!HAS_DB) return;
  dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  propose = await import("../lib/proposeActions");
  apply = await import("../lib/applyProposalActions");
  db = dbMod.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db
    .insert(dbMod.organizations)
    .values([
      { id: ORG_ID, name: ORG_NAME },
      { id: BOARD_ORG_ID, name: BOARD_ORG_NAME },
      {
        id: HISTORY_ORG_ID,
        name: HISTORY_ORG_NAME,
        historicalNames: [HISTORY_NAME],
      },
      { id: CLOSE_ORG_ID, name: CLOSE_ORG_NAME },
      { id: ACCENT_ORG_ID, name: ACCENT_ORG_NAME },
      ...AMBIGUOUS_ORG_IDS.map((id) => ({
        id,
        name: `The ${AMBIGUOUS_ORG_NAME}`,
      })),
    ]);
  await db.insert(dbMod.people).values({
    id: PERSON_ID,
    firstName: "Priya",
    lastName: "Reviewer",
    fullName: "Priya Reviewer",
  });
  await db.insert(dbMod.peopleEntityRoles).values({
    id: PER_ID,
    personId: PERSON_ID,
    entityType: "organization",
    organizationId: ORG_ID,
    externalTitleOrRole: "Program Officer",
  });
  await db.insert(dbMod.emails).values([
    { id: EMAIL_PERSON_ID, email: `priya.${RUN}@example.com`, personId: PERSON_ID },
    { id: EMAIL_ORG_ID, email: `info.${RUN}@example.com`, organizationId: ORG_ID },
  ]);
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(dbMod.emails)
    .where(inArrayFn(dbMod.emails.id, [EMAIL_PERSON_ID, EMAIL_ORG_ID]));
  await db
    .delete(dbMod.peopleEntityRoles)
    .where(eqFn(dbMod.peopleEntityRoles.personId, PERSON_ID));
  await db.delete(dbMod.people).where(eqFn(dbMod.people.id, PERSON_ID));
  await db
    .delete(dbMod.organizations)
    .where(
      inArrayFn(dbMod.organizations.id, [
        ORG_ID,
        BOARD_ORG_ID,
        HISTORY_ORG_ID,
        CLOSE_ORG_ID,
        ACCENT_ORG_ID,
        ...AMBIGUOUS_ORG_IDS,
      ]),
    );
}, 60_000);

describe.skipIf(!HAS_DB)("proposal naming enrichment", () => {
  it("create_per is labeled with the target entity's name", async () => {
    const actions = [
      {
        type: "create_per" as const,
        personId: PERSON_ID,
        organizationId: ORG_ID,
        reason: "test",
      },
      {
        type: "create_per" as const,
        personId: PERSON_ID,
        organizationId: `${RUN}_missing_org`,
        reason: "test",
      },
    ];
    const enriched = (await propose.enrichCreatePerEntityNames(
      actions as never,
    )) as Array<{ entityName?: string | null }>;
    expect(enriched[0].entityName).toBe(ORG_NAME);
    // Unresolvable org → no fabricated name.
    expect(enriched[1].entityName ?? null).toBeNull();
  }, 30_000);

  it("set_phone / set_primary_email name the person, or the org for org-owned emails", async () => {
    const actions = [
      {
        type: "set_phone" as const,
        personId: PERSON_ID,
        phoneNumber: "+15555550100",
        reason: "test",
      },
      {
        type: "set_primary_email" as const,
        emailId: EMAIL_PERSON_ID,
        reason: "test",
      },
      {
        type: "set_primary_email" as const,
        emailId: EMAIL_ORG_ID,
        reason: "test",
      },
      {
        type: "set_phone" as const,
        personId: `${RUN}_missing_person`,
        phoneNumber: "+15555550101",
        reason: "test",
      },
    ];
    const enriched = (await propose.enrichPersonActionNames(
      actions as never,
    )) as Array<{ personName?: string | null; organizationName?: string | null }>;
    expect(enriched[0].personName).toBe("Priya Reviewer");
    expect(enriched[1].personName).toBe("Priya Reviewer");
    // Org-owned email → the ORG is named, not a person (email-owner XOR).
    expect(enriched[2].organizationName).toBe(ORG_NAME);
    expect(enriched[2].personName ?? null).toBeNull();
    // Unresolvable person → untouched, no fake name.
    expect(enriched[3].personName ?? null).toBeNull();
  }, 30_000);

  it("deactivate_per / update_per_title carry the role's title and entity name", async () => {
    const actions = [
      { type: "deactivate_per" as const, perId: PER_ID, reason: "test" },
      {
        type: "update_per_title" as const,
        perId: PER_ID,
        externalTitleOrRole: "Senior Program Officer",
        reason: "test",
      },
      {
        type: "deactivate_per" as const,
        perId: `${RUN}_missing_per`,
        reason: "test",
      },
    ];
    const enriched = (await propose.enrichRoleActionLabels(
      actions as never,
    )) as Array<{ roleTitle?: string | null; roleEntityName?: string | null }>;
    expect(enriched[0].roleTitle).toBe("Program Officer");
    expect(enriched[0].roleEntityName).toBe(ORG_NAME);
    expect(enriched[1].roleTitle).toBe("Program Officer");
    expect(enriched[1].roleEntityName).toBe(ORG_NAME);
    // Unresolvable role → labels absent.
    expect(enriched[2].roleTitle ?? null).toBeNull();
    expect(enriched[2].roleEntityName ?? null).toBeNull();
  }, 30_000);

  it("rewrites a leading-article organization create to the existing CRM organization", async () => {
    const reconciled = await propose.reconcileCreateOrgWithPer([
      {
        type: "create_org_with_per",
        personId: PERSON_ID,
        organizationName: `The ${BOARD_ORG_NAME}`,
        reason: "Massie changed employers",
      },
    ]);
    expect(reconciled).toEqual([
      expect.objectContaining({
        type: "create_per",
        personId: PERSON_ID,
        organizationId: BOARD_ORG_ID,
      }),
    ]);
  }, 30_000);

  it("also finds a conservatively equivalent historical organization name", async () => {
    const reconciled = await propose.reconcileCreateOrgWithPer([
      {
        type: "create_funder_with_per",
        personId: PERSON_ID,
        funderName: `The ${HISTORY_NAME}`,
        reason: "Employer renamed",
      },
    ]);
    expect(reconciled).toEqual([
      expect.objectContaining({
        type: "create_per",
        organizationId: HISTORY_ORG_ID,
      }),
    ]);
  }, 30_000);

  it("matches diacritic-only variants without requiring a database extension", async () => {
    const reconciled = await propose.reconcileCreateOrgWithPer([
      {
        type: "create_org_with_per",
        personId: PERSON_ID,
        organizationName: `Cafe Foundation ${RUN}`,
        reason: "Accent-insensitive name",
      },
    ]);
    expect(reconciled).toEqual([
      expect.objectContaining({
        type: "create_per",
        organizationId: ACCENT_ORG_ID,
      }),
    ]);
  }, 30_000);

  it("does not rewrite a close but distinct organization name", async () => {
    const proposedName = `College Board Spring ${RUN}`;
    const reconciled = await propose.reconcileCreateOrgWithPer([
      {
        type: "create_org_with_per",
        personId: PERSON_ID,
        organizationName: proposedName,
        reason: "Not the foundation",
      },
    ]);
    expect(reconciled).toEqual([
      expect.objectContaining({
        type: "create_org_with_per",
        organizationName: proposedName,
      }),
    ]);
  }, 30_000);

  it("does not choose an arbitrary organization when many names normalize equally", async () => {
    const reconciled = await propose.reconcileCreateOrgWithPer([
      {
        type: "create_org_with_per",
        personId: PERSON_ID,
        organizationName: AMBIGUOUS_ORG_NAME,
        reason: "Ambiguous names need review",
      },
    ]);
    expect(reconciled).toEqual([
      expect.objectContaining({
        type: "create_org_with_per",
        organizationName: AMBIGUOUS_ORG_NAME,
      }),
    ]);
  }, 30_000);

  it("rechecks an older create action at acceptance and reuses the existing organization", async () => {
    const result = await apply.applyAction(
      db,
      {
        type: "create_org_with_per",
        personId: PERSON_ID,
        organizationName: `The ${BOARD_ORG_NAME}`,
        reason: "Delayed reviewer acceptance",
      },
      { mailboxUserId: `${RUN}_mailbox` },
    );
    expect(result.status).toBe("applied");
    expect(result.createdId).toBe(BOARD_ORG_ID);
    const createdDuplicates = await db
      .select({ id: dbMod.organizations.id })
      .from(dbMod.organizations)
      .where(eqFn(dbMod.organizations.name, `The ${BOARD_ORG_NAME}`));
    expect(createdDuplicates).toHaveLength(0);
  }, 30_000);

  it("uses the same accent-insensitive guard when accepting an older action", async () => {
    const result = await apply.applyAction(
      db,
      {
        type: "create_funder_with_per",
        personId: PERSON_ID,
        funderName: `Cafe Foundation ${RUN}`,
        reason: "Delayed accent-insensitive acceptance",
      },
      { mailboxUserId: `${RUN}_mailbox` },
    );
    expect(result.status).toBe("applied");
    expect(result.createdId).toBe(ACCENT_ORG_ID);
  }, 30_000);
});
