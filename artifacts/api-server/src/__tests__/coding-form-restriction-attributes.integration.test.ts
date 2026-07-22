import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Coding-form restriction attributes after the settled restriction model
 * (attribute-key rename, migration 0151):
 *
 *   - "restrictionDescription" (formerly stored key "purposeVerbatim") targets
 *     allocation.restriction_description.
 *   - "purposeVerbatim" is a NEW attribute that writes
 *     allocation.purpose_verbatim (verbatim source language), never
 *     restriction_description.
 *   - "otherRestriction" (formerly "usageRestriction") targets
 *     allocation.other_restriction_type.
 *   - "timeRestriction" is a NEW override-driven attribute targeting
 *     allocation.time_restriction_type: na without an override, defaults to
 *     donor_restricted when the override value isn't a valid axis value, and
 *     respects a valid override.
 *   - A row whose stored decisions still carry the OLD key "usageRestriction"
 *     (pre-migration state) is treated gracefully: the unknown key never
 *     becomes actionable, so apply reports nothing_to_apply.
 *
 * Calls crossChecksFor / applyRow directly against seeded DB rows.
 * Skips without a real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `cfr_restr_${Date.now()}`;
const ORG_ID = `${RUN}_org`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  codingFormRows: Db["codingFormRows"];
};
let eqFn: typeof import("drizzle-orm").eq;
let likeFn: typeof import("drizzle-orm").like;
let crossChecksFor: typeof import("../lib/codingForms").crossChecksFor;
let applyRow: typeof import("../lib/codingForms").applyRow;

let rowSeq = 0;

const RESTRICTION_TEXT = `Grants to schools only ${RUN}`;

async function seedGiftWithAllocation(tag: string): Promise<{
  giftId: string;
  allocationId: string;
}> {
  const giftId = `${RUN}_gift_${tag}`;
  const allocationId = `${RUN}_alloc_${tag}`;
  await db.insert(schema.giftsAndPayments).values({
    id: giftId,
    name: `${RUN} gift ${tag}`,
    organizationId: ORG_ID,
    amount: "100.00",
    dateReceived: "2099-01-15",
  });
  await db.insert(schema.giftAllocations).values({
    id: allocationId,
    giftId,
  });
  return { giftId, allocationId };
}

async function seedRow(
  tag: string,
  giftId: string,
  over: Partial<import("@workspace/db").NewCodingFormRow> = {},
) {
  const id = `${RUN}_row_${tag}`;
  await db.insert(schema.codingFormRows).values({
    id,
    source: "fy26",
    sourceRowIndex: 900000 + rowSeq++,
    rawData: {},
    donorNameRaw: `${RUN} donor`,
    restrictionLanguage: RESTRICTION_TEXT,
    organizationId: ORG_ID,
    matchedGiftId: giftId,
    matchMethod: "manual",
    matchConfirmedAt: new Date(),
    ...over,
  });
  const [row] = await db
    .select()
    .from(schema.codingFormRows)
    .where(eqFn(schema.codingFormRows.id, id));
  return row;
}

async function loadAllocation(allocationId: string) {
  const [a] = await db
    .select()
    .from(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.id, allocationId));
  return a;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const cf = await import("../lib/codingForms");
  db = dbMod.db;
  schema = {
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    codingFormRows: dbMod.codingFormRows,
  };
  eqFn = drizzle.eq;
  likeFn = drizzle.like;
  crossChecksFor = cf.crossChecksFor;
  applyRow = cf.applyRow;

  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `${RUN} Org` })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.codingFormRows)
    .where(likeFn(schema.codingFormRows.id, `${RUN}%`));
  await db
    .delete(schema.giftAllocations)
    .where(likeFn(schema.giftAllocations.id, `${RUN}%`));
  await db
    .delete(schema.giftsAndPayments)
    .where(likeFn(schema.giftsAndPayments.id, `${RUN}%`));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
});

