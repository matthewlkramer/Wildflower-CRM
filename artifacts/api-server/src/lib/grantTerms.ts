import { db } from "@workspace/db";
import {
  grantTermSets,
  grantTermOutcomeEvents,
  grantTerms,
  pledgeAllocations,
} from "@workspace/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function joined(values: Array<string | null | undefined>): string | null {
  const distinct = [
    ...new Set(values.map((value) => value?.trim()).filter(Boolean)),
  ] as string[];
  return distinct.length ? distinct.join("\n\n") : null;
}

/**
 * Apply one accepted interpretation to canonical pledge-allocation fields.
 * This is always called inside the transaction that activates the term set.
 * Existing WF board-designated axes are preserved; donor axes are replaced by
 * the newly accepted document interpretation.
 */
export async function applyGrantTermSetToAllocations(
  tx: DbTransaction,
  opportunityId: string,
  termSetId: string,
  onlyAllocationIds?: string[],
): Promise<void> {
  const allocationWhere = onlyAllocationIds?.length
    ? and(
        eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId),
        inArray(pledgeAllocations.id, onlyAllocationIds),
      )
    : eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId);
  const [allocations, terms] = await Promise.all([
    tx.select().from(pledgeAllocations).where(allocationWhere),
    tx.select().from(grantTerms).where(eq(grantTerms.termSetId, termSetId)),
  ]);

  for (const allocation of allocations) {
    const applicable = terms.filter(
      (term) =>
        term.pledgeAllocationId == null ||
        term.pledgeAllocationId === allocation.id,
    );
    const restrictions = applicable.filter(
      (term) => term.kind === "donor_restriction",
    );
    const conditions = applicable.filter((term) => term.kind === "condition");
    const hasDimension = (dimension: string) =>
      restrictions.some((term) => term.restrictionDimension === dimension);

    const regionalRestrictionType =
      allocation.regionalRestrictionType === "wf_restricted"
        ? "wf_restricted"
        : hasDimension("geography")
          ? "donor_restricted"
          : "unrestricted";
    const timeRestrictionType =
      allocation.timeRestrictionType === "wf_restricted"
        ? "wf_restricted"
        : hasDimension("time")
          ? "donor_restricted"
          : "unrestricted";
    const otherRestrictionType =
      allocation.otherRestrictionType === "wf_restricted"
        ? "wf_restricted"
        : restrictions.some(
              (term) =>
                term.restrictionDimension !== "geography" &&
                term.restrictionDimension !== "time",
            )
          ? "donor_restricted"
          : "unrestricted";

    await tx
      .update(pledgeAllocations)
      .set({
        regionalRestrictionType,
        otherRestrictionType,
        timeRestrictionType,
        purposeVerbatim: joined(restrictions.map((term) => term.exactQuote)),
        restrictionDescription: joined(
          restrictions.map((term) => term.summary),
        ),
        conditional:
          conditions.length > 0 ? "conditional_unspecified" : "unconditional",
        conditions: joined(
          conditions.map((term) =>
            [
              term.summary,
              term.exactQuote ? `Evidence: “${term.exactQuote}”` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        ),
        conditionsMet: conditions.length > 0 ? "no" : "yes",
        updatedAt: new Date(),
      })
      .where(eq(pledgeAllocations.id, allocation.id));
  }
}

/** Apply the current active interpretation to newly added allocation rows. */
export async function applyActiveGrantTermsToAllocations(
  tx: DbTransaction,
  opportunityId: string,
  allocationIds: string[],
): Promise<void> {
  if (allocationIds.length === 0) return;
  const [active] = await tx
    .select()
    .from(grantTermSets)
    .where(
      and(
        eq(grantTermSets.opportunityId, opportunityId),
        eq(grantTermSets.status, "active"),
      ),
    )
    .limit(1);
  if (!active) return;
  await applyGrantTermSetToAllocations(
    tx,
    opportunityId,
    active.id,
    allocationIds,
  );
}

/**
 * Recompute allocation.conditionsMet from the latest append-only outcomes for
 * every active formal condition. No event means pending. A waived condition is
 * satisfied for rollup purposes; missed and reopened conditions are not met.
 */
export async function refreshGrantConditionOutcomes(
  tx: DbTransaction,
  opportunityId: string,
  termSetId: string,
): Promise<void> {
  const [allocations, conditions] = await Promise.all([
    tx
      .select()
      .from(pledgeAllocations)
      .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId)),
    tx
      .select()
      .from(grantTerms)
      .where(
        and(
          eq(grantTerms.termSetId, termSetId),
          eq(grantTerms.kind, "condition"),
        ),
      ),
  ]);
  const conditionIds = conditions.map((condition) => condition.id);
  const outcomes = conditionIds.length
    ? await tx
        .select()
        .from(grantTermOutcomeEvents)
        .where(inArray(grantTermOutcomeEvents.grantTermId, conditionIds))
        .orderBy(desc(grantTermOutcomeEvents.createdAt))
    : [];
  const latestByTerm = new Map<string, (typeof outcomes)[number]>();
  for (const outcome of outcomes) {
    if (!latestByTerm.has(outcome.grantTermId)) {
      latestByTerm.set(outcome.grantTermId, outcome);
    }
  }

  for (const allocation of allocations) {
    const applicable = conditions.filter(
      (condition) =>
        condition.pledgeAllocationId == null ||
        condition.pledgeAllocationId === allocation.id,
    );
    const metCount = applicable.filter((condition) => {
      const outcome = latestByTerm.get(condition.id)?.outcome;
      return outcome === "satisfied" || outcome === "waived";
    }).length;
    const conditionsMet =
      applicable.length === 0 || metCount === applicable.length
        ? "yes"
        : metCount > 0
          ? "partial"
          : "no";
    await tx
      .update(pledgeAllocations)
      .set({ conditionsMet, updatedAt: new Date() })
      .where(eq(pledgeAllocations.id, allocation.id));
  }
}
