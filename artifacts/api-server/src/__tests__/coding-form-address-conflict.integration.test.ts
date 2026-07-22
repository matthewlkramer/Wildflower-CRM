import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrossCheck } from "../lib/codingForms";

/**
 * Coding-form donor-address cross-check.
 *
 * The address arm of crossChecksFor (lib/codingForms.ts) must:
 *   - surface an EXISTING address on the matched donor as a "conflict" that
 *     only ever creates an ADDITIONAL address (never edits the existing row);
 *   - report "new" when the donor has no address yet;
 *   - block with "no matched donor to attach the address to" when the row has
 *     no donor (donor XOR fields all null) but does carry address data;
 *   - be not-applicable when there is no usable address on the sheet row.
 *
 * Calls crossChecksFor directly with in-memory rows; the donor + address rows
 * live in the DB. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `codingaddrspec_${Date.now()}`;
const ORG_WITH_ADDR = `${RUN}_org_a`;
const ORG_NO_ADDR = `${RUN}_org_b`;
const ADDR_ID = `${RUN}_addr`;

type Db = typeof import("@workspace/db");
type CodingForms = typeof import("../lib/codingForms");
type RowSelect = CodingForms["crossChecksFor"] extends (
  row: infer R,
) => unknown
  ? R
  : never;

let db: Db["db"];
let dbMod: Db;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let crossChecksFor: CodingForms["crossChecksFor"];

function makeRow(partial: Record<string, unknown>): RowSelect {
  return {
    id: `${RUN}_row`,
    // Donor XOR fields (default: no donor).
    organizationId: null,
    individualGiverPersonId: null,
    householdId: null,
    // Match pointers (kept null so gift/opp arms stay inert).
    matchedGiftId: null,
    matchedOpportunityId: null,
    // Effective-value inputs.
    donorNameRaw: null,
    donorNameAddressRaw: null,
    addrStreet: null,
    addrCity: null,
    addrState: null,
    addrPostal: null,
    addrCountry: null,
    internalMemo: null,
    restrictionLanguage: null,
    additionalNotes: null,
    circleRaw: null,
    seriesTypeRaw: null,
    reportRequiredRaw: null,
    reportRequired: null,
    reportDueDate: null,
    aiInterpretation: null,
    decisions: {},
    overrides: {},
    ...partial,
  } as unknown as RowSelect;
}

function addressCheck(checks: CrossCheck[]): CrossCheck {
  const check = checks.find((c) => c.attribute === "address");
  expect(check, "address cross-check missing").toBeDefined();
  return check as CrossCheck;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const codingForms = await import("../lib/codingForms");
  db = dbMod.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  crossChecksFor = codingForms.crossChecksFor;

  await db.insert(dbMod.organizations).values([
    { id: ORG_WITH_ADDR, name: `Addr Org A ${RUN}` },
    { id: ORG_NO_ADDR, name: `Addr Org B ${RUN}` },
  ]);
  await db.insert(dbMod.addresses).values({
    id: ADDR_ID,
    organizationId: ORG_WITH_ADDR,
    street: "123 Old St",
    cityName: "Springfield",
    stateCode: "IL",
    postalCode: "62704",
  });
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db.delete(dbMod.addresses).where(eqFn(dbMod.addresses.id, ADDR_ID));
  await db
    .delete(dbMod.organizations)
    .where(inArrayFn(dbMod.organizations.id, [ORG_WITH_ADDR, ORG_NO_ADDR]));
}, 60_000);

describe.skipIf(!HAS_DB)("coding-form donor address cross-check", () => {
  it("existing donor address → conflict that creates an ADDITIONAL address, never an edit", async () => {
    const checks = await crossChecksFor(
      makeRow({
        organizationId: ORG_WITH_ADDR,
        donorNameAddressRaw: "Acme Org, 456 New Ave, Portland, OR 97201",
        addrStreet: "456 New Ave",
        addrCity: "Portland",
        addrState: "OR",
        addrPostal: "97201",
      }),
    );
    const check = addressCheck(checks);
    expect(check.applicable).toBe(true);
    expect(check.status).toBe("conflict");
    expect(check.targetId).toBe(ADDR_ID);
    // The existing address is surfaced for the human to compare…
    expect(check.crmValue).toBe("123 Old St, Springfield, IL 62704");
    // …and apply would only ever ADD a row, keeping the existing one.
    expect(check.willWriteTo).toContain("ADDITIONAL address");
    expect(check.willWriteTo).toContain("existing address is kept as-is");
    expect(check.willWrite).toContain('street line: "456 New Ave"');
    expect(check.blockedReason).toBeNull();
  }, 30_000);

  it("donor without an address → status 'new' creating a fresh address row", async () => {
    const checks = await crossChecksFor(
      makeRow({
        organizationId: ORG_NO_ADDR,
        donorNameAddressRaw: "789 First Rd, Boston, MA 02101",
        addrStreet: "789 First Rd",
        addrCity: "Boston",
        addrState: "MA",
        addrPostal: "02101",
      }),
    );
    const check = addressCheck(checks);
    expect(check.status).toBe("new");
    expect(check.targetId).toBeNull();
    expect(check.willWriteTo).toBe("creates a new address on the matched donor");
  }, 30_000);

  it("address data but NO matched donor → blocked, not actionable", async () => {
    const checks = await crossChecksFor(
      makeRow({
        donorNameAddressRaw: "1 Nowhere Ln",
        addrStreet: "1 Nowhere Ln",
      }),
    );
    const check = addressCheck(checks);
    expect(check.applicable).toBe(true);
    expect(check.status).toBe("na");
    expect(check.blockedReason).toBe(
      "no matched donor to attach the address to",
    );
    expect(check.willWrite).toBeNull();
    expect(check.willWriteTo).toBeNull();
  }, 30_000);

  it("no usable address on the row → not applicable", async () => {
    const checks = await crossChecksFor(
      makeRow({ organizationId: ORG_WITH_ADDR }),
    );
    const check = addressCheck(checks);
    expect(check.applicable).toBe(false);
    expect(check.status).toBe("na");
  }, 30_000);
});
