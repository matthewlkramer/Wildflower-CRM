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
const PERSON_ID = `${RUN}_person`;
const PER_ID = `${RUN}_per`;
const EMAIL_PERSON_ID = `${RUN}_email_person`;
const EMAIL_ORG_ID = `${RUN}_email_org`;

type Db = typeof import("@workspace/db");
type Propose = typeof import("../lib/proposeActions");

let db: Db["db"];
let dbMod: Db;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let propose: Propose;

beforeAll(async () => {
  if (!HAS_DB) return;
  dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  propose = await import("../lib/proposeActions");
  db = dbMod.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db
    .insert(dbMod.organizations)
    .values({ id: ORG_ID, name: ORG_NAME });
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
    .where(eqFn(dbMod.peopleEntityRoles.id, PER_ID));
  await db.delete(dbMod.people).where(eqFn(dbMod.people.id, PERSON_ID));
  await db
    .delete(dbMod.organizations)
    .where(eqFn(dbMod.organizations.id, ORG_ID));
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
});
