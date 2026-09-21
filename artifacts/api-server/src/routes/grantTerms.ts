import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import {
  grantSpendSnapshots,
  grantTermOutcomeEvents,
  grantTerms,
  grantTermSets,
  opportunitiesAndPledges,
  pledgeAllocations,
  pledgeExpectedPayments,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  AnalyzeGrantAgreementBody,
  CreateManualGrantTermSetBody,
  RecordGrantSpendSnapshotBody,
  RecordGrantTermOutcomeBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { ObjectStorageService } from "../lib/objectStorage";
import { analyzeGrantAgreementFile } from "../lib/grantAgreementAnalysis";
import {
  applyGrantTermSetToAllocations,
  refreshGrantConditionOutcomes,
} from "../lib/grantTerms";
import { applyDerivedOppFields } from "../lib/pledgeStage";
import { loadGrantRestrictionRollup } from "../lib/grantRestriction";
import { todayInChicago } from "../lib/governingFiscalYear";

const router: IRouter = Router();
router.use(requireAuth);

type TermInput = ReturnType<
  typeof CreateManualGrantTermSetBody.parse
>["terms"][number];

function requireWriteAccess(
  req: Parameters<typeof getAppUser>[0],
  res: Response,
) {
  const user = getAppUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  if (user.role === "read_only") {
    res.status(403).json({ error: "write_permission_required" });
    return null;
  }
  return user;
}

function validateTermSemantics(terms: TermInput[]): string | null {
  for (const [index, term] of terms.entries()) {
    if (term.kind === "donor_restriction" && !term.restrictionDimension) {
      return `Term ${index + 1}: donor restrictions need a restriction dimension.`;
    }
    if (
      term.kind === "condition" &&
      (!term.barrier?.trim() || !term.returnOrReleaseRight?.trim())
    ) {
      return `Term ${index + 1}: a formal condition needs both a substantive barrier and a donor right of return or release.`;
    }
    if (term.kind === "spending_rule" && !term.spendingRuleType) {
      return `Term ${index + 1}: spending rules need a rule type.`;
    }
  }
  return null;
}

async function validateTermScope(
  opportunityId: string,
  terms: TermInput[],
): Promise<string | null> {
  const allocationIds = [
    ...new Set(terms.map((term) => term.pledgeAllocationId).filter(Boolean)),
  ] as string[];
  const paymentIds = [
    ...new Set(terms.map((term) => term.expectedPaymentId).filter(Boolean)),
  ] as string[];

  if (allocationIds.length) {
    const rows = await db
      .select({ id: pledgeAllocations.id })
      .from(pledgeAllocations)
      .where(
        and(
          inArray(pledgeAllocations.id, allocationIds),
          eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId),
        ),
      );
    if (rows.length !== allocationIds.length) {
      return "Every selected allocation must belong to this opportunity.";
    }
  }
  if (paymentIds.length) {
    const rows = await db
      .select({ id: pledgeExpectedPayments.id })
      .from(pledgeExpectedPayments)
      .where(
        and(
          inArray(pledgeExpectedPayments.id, paymentIds),
          eq(pledgeExpectedPayments.pledgeOrOpportunityId, opportunityId),
        ),
      );
    if (rows.length !== paymentIds.length) {
      return "Every selected expected payment must belong to this opportunity.";
    }
  }
  return null;
}

function termInsertValues(termSetId: string, terms: TermInput[]) {
  return terms.map((term, index) => ({
    id: newId(),
    termSetId,
    pledgeAllocationId: term.pledgeAllocationId ?? null,
    expectedPaymentId: term.expectedPaymentId ?? null,
    kind: term.kind,
    restrictionDimension: term.restrictionDimension ?? null,
    spendingRuleType: term.spendingRuleType ?? null,
    title: term.title.trim(),
    summary: term.summary.trim(),
    exactQuote: term.exactQuote?.trim() || null,
    sourcePage: term.sourcePage?.trim() || null,
    amount: term.amount ?? null,
    startDate: term.startDate ?? null,
    endDate: term.endDate ?? null,
    dueDate: term.dueDate ?? null,
    barrier: term.barrier?.trim() || null,
    returnOrReleaseRight: term.returnOrReleaseRight?.trim() || null,
    consequence: term.consequence?.trim() || null,
    categories:
      term.categories?.map((category) => category.trim()).filter(Boolean) ??
      null,
    capAmount: term.capAmount ?? null,
    capPercent: term.capPercent ?? null,
    sortOrder: String(index),
  }));
}