describe.skipIf(!HAS_DB)("coding-form restriction attributes", () => {
  it("emits the four renamed/new restriction attributes and never the old keys", async () => {
    const { giftId } = await seedGiftWithAllocation("attrs");
    const row = await seedRow("attrs", giftId);
    const checks = await crossChecksFor(row);
    const attrs = checks.map((c) => c.attribute);
    expect(attrs).toContain("restrictionDescription");
    expect(attrs).toContain("purposeVerbatim");
    expect(attrs).toContain("otherRestriction");
    expect(attrs).toContain("timeRestriction");
    expect(attrs).not.toContain("usageRestriction");

    const byAttr = Object.fromEntries(checks.map((c) => [c.attribute, c]));
    expect(byAttr.restrictionDescription.label).toBe("Restriction description");
    expect(byAttr.purposeVerbatim.label).toBe("Purpose verbatim");
    expect(byAttr.otherRestriction.label).toBe("Other restriction");
    expect(byAttr.timeRestriction.label).toBe("Time restriction");

    // Restriction language present + empty allocation → both text fields "new";
    // other axis "new" (unrestricted → donor_restricted); time axis "na"
    // (override-driven, no override set).
    expect(byAttr.restrictionDescription.status).toBe("new");
    expect(byAttr.purposeVerbatim.status).toBe("new");
    expect(byAttr.otherRestriction.status).toBe("new");
    expect(byAttr.timeRestriction.status).toBe("na");
    expect(byAttr.timeRestriction.applicable).toBe(false);
  });

  it("restrictionDescription writes restriction_description; purposeVerbatim writes purpose_verbatim", async () => {
    const { giftId, allocationId } = await seedGiftWithAllocation("split");
    const row = await seedRow("split", giftId);

    // Apply ONLY purposeVerbatim → purpose_verbatim set, description untouched.
    const r1 = await applyRow(row, { purposeVerbatim: "apply" }, null, {
      purposeVerbatim: `"for the sole use of MN schools" ${RUN}`,
    });
    expect(r1.kind).toBe("applied");
    let alloc = await loadAllocation(allocationId);
    expect(alloc.purposeVerbatim).toBe(
      `"for the sole use of MN schools" ${RUN}`,
    );
    expect(alloc.restrictionDescription).toBeNull();

    // Apply ONLY restrictionDescription → description set from the sheet text,
    // verbatim untouched.
    const [row2] = await db
      .select()
      .from(schema.codingFormRows)
      .where(eqFn(schema.codingFormRows.id, row.id));
    const r2 = await applyRow(row2, { restrictionDescription: "apply" }, null);
    expect(r2.kind).toBe("applied");
    alloc = await loadAllocation(allocationId);
    expect(alloc.restrictionDescription).toBe(RESTRICTION_TEXT);
    expect(alloc.purposeVerbatim).toBe(
      `"for the sole use of MN schools" ${RUN}`,
    );
  });

  it("otherRestriction latches donor_restricted by default and respects the override", async () => {
    const { giftId, allocationId } = await seedGiftWithAllocation("other");
    const row = await seedRow("other", giftId);
    const r = await applyRow(row, { otherRestriction: "apply" }, null);
    expect(r.kind).toBe("applied");
    let alloc = await loadAllocation(allocationId);
    expect(alloc.otherRestrictionType).toBe("donor_restricted");

    // Fresh row/allocation with an "unrestricted" override from the start:
    // the override value is what gets written (status stays sheet-driven, so
    // an already-latched donor_restricted row is intentionally a no-op).
    const seeded = await seedGiftWithAllocation("other_ov");
    const rowOv = await seedRow("other_ov", seeded.giftId);
    const r2 = await applyRow(rowOv, { otherRestriction: "apply" }, null, {
      otherRestriction: "unrestricted",
    });
    expect(r2.kind).toBe("applied");
    alloc = await loadAllocation(seeded.allocationId);
    expect(alloc.otherRestrictionType).toBe("unrestricted");
  });

  it("timeRestriction defaults to donor_restricted and respects a valid override", async () => {
    const { giftId, allocationId } = await seedGiftWithAllocation("time");
    const row = await seedRow("time", giftId);

    // Invalid override text → defaults to donor_restricted.
    const r1 = await applyRow(row, { timeRestriction: "apply" }, null, {
      timeRestriction: "one year only",
    });
    expect(r1.kind).toBe("applied");
    let alloc = await loadAllocation(allocationId);
    expect(alloc.timeRestrictionType).toBe("donor_restricted");

    // Valid override → written as-is.
    const [row2] = await db
      .select()
      .from(schema.codingFormRows)
      .where(eqFn(schema.codingFormRows.id, row.id));
    const r2 = await applyRow(row2, { timeRestriction: "apply" }, null, {
      timeRestriction: "unrestricted",
    });
    expect(r2.kind).toBe("applied");
    alloc = await loadAllocation(allocationId);
    expect(alloc.timeRestrictionType).toBe("unrestricted");

    // Cross-check with the stored override present is applicable + same.
    const [row3] = await db
      .select()
      .from(schema.codingFormRows)
      .where(eqFn(schema.codingFormRows.id, row.id));
    const checks = await crossChecksFor(row3);
    const time = checks.find((c) => c.attribute === "timeRestriction")!;
    expect(time.applicable).toBe(true);
    expect(time.status).toBe("same");
  });

  it("a pre-migration row with the old 'usageRestriction' decision key is not actionable", async () => {
    const { giftId, allocationId } = await seedGiftWithAllocation("legacy");
    const row = await seedRow("legacy", giftId, {
      decisions: { usageRestriction: "apply" },
    });
    const r = await applyRow(
      row,
      (row.decisions ?? {}) as Record<string, "apply" | "skip">,
      null,
    );
    expect(r.kind).toBe("nothing_to_apply");
    const alloc = await loadAllocation(allocationId);
    expect(alloc.otherRestrictionType).toBe("unrestricted");
  });
});
