import { db } from "@workspace/db";
import {
  giftAllocations,
  pledgeAllocations,
  giftsAndPayments,
  opportunitiesAndPledges,
  organizations,
  regions,
  entityCodingRules,
  fundableProjects,
  tasks,
} from "@workspace/db/schema";
import { and, arrayContains, eq, inArray } from "drizzle-orm";
import { deriveGiftTypeExpr } from "./giftTypeDerived";
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
  otherRestrictionType?: string | null;
  timeRestrictionType?: string | null;
  entityId?: string | null;
  intendedUsage?: string | null;
  fundableProjectId?: string | null;
  regionIds?: string[] | null;
  // The donor's verbatim restriction language (drives restriction evidence).
  purposeVerbatim?: string | null;
  // The fundable project's configured Revenue Location (Location precedence).
  fundableProjectLocation?: string | null;
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
  // Revenue-type signals (grant letter / reporting requirement on file).
  hasGrantLetter: boolean;
  hasReportingRequirement: boolean;
}

/** Whether any reporting-deadline task links this opportunity. */
async function oppHasReportingRequirement(
  oppId: string | null | undefined,
): Promise<boolean> {
  if (!oppId) return false;
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, "reporting_deadline"),
        arrayContains(tasks.opportunityIds, [oppId]),
      ),
    )
    .limit(1);
  return !!row;
}

async function loadGiftDonor(giftId: string): Promise<ParentDonor | null> {
  const [row] = await db
    .select({
      organizationId: giftsAndPayments.organizationId,
      individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
      householdId: giftsAndPayments.householdId,
      type: deriveGiftTypeExpr(),
      loanOrGrant: giftsAndPayments.loanOrGrant,
      grantLetterUrl: giftsAndPayments.grantLetterUrl,
      opportunityId: giftsAndPayments.opportunityId,
      oppGrantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
    })
    .from(giftsAndPayments)
    .leftJoin(
      opportunitiesAndPledges,
      eq(opportunitiesAndPledges.id, giftsAndPayments.opportunityId),
    )
    .where(eq(giftsAndPayments.id, giftId));
  if (!row) return null;
  return {
    donorKind: donorKindOf(row),
    organizationId: row.organizationId ?? null,
    giftType: row.type,
    loanOrGrant: row.loanOrGrant ?? null,
    hasGrantLetter: !!(row.grantLetterUrl || row.oppGrantLetterUrl),
    hasReportingRequirement: await oppHasReportingRequirement(row.opportunityId),
  };
}

async function loadOppDonor(oppId: string): Promise<ParentDonor | null> {
  const [row] = await db
    .select({
      organizationId: opportunitiesAndPledges.organizationId,
      individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
      householdId: opportunitiesAndPledges.householdId,
      grantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
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
    hasGrantLetter: !!row.grantLetterUrl,
    hasReportingRequirement: await oppHasReportingRequirement(oppId),
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

/** Load a fundable project's configured Revenue Location code. */
async function fundableProjectLocationOf(
  projectId: string | null | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  const [row] = await db
    .select({ locationCode: fundableProjects.locationCode })
    .from(fundableProjects)
    .where(eq(fundableProjects.id, projectId));
  return row?.locationCode ?? null;
}

async function computeFromDonor(
  donor: ParentDonor | null,
  fields: AllocationCodingFields,
  rules: EntityCodingRule[],
): Promise<CodingResult> {
  const entityType = await orgEntityType(donor?.organizationId ?? null);
  const states = await regionStates(fields.regionIds);
  // Resolve the project location for the Location precedence when the caller
  // didn't pass one (preview-by-id callers pass only fundableProjectId).
  const projectLocation =
    fields.fundableProjectLocation ??
    (await fundableProjectLocationOf(fields.fundableProjectId));
  const input: CodingInput = {
    donorKind: donor?.donorKind ?? null,
    orgEntityType: entityType,
    regionalRestrictionType: fields.regionalRestrictionType ?? null,
    otherRestrictionType: fields.otherRestrictionType ?? null,
    timeRestrictionType: fields.timeRestrictionType ?? null,
    giftType: donor?.giftType ?? null,
    loanOrGrant: donor?.loanOrGrant ?? null,
    entityId: fields.entityId ?? null,
    intendedUsage: fields.intendedUsage ?? null,
    fundableProjectId: fields.fundableProjectId ?? null,
    fundableProjectLocation: projectLocation,
    regionStates: states,
    purposeVerbatim: fields.purposeVerbatim ?? null,
    hasGrantLetter: donor?.hasGrantLetter ?? false,
    hasReportingRequirement: donor?.hasReportingRequirement ?? false,
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
    otherRestrictionType: a.otherRestrictionType,
    timeRestrictionType: a.timeRestrictionType,
    entityId: a.entityId,
    intendedUsage: a.intendedUsage,
    fundableProjectId: a.fundableProjectId,
    regionIds: a.regionIds,
    purposeVerbatim: a.purposeVerbatim,
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
    purposeVerbatim: a.purposeVerbatim,
    regionalRestrictionType: a.regionalRestrictionType,
    otherRestrictionType: a.otherRestrictionType,
    timeRestrictionType: a.timeRestrictionType,
    entityId: a.entityId,
    intendedUsage: a.intendedUsage,
    fundableProjectId: a.fundableProjectId,
    regionIds: a.regionIds,
  });
}