async function opportunityExists(id: string) {
  return db
    .select({ id: opportunitiesAndPledges.id })
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, id))
    .then((rows) => !!rows[0]);
}

async function loadTermSets(opportunityId: string) {
  const sets = await db
    .select()
    .from(grantTermSets)
    .where(eq(grantTermSets.opportunityId, opportunityId))
    .orderBy(desc(grantTermSets.createdAt));
  const setIds = sets.map((set) => set.id);
  const terms = setIds.length
    ? await db
        .select()
        .from(grantTerms)
        .where(inArray(grantTerms.termSetId, setIds))
        .orderBy(asc(grantTerms.sortOrder), asc(grantTerms.createdAt))
    : [];
  const termIds = terms.map((term) => term.id);
  const outcomes = termIds.length
    ? await db
        .select()
        .from(grantTermOutcomeEvents)
        .where(inArray(grantTermOutcomeEvents.grantTermId, termIds))
        .orderBy(desc(grantTermOutcomeEvents.createdAt))
    : [];
  const latestOutcome = new Map<string, (typeof outcomes)[number]>();
  for (const outcome of outcomes) {
    if (!latestOutcome.has(outcome.grantTermId)) {
      latestOutcome.set(outcome.grantTermId, outcome);
    }
  }
  const today = todayInChicago();
  const termsBySet = new Map<string, unknown[]>();
  for (const term of terms) {
    const latest = latestOutcome.get(term.id);
    const currentOutcome =
      !latest || latest.outcome === "reopened" ? "pending" : latest.outcome;
    const enriched = {
      ...term,
      currentOutcome,
      overdue:
        currentOutcome === "pending" &&
        term.dueDate != null &&
        term.dueDate < today,
    };
    const group = termsBySet.get(term.termSetId) ?? [];
    group.push(enriched);
    termsBySet.set(term.termSetId, group);
  }
  return sets.map((set) => ({ ...set, terms: termsBySet.get(set.id) ?? [] }));
}

async function loadTermSet(id: string) {
  const [set] = await db
    .select()
    .from(grantTermSets)
    .where(eq(grantTermSets.id, id));
  if (!set) return null;
  const sets = await loadTermSets(set.opportunityId);
  return sets.find((candidate) => candidate.id === id) ?? null;
}

router.get(
  "/opportunities-and-pledges/:id/grant-terms",
  asyncHandler(async (req, res) => {
    const opportunityId = paramId(req);
    if (!(await opportunityExists(opportunityId))) {
      return notFound(res, "opportunity");
    }
    const allocations = await db
      .select()
      .from(pledgeAllocations)
      .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId))
      .orderBy(asc(pledgeAllocations.createdAt));
    const allocationIds = allocations.map((allocation) => allocation.id);
    const snapshots = allocationIds.length
      ? await db
          .select()
          .from(grantSpendSnapshots)
          .where(inArray(grantSpendSnapshots.pledgeAllocationId, allocationIds))
          .orderBy(
            asc(grantSpendSnapshots.asOfDate),
            asc(grantSpendSnapshots.createdAt),
          )
      : [];
    const snapshotsByAllocation = new Map<string, typeof snapshots>();
    for (const snapshot of snapshots) {
      const group =
        snapshotsByAllocation.get(snapshot.pledgeAllocationId) ?? [];
      group.push(snapshot);
      snapshotsByAllocation.set(snapshot.pledgeAllocationId, group);
    }
    const allocationSpending = allocations.map((allocation) => {
      const history = snapshotsByAllocation.get(allocation.id) ?? [];
      const latest = history.at(-1);
      const spent = Number(latest?.amountSpentToDate ?? 0);
      const allocationAmount =
        allocation.subAmount == null ? null : Number(allocation.subAmount);
      return {
        pledgeAllocationId: allocation.id,
        allocationAmount: allocation.subAmount,
        amountSpentToDate: spent.toFixed(2),
        amountRemaining:
          allocationAmount == null || !Number.isFinite(allocationAmount)
            ? null
            : (allocationAmount - spent).toFixed(2),
        latestAsOfDate: latest?.asOfDate ?? null,
        latestNote: latest?.note ?? null,
        snapshots: history,
      };
    });
    const restriction = await loadGrantRestrictionRollup(
      allocations,
      opportunityId,
    );
    res.json({
      opportunityId,
      ...restriction,
      termSets: await loadTermSets(opportunityId),
      allocationSpending,
    });
  }),
);

