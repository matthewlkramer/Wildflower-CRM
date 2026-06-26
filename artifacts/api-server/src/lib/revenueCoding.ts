import { db } from "@workspace/db";
import {
  giftAllocations,
  pledgeAllocations,
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
  type CodingResult,
  type DonorKind,
  type EntityCodingRule,
} from "@workspace/api-zod";

/**
 * Revenue-coding derivation.
 *
 * The coding snapshot (Object Code / Location / Class / flags) is NO LONGER
 * persisted on allocation rows — it now lives on the QuickBooks payment record
 * (`staged_payments`). This module derives the coding ON DEMAND from an
 * allocation's scope so the CRM can show a live "coding instructions" preview
 * (the allocation editors + the per-allocation coding-preview endpoints).
 */

/** Restriction axes read off the allocation being coded. */
export interface AllocationCodingFields {
  regionalRestrictionType?: string | null;
  usageRestrictionType?: string | null;
  timeRestrictionType?: string | null;
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
): Promise<CodingResult> {
  const entityType = await orgEntityType(donor?.organizationId ?? null);
  const states = await regionStates(fields.regionIds);
  const input: CodingInput = {
    donorKind: donor?.donorKind ?? null,
    orgEntityType: entityType,
    regionalRestrictionType: fields.regionalRestrictionType ?? null,
    usageRestrictionType: fields.usageRestrictionType ?? null,
    timeRestrictionType: fields.timeRestrictionType ?? null,
    giftType: donor?.giftType ?? null,
    loanOrGrant: donor?.loanOrGrant ?? null,
    entityId: fields.entityId ?? null,
    intendedUsage: fields.intendedUsage ?? null,
    fundableProjectId: fields.fundableProjectId ?? null,
    regionStates: states,
  };
  return deriveRevenueCoding(input, rules);
}

/** Live coding preview for a GIFT allocation, derived from its scope. */
export async function deriveGiftAllocationCoding(
  giftId: string | null | undefined,
  fields: AllocationCodingFields,
  rules?: EntityCodingRule[],
): Promise<CodingResult> {
  const ruleSet = rules ?? (await loadEntityCodingRules());
  const donor = giftId ? await loadGiftDonor(giftId) : null;
  return computeFromDonor(donor, fields, ruleSet);
}

/** Live coding preview for a PLEDGE/OPPORTUNITY allocation, derived from scope. */
export async function derivePledgeAllocationCoding(
  pledgeOrOpportunityId: string | null | undefined,
  fields: AllocationCodingFields,
  rules?: EntityCodingRule[],
): Promise<CodingResult> {
  const ruleSet = rules ?? (await loadEntityCodingRules());
  const donor = pledgeOrOpportunityId ? await loadOppDonor(pledgeOrOpportunityId) : null;
  return computeFromDonor(donor, fields, ruleSet);
}

/**
 * On-demand coding preview for an existing GIFT allocation row (by id). Returns
 * null when the allocation doesn't exist.
 */
export async function giftAllocationCodingPreview(
  allocationId: string,
): Promise<CodingResult | null> {
  const [a] = await db.select().from(giftAllocations).where(eq(giftAllocations.id, allocationId));
  if (!a) return null;
  return deriveGiftAllocationCoding(a.giftId, {
    regionalRestrictionType: a.regionalRestrictionType,
    usageRestrictionType: a.usageRestrictionType,
    timeRestrictionType: a.timeRestrictionType,
    entityId: a.entityId,
    intendedUsage: a.intendedUsage,
    fundableProjectId: a.fundableProjectId,
    regionIds: a.regionIds,
  });
}

/**
 * On-demand coding preview for an existing PLEDGE/OPPORTUNITY allocation row (by
 * id). Returns null when the allocation doesn't exist.
 */
export async function pledgeAllocationCodingPreview(
  allocationId: string,
): Promise<CodingResult | null> {
  const [a] = await db
    .select()
    .from(pledgeAllocations)
    .where(eq(pledgeAllocations.id, allocationId));
  if (!a) return null;
  return derivePledgeAllocationCoding(a.pledgeOrOpportunityId, {
    regionalRestrictionType: a.regionalRestrictionType,
    usageRestrictionType: a.usageRestrictionType,
    timeRestrictionType: a.timeRestrictionType,
    entityId: a.entityId,
    intendedUsage: a.intendedUsage,
    fundableProjectId: a.fundableProjectId,
    regionIds: a.regionIds,
  });
}
