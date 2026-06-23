import { db } from "@workspace/db";
import {
  giftsAndPayments,
  opportunitiesAndPledges,
  organizations,
  regions,
  entityCodingRules,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  deriveRevenueCoding,
  type CodingInput,
  type DonorKind,
  type EntityCodingRule,
} from "@workspace/api-zod";

/** Snapshot columns written onto an allocation row. */
export interface CodingSnapshot {
  objectCode: string | null;
  revenueLocation: string | null;
  revenueClass: string | null;
  codingFlags: string[];
}

/** Fields read off the allocation being written. */
export interface AllocationCodingFields {
  restrictionType?: string | null;
  entityId?: string | null;
  intendedUsage?: string | null;
  fundableProjectId?: string | null;
  regionIds?: string[] | null;
}

/** Load the live (enabled) entity coding rules from the DB. */
export async function loadEntityCodingRules(): Promise<EntityCodingRule[]> {
  const rows = await db.select().from(entityCodingRules);
  return rows.map((r) => ({
    entityId: r.entityId,
    forceRestricted: r.forceRestricted,
    location: (r.location ?? null) as EntityCodingRule["location"],
    revenueClass: r.revenueClass ?? null,
    enabled: r.enabled,
    notes: r.notes ?? null,
  }));
}

interface ParentDonor {
  donorKind: DonorKind | null;
  organizationId: string | null;
  giftType: string | null;
  loanOrGrant: string | null;
}

async function loadGiftDonor(giftId: string): Promise<ParentDonor | null> {
  const [row] = await db
    .select({
      organizationId: giftsAndPayments.organizationId,
      individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
      householdId: giftsAndPayments.householdId,
      type: giftsAndPayments.type,
      loanOrGrant: giftsAndPayments.loanOrGrant,
    })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, giftId));
  if (!row) return null;
  return {
    donorKind: donorKindOf(row),
    organizationId: row.organizationId ?? null,
    giftType: row.type ?? null,
    loanOrGrant: row.loanOrGrant ?? null,
  };
}

async function loadOppDonor(oppId: string): Promise<ParentDonor | null> {
  const [row] = await db
    .select({
      organizationId: opportunitiesAndPledges.organizationId,
      individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
      householdId: opportunitiesAndPledges.householdId,
    })
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, oppId));
  if (!row) return null;
  return {
    donorKind: donorKindOf(row),
    organizationId: row.organizationId ?? null,
    giftType: null,
    // Opportunity/pledge allocations were never coded as loans via this path
    // (gifts only). Keep that behavior — pass null so isLoan stays false.
    loanOrGrant: null,
  };
}

function donorKindOf(row: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): DonorKind | null {
  if (row.organizationId) return "organization";
  if (row.householdId) return "household";
  if (row.individualGiverPersonId) return "individual";
  return null;
}

async function orgEntityType(organizationId: string | null): Promise<string | null> {
  if (!organizationId) return null;
  const [row] = await db
    .select({ entityType: organizations.entityType })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.entityType ?? null;
}

async function regionStates(regionIds: string[] | null | undefined): Promise<(string | null)[]> {
  if (!regionIds || regionIds.length === 0) return [];
  const rows = await db
    .select({ state: regions.stateAbbreviation })
    .from(regions)
    .where(inArray(regions.id, regionIds));
  return rows.map((r) => r.state ?? null);
}

async function computeFromDonor(
  donor: ParentDonor | null,
  fields: AllocationCodingFields,
  rules: EntityCodingRule[],
): Promise<CodingSnapshot> {
  const entityType = await orgEntityType(donor?.organizationId ?? null);
  const states = await regionStates(fields.regionIds);
  const input: CodingInput = {
    donorKind: donor?.donorKind ?? null,
    orgEntityType: entityType,
    restrictionType: (fields.restrictionType ?? null) as CodingInput["restrictionType"],
    giftType: donor?.giftType ?? null,
    loanOrGrant: donor?.loanOrGrant ?? null,
    entityId: fields.entityId ?? null,
    intendedUsage: fields.intendedUsage ?? null,
    fundableProjectId: fields.fundableProjectId ?? null,
    regionStates: states,
  };
  const result = deriveRevenueCoding(input, rules);
  return {
    objectCode: result.objectCode,
    revenueLocation: result.location,
    revenueClass: result.revenueClass,
    codingFlags: result.flags,
  };
}

/** Derive the coding snapshot for a GIFT allocation. */
export async function deriveGiftAllocationCoding(
  giftId: string | null | undefined,
  fields: AllocationCodingFields,
  rules?: EntityCodingRule[],
): Promise<CodingSnapshot> {
  const ruleSet = rules ?? (await loadEntityCodingRules());
  const donor = giftId ? await loadGiftDonor(giftId) : null;
  return computeFromDonor(donor, fields, ruleSet);
}

/** Derive the coding snapshot for a PLEDGE/OPPORTUNITY allocation. */
export async function derivePledgeAllocationCoding(
  pledgeOrOpportunityId: string | null | undefined,
  fields: AllocationCodingFields,
  rules?: EntityCodingRule[],
): Promise<CodingSnapshot> {
  const ruleSet = rules ?? (await loadEntityCodingRules());
  const donor = pledgeOrOpportunityId ? await loadOppDonor(pledgeOrOpportunityId) : null;
  return computeFromDonor(donor, fields, ruleSet);
}

/** Re-derive coding for ALL allocations under a gift (donor change). */
export async function rederiveGiftAllocations(giftId: string): Promise<void> {
  const rules = await loadEntityCodingRules();
  const { giftAllocations } = await import("@workspace/db/schema");
  const allocs = await db.select().from(giftAllocations).where(eq(giftAllocations.giftId, giftId));
  for (const a of allocs) {
    const snap = await deriveGiftAllocationCoding(
      giftId,
      {
        restrictionType: a.restrictionType,
        entityId: a.entityId,
        intendedUsage: a.intendedUsage,
        fundableProjectId: a.fundableProjectId,
        regionIds: a.regionIds,
      },
      rules,
    );
    await db
      .update(giftAllocations)
      .set({
        objectCode: snap.objectCode,
        revenueLocation: snap.revenueLocation,
        revenueClass: snap.revenueClass,
        codingFlags: snap.codingFlags,
        updatedAt: new Date(),
      })
      .where(eq(giftAllocations.id, a.id));
  }
}

/** Re-derive coding for ALL allocations under an opportunity/pledge (donor change). */
export async function rederivePledgeAllocations(pledgeOrOpportunityId: string): Promise<void> {
  const rules = await loadEntityCodingRules();
  const { pledgeAllocations } = await import("@workspace/db/schema");
  const allocs = await db
    .select()
    .from(pledgeAllocations)
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, pledgeOrOpportunityId));
  for (const a of allocs) {
    const snap = await derivePledgeAllocationCoding(
      pledgeOrOpportunityId,
      {
        restrictionType: a.restrictionType,
        entityId: a.entityId,
        intendedUsage: a.intendedUsage,
        fundableProjectId: a.fundableProjectId,
        regionIds: a.regionIds,
      },
      rules,
    );
    await db
      .update(pledgeAllocations)
      .set({
        objectCode: snap.objectCode,
        revenueLocation: snap.revenueLocation,
        revenueClass: snap.revenueClass,
        codingFlags: snap.codingFlags,
        updatedAt: new Date(),
      })
      .where(eq(pledgeAllocations.id, a.id));
  }
}