router.post(
  "/opportunities-and-pledges/:id/grant-terms/manual",
  asyncHandler(async (req, res) => {
    const user = requireWriteAccess(req, res);
    if (!user) return;
    const body = parseOrBadRequest(CreateManualGrantTermSetBody, req.body, res);
    if (!body) return;
    if (body.terms.length === 0) {
      return res.status(400).json({
        error: "validation_error",
        message: "Enter at least one provisional grant term.",
      });
    }
    const semanticError = validateTermSemantics(body.terms);
    if (semanticError) {
      return res
        .status(400)
        .json({ error: "validation_error", message: semanticError });
    }
    const opportunityId = paramId(req);
    if (!(await opportunityExists(opportunityId)))
      return notFound(res, "opportunity");
    const scopeError = await validateTermScope(opportunityId, body.terms);
    if (scopeError) {
      return res
        .status(400)
        .json({ error: "validation_error", message: scopeError });
    }

    const termSetId = newId();
    await db.transaction(async (tx) => {
      await tx
        .update(grantTermSets)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(
          and(
            eq(grantTermSets.opportunityId, opportunityId),
            eq(grantTermSets.status, "active"),
          ),
        );
      await tx.insert(grantTermSets).values({
        id: termSetId,
        opportunityId,
        source: "manual",
        status: "active",
        analysisSummary: body.analysisSummary?.trim() || null,
        createdByUserId: user.id,
        reviewedByUserId: user.id,
        reviewedAt: new Date(),
      });
      await tx
        .insert(grantTerms)
        .values(termInsertValues(termSetId, body.terms));
      await applyGrantTermSetToAllocations(tx, opportunityId, termSetId);
    });
    await applyDerivedOppFields(opportunityId);
    res.status(201).json(await loadTermSet(termSetId));
  }),
);

