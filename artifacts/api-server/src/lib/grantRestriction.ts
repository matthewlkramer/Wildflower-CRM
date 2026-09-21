import { db } from "@workspace/db";
import {
  entities,
  entityCodingRules,
  grantTerms,
  grantTermSets,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export interface GrantRestrictionAllocation {
  regionalRestrictionType: string | null;
  otherRestrictionType: string | null;
  timeRestrictionType: string | null;
  entityId: string | null;
}

export interface GrantRestrictionPolicy {
  entityId: string;
  entityName?: string | null;
  forceRestricted: boolean;
  enabled: boolean;
}

export interface GrantRestrictionRollup {
  restricted: boolean | null;
  restrictionBasis: string[];
}

export interface AcceptedGrantRestriction {
  restrictionDimension: string | null;
  summary: string;
}

/**
 * One authority for the opportunity-level restriction summary. The summary is
 * never stored: it is derived from donor-restricted allocation axes plus the
 * active entity policy used by revenue coding (for fiscal-sponsee entities such
 * as Black Wildflowers Fund). WF board designations do not become GAAP donor
 * restrictions merely because they are internally designated.
 */
export function deriveGrantRestrictionRollup(
  allocations: GrantRestrictionAllocation[],
  policies: GrantRestrictionPolicy[],
  acceptedRestrictions: AcceptedGrantRestriction[] = [],
  restrictionReviewComplete = false,
): GrantRestrictionRollup {
  if (allocations.length === 0 && acceptedRestrictions.length === 0) {
    return {
      restricted: restrictionReviewComplete ? false : null,
      restrictionBasis: [],
    };
  }

  const basis = new Set<string>();
  const policyByEntity = new Map(
    policies
      .filter((p) => p.enabled && p.forceRestricted)
      .map((p) => [p.entityId, p] as const),
  );

  for (const allocation of allocations) {
    if (allocation.regionalRestrictionType === "donor_restricted") {
      basis.add("Donor-imposed geographic restriction");
    }
    if (allocation.otherRestrictionType === "donor_restricted") {
      basis.add("Donor-imposed purpose or recipient restriction");
    }
    if (allocation.timeRestrictionType === "donor_restricted") {
      basis.add("Donor-imposed time restriction");
    }
    if (allocation.entityId) {
      const policy = policyByEntity.get(allocation.entityId);
      if (policy) {
        basis.add(
          `Restricted to ${policy.entityName?.trim() || policy.entityId}`,
        );
      }
    }
  }

  for (const restriction of acceptedRestrictions) {
    basis.add(
      restriction.summary.trim() ||
        `Accepted ${restriction.restrictionDimension ?? "donor"} restriction`,
    );
  }

  if (basis.size > 0) {
    return { restricted: true, restrictionBasis: [...basis] };
  }
  const hasUnknownAxis = allocations.some(
    (allocation) =>
      allocation.regionalRestrictionType == null ||
      allocation.otherRestrictionType == null ||
      allocation.timeRestrictionType == null,
  );
  return {
    restricted: hasUnknownAxis && !restrictionReviewComplete ? null : false,
    restrictionBasis: [],
  };
}

export async function loadGrantRestrictionRollup(
  allocations: GrantRestrictionAllocation[],
  opportunityId?: string,
): Promise<GrantRestrictionRollup> {
  const entityIds = [
    ...new Set(
      allocations.map((allocation) => allocation.entityId).filter(Boolean),
    ),
  ] as string[];
  const [policies, acceptedRestrictions, activeSets] = await Promise.all([
    entityIds.length
      ? db
          .select({
            entityId: entityCodingRules.entityId,
            forceRestricted: entityCodingRules.forceRestricted,
            enabled: entityCodingRules.enabled,
            entityName: entities.name,
          })
          .from(entityCodingRules)
          .innerJoin(entities, eq(entities.id, entityCodingRules.entityId))
          .where(inArray(entityCodingRules.entityId, entityIds))
      : Promise.resolve([]),
    opportunityId
      ? db
          .select({
            restrictionDimension: grantTerms.restrictionDimension,
            summary: grantTerms.summary,
          })
          .from(grantTerms)
          .innerJoin(grantTermSets, eq(grantTermSets.id, grantTerms.termSetId))
          .where(
            and(
              eq(grantTermSets.opportunityId, opportunityId),
              eq(grantTermSets.status, "active"),
              eq(grantTerms.kind, "donor_restriction"),
            ),
          )
      : Promise.resolve([]),
    opportunityId
      ? db
          .select({ id: grantTermSets.id })
          .from(grantTermSets)
          .where(
            and(
              eq(grantTermSets.opportunityId, opportunityId),
              eq(grantTermSets.status, "active"),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);

  return deriveGrantRestrictionRollup(
    allocations,
    policies,
    acceptedRestrictions,
    activeSets.length > 0,
  );
}