router.post(
  "/opportunities-and-pledges/:id/grant-agreement-analysis",
  asyncHandler(async (req, res) => {
    const user = requireWriteAccess(req, res);
    if (!user) return;
    const body = parseOrBadRequest(AnalyzeGrantAgreementBody, req.body, res);
    if (!body) return;
    const opportunityId = paramId(req);
    const [opportunity] = await db
      .select({
        id: opportunitiesAndPledges.id,
        grantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
        grantLetterFilename: opportunitiesAndPledges.grantLetterFilename,
      })
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, opportunityId));
    if (!opportunity) return notFound(res, "opportunity");
    if (
      opportunity.grantLetterUrl !== body.documentUrl ||
      opportunity.grantLetterFilename !== body.documentFilename
    ) {
      return res.status(400).json({
        error: "document_mismatch",
        message:
          "Analyze the grant letter currently saved on this opportunity.",
      });
    }

    // Once a new document has been selected, an older unreviewed proposal must
    // no longer be accept-able even if the replacement analysis fails. The
    // currently active, human-reviewed interpretation remains untouched.
    await db
      .update(grantTermSets)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(
        and(
          eq(grantTermSets.opportunityId, opportunityId),
          eq(grantTermSets.status, "pending_review"),
        ),
      );

    const objectPath = body.documentUrl.startsWith("/api/storage")
      ? body.documentUrl.slice("/api/storage".length)
      : body.documentUrl;
    const objectStorage = new ObjectStorageService();
    const file = await objectStorage.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    let analysis;
    try {
      analysis = await analyzeGrantAgreementFile({
        file,
        fileName: body.documentFilename,
        mimeType: String(metadata.contentType || "application/octet-stream"),
        sizeBytes: Number(metadata.size || 0),
      });
    } catch (error) {
      return res.status(422).json({
        error: "analysis_failed",
        message:
          error instanceof Error ? error.message : "Grant analysis failed.",
      });
    }

    const termSetId = newId();
    await db.transaction(async (tx) => {
      // Serialize analyses that finish at nearly the same time so the partial
      // unique index can guarantee one review proposal per opportunity.
      await tx
        .select({ id: opportunitiesAndPledges.id })
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.id, opportunityId))
        .for("update");
      // A newer analysis replaces an unreviewed proposal without deleting its
      // history. The active/manual interpretation is deliberately untouched.
      await tx
        .update(grantTermSets)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(grantTermSets.opportunityId, opportunityId),
            eq(grantTermSets.status, "pending_review"),
          ),
        );
      await tx.insert(grantTermSets).values({
        id: termSetId,
        opportunityId,
        source: body.source ?? "grant_agreement",
        status: "pending_review",
        sourceDocumentUrl: body.documentUrl,
        sourceDocumentFilename: body.documentFilename,
        analysisSummary: analysis.analysisSummary,
        aiModel: analysis.model,
        promptVersion: analysis.promptVersion,
        createdByUserId: user.id,
      });
      if (analysis.terms.length) {
        await tx
          .insert(grantTerms)
          .values(termInsertValues(termSetId, analysis.terms));
      }
    });
    res.status(201).json(await loadTermSet(termSetId));
  }),
);

router.patch(
  "/grant-term-sets/:id",
  asyncHandler(async (req, res) => {
    const user = requireWriteAccess(req, res);
    if (!user) return;
    const body = parseOrBadRequest(CreateManualGrantTermSetBody, req.body, res);
    if (!body) return;
    const semanticError = validateTermSemantics(body.terms);
    if (semanticError) {
      return res
        .status(400)
        .json({ error: "validation_error", message: semanticError });
    }
    const id = paramId(req);
    const [set] = await db
      .select()
      .from(grantTermSets)
      .where(eq(grantTermSets.id, id));
    if (!set) return notFound(res, "grant term set");
    if (set.status !== "pending_review") {
      return res.status(409).json({
        error: "term_set_not_editable",
        message: "Only a pending grant-term proposal can be revised.",
      });
    }
    const scopeError = await validateTermScope(set.opportunityId, body.terms);
    if (scopeError) {
      return res
        .status(400)
        .json({ error: "validation_error", message: scopeError });
    }
    await db.transaction(async (tx) => {
      await tx.delete(grantTerms).where(eq(grantTerms.termSetId, id));
      if (body.terms.length) {
        await tx.insert(grantTerms).values(termInsertValues(id, body.terms));
      }
      await tx
        .update(grantTermSets)
        .set({
          analysisSummary: body.analysisSummary?.trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(grantTermSets.id, id));
    });
    res.json(await loadTermSet(id));
  }),
);

router.post(
  "/grant-term-sets/:id/activate",
  asyncHandler(async (req, res) => {
    const user = requireWriteAccess(req, res);
    if (!user) return;
    const id = paramId(req);
    let opportunityId: string | null = null;
    let failure: { status: number; body: Record<string, unknown> } | null =
      null;
    await db.transaction(async (tx) => {
      const [set] = await tx
        .select()
        .from(grantTermSets)
        .where(eq(grantTermSets.id, id))
        .for("update");
      if (!set) {
        failure = { status: 404, body: { error: "not_found" } };
        return;
      }
      if (set.status !== "pending_review") {
        failure = {
          status: 409,
          body: {
            error: "term_set_not_pending",
            message: "Only a pending grant-term proposal can be accepted.",
          },
        };
        return;
      }
      const storedTerms = await tx
        .select()
        .from(grantTerms)
        .where(eq(grantTerms.termSetId, id));
      const semanticError = validateTermSemantics(storedTerms);
      if (semanticError) {
        failure = {
          status: 400,
          body: { error: "validation_error", message: semanticError },
        };
        return;
      }
      opportunityId = set.opportunityId;
      await tx
        .update(grantTermSets)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(
          and(
            eq(grantTermSets.opportunityId, set.opportunityId),
            eq(grantTermSets.status, "active"),
          ),
        );
      await tx
        .update(grantTermSets)
        .set({
          status: "active",
          reviewedByUserId: user.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(grantTermSets.id, id));
      await applyGrantTermSetToAllocations(tx, set.opportunityId, id);
    });
    if (failure) {
      const result = failure as {
        status: number;
        body: Record<string, unknown>;
      };
      if (result.status === 404) return notFound(res, "grant term set");
      return res.status(result.status).json(result.body);
    }
    await applyDerivedOppFields(opportunityId);
    res.json(await loadTermSet(id));
  }),
);

router.post(
  "/grant-terms/:id/outcomes",
  asyncHandler(async (req, res) => {
    const user = requireWriteAccess(req, res);
    if (!user) return;
    const body = parseOrBadRequest(RecordGrantTermOutcomeBody, req.body, res);
    if (!body) return;
    const grantTermId = paramId(req);
    const [term] = await db
      .select({
        id: grantTerms.id,
        kind: grantTerms.kind,
        termSetId: grantTerms.termSetId,
        opportunityId: grantTermSets.opportunityId,
        setStatus: grantTermSets.status,
      })
      .from(grantTerms)
      .innerJoin(grantTermSets, eq(grantTermSets.id, grantTerms.termSetId))
      .where(eq(grantTerms.id, grantTermId));
    if (!term) return notFound(res, "grant term");
    if (term.setStatus !== "active") {
      return res.status(409).json({
        error: "term_set_not_active",
        message:
          "Record outcomes only against the currently accepted grant terms.",
      });
    }
    if (term.kind !== "condition" && term.kind !== "donor_restriction") {
      return res.status(400).json({
        error: "invalid_outcome_target",
        message:
          "Outcomes can be recorded only for conditions and donor restrictions.",
      });
    }
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(grantTermOutcomeEvents)
        .values({
          id: newId(),
          grantTermId,
          outcome: body.outcome,
          effectiveDate: body.effectiveDate,
          note: body.note?.trim() || null,
          evidenceUrl: body.evidenceUrl?.trim() || null,
          recordedByUserId: user.id,
        })
        .returning();
      if (term.kind === "condition") {
        await refreshGrantConditionOutcomes(
          tx,
          term.opportunityId,
          term.termSetId,
        );
      }
      return created;
    });
    if (term.kind === "condition") {
      await applyDerivedOppFields(term.opportunityId);
    }
    res.status(201).json(row);
  }),
);

router.post(
  "/pledge-allocations/:id/spend-snapshots",
  asyncHandler(async (req, res) => {
    const user = requireWriteAccess(req, res);
    if (!user) return;
    const body = parseOrBadRequest(RecordGrantSpendSnapshotBody, req.body, res);
    if (!body) return;
    const pledgeAllocationId = paramId(req);
    const [allocation] = await db
      .select({ id: pledgeAllocations.id })
      .from(pledgeAllocations)
      .where(eq(pledgeAllocations.id, pledgeAllocationId));
    if (!allocation) return notFound(res, "allocation");
    const [row] = await db
      .insert(grantSpendSnapshots)
      .values({
        id: newId(),
        pledgeAllocationId,
        asOfDate: body.asOfDate,
        amountSpentToDate: body.amountSpentToDate,
        note: body.note?.trim() || null,
        recordedByUserId: user.id,
      })
      .returning();
    res.status(201).json(row);
  }),
);

export default router;
