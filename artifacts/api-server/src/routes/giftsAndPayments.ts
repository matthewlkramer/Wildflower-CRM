import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { enqueueDonorSignal } from "../lib/taskSuggestionQueue";
import {
  giftsAndPayments,
  giftAllocations,
  stagedPayments,
  opportunitiesAndPledges,
  pledgeAllocations,
  bulkOperations,
  organizations,
  households,
  people,
  emailMessages,
  emailAttachments,
  emails,
  peopleEntityRoles,
  stripeStagedCharges,
  stripePayouts,
  settlementLinks,
  donorboxDonations,
  paymentApplications,
  type NewGiftAllocation,
} from "@workspace/db/schema";
import { and, asc, count, desc, eq, getTableColumns, gte, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getAppUser } from "../lib/appRequest";
import { getViewer, type Viewer } from "../lib/identityVisibility";
import {
  donorDisplayColumns,
  maskDonorDisplayFields,
} from "../lib/donorJoinSelect";
import {
  donorboxEnrichmentSelect,
  donorboxEnrichmentOrNull,
} from "../lib/donorboxEnrichment";
import { giftWorklistConds, type GiftWorklist } from "../lib/worklists";

// Gifts have no primary-contact denormalization, so the shared donor masking
// helper (see lib/donorJoinSelect.ts) covers the full set: it masks the
// organization / individual-giver display names and strips the anonymous/owner
// helper aliases so the JSON response shape is unchanged.
const maskGiftDonorRow = maskDonorDisplayFields;

// See opportunitiesAndPledges.ts for rationale — same denormalized
// donor display names joined from funders / households / people, plus
// three de-duplicated aggregates from gift_allocations so the gifts
// list can render Entities / Usages / Grant years inline without
// fanning out per-row fetches.
// Named gift-header projection, reused by the QuickBooks reconcile/mint routes
// (matching.ts, actions.ts) that echo a gift row directly, plus the opportunities
// payments projection and the archive/unarchive routes.
// This is the single named column set every full-row gift select flows through
// (see deprecated-column-response-leak). Deprecated-but-physical columns still
// present in the schema (e.g. originalHumanCrmAmount, finalAmountStripeChargeId)
// are intentionally echoed here to match their deprecated OpenAPI response
// fields; columns fully retired from the schema (grant_year, needs_research,
// processor_fee) simply fall out of getTableColumns and never reach a response.
// finalAmountQbStagedPaymentId is @deprecated NEVER READ / NEVER WRITTEN (the
// counted payment_applications ledger is the sole QB gift-link source), so it
// is scrubbed here ahead of its physical drop.
const {
  finalAmountQbStagedPaymentId: _finalAmountQbStagedPaymentId,
  ...giftHeaderColumns
} = getTableColumns(giftsAndPayments);
export { giftHeaderColumns };
const donorJoinSelect = {
  ...giftHeaderColumns,
  // Shared donor display names + priorities + anonymous/owner helpers
  // (see lib/donorJoinSelect.ts) — identical to the opportunities route.
  ...donorDisplayColumns,
  entityIds: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT ga.entity_id ORDER BY ga.entity_id)
    FROM gift_allocations ga
    WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.entity_id IS NOT NULL
  )`.as("entity_ids"),
  displayUsages: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT ga.display_usage ORDER BY ga.display_usage)
    FROM gift_allocations ga
    WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.display_usage IS NOT NULL
  )`.as("display_usages"),
  grantYears: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT ga.grant_year ORDER BY ga.grant_year)
    FROM gift_allocations ga
    WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.grant_year IS NOT NULL
  )`.as("grant_years"),
  // Display name of the gift's payment intermediary (DAF / platform), if any.
  // Correlated subquery so no extra join is forced on donorJoinSelect callers.
  paymentIntermediaryName: sql<string | null>`(
    SELECT pi.name FROM payment_intermediaries pi
    WHERE pi.id = ${giftsAndPayments.paymentIntermediaryId}
  )`.as("payment_intermediary_name"),
  // The QuickBooks staged payment linked to this gift via the authoritative
  // cash-application ledger (one anchoring payment_id, LIMIT 1). Lets the
  // reconciler show linked status and offer an unmatch action. Read from the
  // ledger (T003 cutover); the legacy scattered linkage columns are retained for
  // rollback but no longer read here.
  quickbooksStagedPaymentId: qbLedgerPaymentIdForGift().as(
    "quickbooks_staged_payment_id",
  ),
  // Task #448 — settled amount + processor fees derived at read time from the
  // gift's LINKED payments (QuickBooks + Stripe + non-stripe Donorbox), via the
  // one shared {settledGross, totalFees} helper. Replaces the now-dropped header
  // processorFee and the deprecated final_amount_* columns. NULL when nothing has
  // landed yet.
  derivedSettledAmount: derivedSettledAmountForGift().as(
    "derived_settled_amount",
  ),
  derivedProcessorFee: derivedProcessorFeeForGift().as("derived_processor_fee"),
  // Task #594 — off-books / payment-exempt is DERIVED ONLY from the gift's
  // allocation entities (off-books when it has allocations and every one sits on
  // a no-payment entity). Replaces the retired header booleans; the way to make a
  // gift off-books is to put its allocations on a no-payment entity.
  offBooks: giftIsOffBooksExpr().as("off_books"),
};
import {
  ListGiftsAndPaymentsQueryParams,
  CreateGiftOrPaymentBodyRefined,
  UpdateGiftOrPaymentBody,
  BulkUpdateGiftsAndPaymentsBody,
  BulkArchiveGiftsAndPaymentsBody,
  MergeGiftsAndPaymentsBody,
  MergeGiftsIntoPledgeBody,
  SplitGiftIntoPledgeBody,
  RevertGiftToOpportunityBody,
  ResolveGiftOverpayBody,
  validateGiftInvariants,
  validateOppInvariants,
  giftTypeToLoanOrGrant,
  loanOrGrantToLegacyCategory,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { resolveGiftFreeze, resolveGiftFreezeById, respondFrozen } from "../lib/freezeGuard";
import { getCurrentOpenFiscalYear, todayInChicago } from "../lib/governingFiscalYear";
import {
  computeGiftSurplus,
  findActiveOverpayChildGiftId,
} from "../lib/auditCloseResolution";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "../lib/giftAllocationSeed";
import { auditCreate, auditUpdate } from "../lib/audit";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { activeOnlyUnlessAdmin, archiveOne, executeBulkArchive, unarchiveOne } from "../lib/archive";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { applyGiftQbTieMany } from "../lib/giftQbTie";
import { payoutStatusFromLink } from "../lib/settlementLink";
import { absorbGiftEvidenceIntoSurvivor } from "../lib/giftCombine";
import {
  qbLedgerExistsForGift,
  qbLedgerPaymentIdForGift,
} from "../lib/paymentApplications";
import { isReimbursablePlaceholderGift } from "../lib/reimbursablePlaceholder";
import { isFlaggedForResearch } from "../lib/flaggedForResearch";
import {
  derivedSettledAmountForGift,
  derivedProcessorFeeForGift,
  giftIsOffBooksExpr,
} from "../lib/giftPaymentSummary";
import { deriveGiftLanes } from "../lib/reconciliationLanes";
import { stagedStatusSql } from "../lib/derivedStatus";
import { inArray } from "drizzle-orm";

const GIFTS_ARRAY_PARAMS = ["type", "paymentMethod", "ownerUserId", "entityId", "fiscalYear", "quickbooksTie"] as const;

const router: IRouter = Router();
router.use(requireAuth);

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: { issues: issues.map((i) => ({ path: [i.path], message: i.message })) },
  });
}

router.get(
  "/gifts-and-payments",
  asyncHandler(async (req, res) => {
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      GIFTS_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(ListGiftsAndPaymentsQueryParams, normalizedQuery, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      // Search the record name plus the donor display name (org / household /
      // individual giver). The donor tables are already left-joined below, and
      // the count query joins them too. Person name mirrors the
      // individualGiverPersonName expression in donorJoinSelect.
      const term = `%${q.search}%`;
      filters.push(
        or(
          ilike(giftsAndPayments.name, term),
          ilike(organizations.name, term),
          ilike(households.name, term),
          sql`COALESCE(
            NULLIF(TRIM(${people.fullName}), ''),
            NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
          ) ILIKE ${term}`,
          // Linked payment intermediary name (correlated EXISTS — no join).
          sql`EXISTS (
            SELECT 1 FROM payment_intermediaries pi
            WHERE pi.id = ${giftsAndPayments.paymentIntermediaryId}
              AND pi.name ILIKE ${term}
          )`,
        )!,
      );
    }
    // Date-received window (inclusive) for the reconciler's amount/date search.
    if (q.dateAfter) filters.push(gte(giftsAndPayments.dateReceived, q.dateAfter));
    if (q.dateBefore) filters.push(lte(giftsAndPayments.dateReceived, q.dateBefore));
    // Exact amount filter (major units) for the broad gift-search dialog —
    // numeric equality so "480" matches a stored "480.00". A non-numeric value
    // is silently ignored (never a 500).
    if (q.amount != null && q.amount !== "") {
      const amt = Number(q.amount);
      if (Number.isFinite(amt)) {
        filters.push(sql`(${giftsAndPayments.amount})::numeric = ${amt}::numeric`);
      }
    }
    // Linked-to-QuickBooks filter — whether the gift has any QuickBooks
    // cash-application ledger row (T003 cutover). Correlated EXISTS, no join.
    if (q.linkedToQuickbooks === "linked") {
      filters.push(qbLedgerExistsForGift());
    } else if (q.linkedToQuickbooks === "unlinked") {
      filters.push(sql`NOT ${qbLedgerExistsForGift()}`);
    }
    // Persisted QuickBooks-tie status filter. The synthetic value `untied`
    // expands to the on-books gifts that don't tie to QuickBooks
    // (missing + amount_mismatch) — the audit "off-books / doesn't tie" list.
    {
      const tie = q.quickbooksTie as string[] | undefined;
      if (tie && tie.length > 0) {
        const wanted = new Set<string>();
        for (const v of tie) {
          if (v === "untied") {
            wanted.add("missing");
            wanted.add("amount_mismatch");
          } else {
            wanted.add(v);
          }
        }
        if (wanted.size > 0) {
          filters.push(
            inArray(giftsAndPayments.quickbooksTieStatus, [...wanted] as never[]),
          );
        }
      }
    }
    // Awaiting-funding-evidence queue (edge case B4): CRM-first gifts a
    // fundraiser logged before any funding evidence arrived. The "pending
    // funding" state is a human-entered amount (`final_amount_source = 'human'`,
    // which the DB CHECK guarantees has null QuickBooks/Stripe evidence
    // pointers) AND no QuickBooks tie yet (`quickbooks_tie_status = 'missing'`,
    // which also excludes off-books/exempt and Stripe-sourced/tied gifts).
    // Read raw — `zod.coerce.boolean()` would coerce the string "false" to true.
    if (req.query.awaitingEvidence === "true") {
      filters.push(eq(giftsAndPayments.finalAmountSource, "human"));
      filters.push(eq(giftsAndPayments.quickbooksTieStatus, "missing"));
    }
    {
      const f = splitBlank(q.type as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(giftsAndPayments.type), inArray(giftsAndPayments.type, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(giftsAndPayments.type));
      else if (f.values.length > 0) filters.push(inArray(giftsAndPayments.type, f.values as never[]));
    }
    if (q.organizationId) filters.push(eq(giftsAndPayments.organizationId, q.organizationId));
    if (q.householdId) filters.push(eq(giftsAndPayments.householdId, q.householdId));
    if (q.individualGiverPersonId) filters.push(eq(giftsAndPayments.individualGiverPersonId, q.individualGiverPersonId));
    if (q.opportunityId) filters.push(eq(giftsAndPayments.opportunityId, q.opportunityId));
    {
      const f = splitBlank(q.paymentMethod as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(giftsAndPayments.paymentMethod), inArray(giftsAndPayments.paymentMethod, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(giftsAndPayments.paymentMethod));
      else if (f.values.length > 0) filters.push(inArray(giftsAndPayments.paymentMethod, f.values as never[]));
    }
    {
      const f = splitBlank(q.ownerUserId as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(giftsAndPayments.ownerUserId), inArray(giftsAndPayments.ownerUserId, f.values))!);
      else if (f.wantsBlank) filters.push(isNull(giftsAndPayments.ownerUserId));
      else if (f.values.length > 0) filters.push(inArray(giftsAndPayments.ownerUserId, f.values));
    }
    // Entity filter — EXISTS on gift_allocations so we don't fan rows out
    // when a single gift has multiple allocations. Driven by the global
    // entity filter in the header.
    if (q.entityId && q.entityId.length > 0) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${inArray(giftAllocations.entityId, q.entityId)})`,
      );
    }
    // Fiscal-year filter — supports the "(Blank)" sentinel meaning "no
    // allocations". Real values continue to use EXISTS so gifts with
    // multiple allocations don't fan out into duplicate rows.
    {
      const fyRaw = (q.fiscalYear as string[] | undefined) ?? [];
      const { wantsBlank, values: fyValues } = splitBlank(fyRaw);
      if (fyValues.length > 0 && wantsBlank) {
        filters.push(
          sql`(EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${inArray(giftAllocations.grantYear, fyValues)}) OR NOT EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id}))`,
        );
      } else if (fyValues.length > 0) {
        filters.push(
          sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${inArray(giftAllocations.grantYear, fyValues)})`,
        );
      } else if (wantsBlank) {
        filters.push(
          sql`NOT EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id})`,
        );
      }
    }
    // Presence filters on computed rollup fields (has value vs blank).
    // Each mirrors the matching column expression in donorJoinSelect.
    if (q.entitiesPresence === "has") {
      filters.push(sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${giftAllocations.entityId} IS NOT NULL)`);
    } else if (q.entitiesPresence === "blank") {
      filters.push(sql`NOT EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${giftAllocations.entityId} IS NOT NULL)`);
    }
    if (q.usagesPresence === "has") {
      filters.push(sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${giftAllocations.displayUsage} IS NOT NULL)`);
    } else if (q.usagesPresence === "blank") {
      filters.push(sql`NOT EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${giftAllocations.displayUsage} IS NOT NULL)`);
    }
    if (q.grantYearsPresence === "has") {
      filters.push(sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${giftAllocations.grantYear} IS NOT NULL)`);
    } else if (q.grantYearsPresence === "blank") {
      filters.push(sql`NOT EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${giftAllocations.grantYear} IS NOT NULL)`);
    }
    if (q.thankYouSentAtPresence === "has") filters.push(sql`${giftsAndPayments.thankYouSentAt} IS NOT NULL`);
    else if (q.thankYouSentAtPresence === "blank") filters.push(sql`${giftsAndPayments.thankYouSentAt} IS NULL`);
    // Donor-lifecycle worklist preset — composite predicate shared verbatim
    // with the dashboard worklist counts (see lib/worklists).
    if (q.worklist) filters.push(...giftWorklistConds(q.worklist as GiftWorklist));
    const archivedFilter = activeOnlyUnlessAdmin(req, giftsAndPayments.archivedAt);
    if (archivedFilter) filters.push(archivedFilter);
    const where = filters.length ? and(...filters) : undefined;
    // Sort order (default date_desc). Amount is a numeric text column, so cast
    // for a true numeric sort; a NULLS LAST tiebreaker on dateReceived keeps the
    // order stable. Mirrors the staged-payments list sort options.
    const amountNum = sql`(${giftsAndPayments.amount})::numeric`;
    const orderBy =
      q.sort === "amount_desc"
        ? [desc(amountNum), desc(giftsAndPayments.dateReceived)]
        : q.sort === "amount_asc"
          ? [asc(amountNum), desc(giftsAndPayments.dateReceived)]
          : q.sort === "date_asc"
            ? [asc(giftsAndPayments.dateReceived)]
            : [desc(giftsAndPayments.dateReceived)];
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(donorJoinSelect)
        .from(giftsAndPayments)
        .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(where),
    ]);
    const viewer = getViewer(req);
    const data = rows.map((r) => {
      const masked = maskGiftDonorRow(r, viewer);
      return {
        ...masked,
        reconciliationLanes: deriveGiftLanes(masked.quickbooksTieStatus),
      };
    });
    res.json({ data, pagination: { page, limit, total: Number(total) } });
  }),
);

async function buildGiftDetail(id: string, viewer: Viewer) {
  const row = await db
    .select(donorJoinSelect)
    .from(giftsAndPayments)
    .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
    .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
    .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
    .where(eq(giftsAndPayments.id, id))
    .then((r) => r[0]);
  if (!row) return null;
  const allocations = await db.select().from(giftAllocations).where(eq(giftAllocations.giftId, id));
  let thankYouAttachments: Array<{
    id: string;
    filename: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    downloadUrl: string;
  }> | null = null;
  if (row.thankYouEmailMessageId) {
    const atts = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        mimeType: emailAttachments.mimeType,
        sizeBytes: emailAttachments.sizeBytes,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, row.thankYouEmailMessageId));
    thankYouAttachments = atts.map((a) => ({
      ...a,
      downloadUrl: `/api/email-attachments/${a.id}/download`,
    }));
  }
  // Donorbox enrichment: a gift minted/matched from a Stripe-type Donorbox
  // donation is reachable via its linked Stripe charge
  // (donorbox_donations.stripe_charge_id = the gift's matched/created
  // stripe_staged_charges.id). 1:1 by the partial-unique stripe_charge_id index.
  // Enrichment only — never affects the gift's money.
  const donorboxRow = await db
    .select(donorboxEnrichmentSelect)
    .from(donorboxDonations)
    .innerJoin(
      stripeStagedCharges,
      eq(stripeStagedCharges.id, donorboxDonations.stripeChargeId),
    )
    .where(
      or(
        eq(stripeStagedCharges.matchedGiftId, id),
        eq(stripeStagedCharges.createdGiftId, id),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  const masked = maskGiftDonorRow(row, viewer);
  // Derived audit-close resolution state (never persisted — see the
  // GiftAuditCloseResolution schema). Drives the "book surplus gift" action;
  // the surplus reuses the resolve-overpay route's shared helper. The surplus
  // read runs in a trivial read transaction because computeGiftSurplus takes a
  // Tx (via getGiftPaymentSummary).
  const giftFreeze = await resolveGiftFreeze(undefined, row.dateReceived);
  const [
    overpaySurplusRaw,
    resolvedByGiftId,
    reimbursablePlaceholderWarning,
    flaggedForResearch,
  ] = await Promise.all([
    db.transaction((tx) => computeGiftSurplus(tx, { id: row.id, amount: row.amount })),
    findActiveOverpayChildGiftId(id),
    // Guardrail: warn when this gift is a full-award placeholder on a
    // reimbursable pledge with no settlement evidence (nudge to book real
    // reimbursement checks instead — see lib/reimbursablePlaceholder.ts).
    isReimbursablePlaceholderGift(id),
    // Passive "Needs research" badge — driven solely by the Cleanup Queue.
    isFlaggedForResearch(id),
  ]);
  return {
    ...masked,
    reconciliationLanes: deriveGiftLanes(masked.quickbooksTieStatus),
    reimbursablePlaceholderWarning,
    flaggedForResearch,
    allocations,
    thankYouAttachments,
    donorbox: donorboxEnrichmentOrNull(donorboxRow),
    auditClose: {
      frozen: giftFreeze.frozen,
      frozenFiscalYearLabel: giftFreeze.frozen ? giftFreeze.fiscalYearLabel : null,
      overpaySurplus: Math.max(0, overpaySurplusRaw).toFixed(2),
      resolvedByGiftId,
    },
  };
}

router.get(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const detail = await buildGiftDetail(id, getViewer(req));
    if (!detail) return notFound(res, "gift");
    res.json(detail);
  }),
);

router.post(
  "/gifts-and-payments/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "gifts_and_payments",
      table: giftsAndPayments,
      bodySchema: BulkUpdateGiftsAndPaymentsBody,
      // Fiscal-year freeze: skip (fail) any gift whose governing FY is
      // audit-closed, or a re-date that would move it into a closed FY.
      freezeCheck: (existing, cleanPatch) =>
        resolveGiftFreeze(
          (existing as Record<string, unknown>).dateReceived as string | null | undefined,
          (cleanPatch as Record<string, unknown>).dateReceived as string | null | undefined,
        ),
      allowedFields: ["ownerUserId", "type", "paymentMethod", "dateReceived"],
      // Mirror the authoritative loan_or_grant flag whenever a bulk edit
      // changes the gift `type` (legacy `type` stays the read source this
      // phase); written atomically in the same per-row UPDATE.
      deriveColumns: (p) =>
        "type" in p
          ? { loanOrGrant: giftTypeToLoanOrGrant((p as { type?: string | null }).type) }
          : {},
      // Allocation-set reconciliation fields — managed via extraApply
      // rather than as columns on gifts_and_payments.
      virtualFields: [
        "entityIds",
        "entityIdsMode",
        "grantYears",
        "grantYearsMode",
        "intendedUsage",
        "fundableProjectId",
      ],
      // Reconcile gift_allocations to match the requested entityIds /
      // grantYears sets. Each virtual field is independent and only
      // touches allocation rows where that column is set; replace
      // wipes those rows (DESTRUCTIVE — loses subAmount and the
      // counterpart field on those rows), append adds missing values
      // only.
      extraApply: async (tx, id, vp) => {
        const v = vp as {
          entityIds?: string[];
          entityIdsMode?: string;
          grantYears?: string[];
          grantYearsMode?: string;
          intendedUsage?: NewGiftAllocation["intendedUsage"];
          fundableProjectId?: string | null;
        };
        if (v.entityIds) {
          const mode = v.entityIdsMode === "append" ? "append" : "replace";
          if (mode === "replace") {
            await tx
              .delete(giftAllocations)
              .where(
                and(
                  eq(giftAllocations.giftId, id),
                  sql`${giftAllocations.entityId} IS NOT NULL`,
                ),
              );
          }
          const existing =
            mode === "append"
              ? (
                  await tx
                    .select({ e: giftAllocations.entityId })
                    .from(giftAllocations)
                    .where(eq(giftAllocations.giftId, id))
                )
                  .map((r: { e: string | null }) => r.e)
                  .filter((e: string | null): e is string => !!e)
              : [];
          for (const entityId of v.entityIds.filter((e) => !existing.includes(e))) {
            await tx.insert(giftAllocations).values({
              id: newId(),
              giftId: id,
              entityId,
            });
          }
        }
        if (v.grantYears) {
          const mode = v.grantYearsMode === "append" ? "append" : "replace";
          if (mode === "replace") {
            await tx
              .delete(giftAllocations)
              .where(
                and(
                  eq(giftAllocations.giftId, id),
                  sql`${giftAllocations.grantYear} IS NOT NULL`,
                ),
              );
          }
          const existing =
            mode === "append"
              ? (
                  await tx
                    .select({ y: giftAllocations.grantYear })
                    .from(giftAllocations)
                    .where(eq(giftAllocations.giftId, id))
                )
                  .map((r: { y: string | null }) => r.y)
                  .filter((y: string | null): y is string => !!y)
              : [];
          for (const fy of v.grantYears.filter((y) => !existing.includes(y))) {
            await tx.insert(giftAllocations).values({
              id: newId(),
              giftId: id,
              grantYear: fy,
            });
          }
        }
        // Intended usage applies to ALL of the gift's allocation rows.
        // Update every existing row to the chosen value; if the gift has
        // no allocation rows at all, create a single one carrying it so
        // the value is recorded. The fundable project link is only
        // meaningful for usage = 'project': set it on every row in that
        // case, and clear it (null) for any other usage so stale links
        // don't linger.
        if (v.intendedUsage) {
          const fundableProjectId =
            v.intendedUsage === "project" ? (v.fundableProjectId ?? null) : null;
          const existing = await tx
            .select({ id: giftAllocations.id })
            .from(giftAllocations)
            .where(eq(giftAllocations.giftId, id));
          if (existing.length > 0) {
            await tx
              .update(giftAllocations)
              .set({
                intendedUsage: v.intendedUsage,
                fundableProjectId,
                updatedAt: new Date(),
              })
              .where(eq(giftAllocations.giftId, id));
          } else {
            await tx.insert(giftAllocations).values({
              id: newId(),
              giftId: id,
              intendedUsage: v.intendedUsage,
              fundableProjectId,
            });
          }
        }
      },
    });
  }),
);

router.post(
  "/gifts-and-payments",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateGiftOrPaymentBodyRefined, req.body, res);
    if (!body) return;
    // Freeze guard: refuse to create a gift dated into an audit-closed FY.
    const freeze = await resolveGiftFreeze(undefined, body.dateReceived);
    if (freeze.frozen) return respondFrozen(res, freeze);
    // Wrap in a transaction so the header + its seeded allocation land together:
    // every gift MUST have at least one allocation (the sole home of money scope).
    // The non-blocking coding-capture fields (Task #585) plus grantYear (Task
    // #598 — grant year is allocation-level now) live on the seeded allocation,
    // NOT the gift header — pull them out before the header insert and thread them
    // to the seed. `sourceRecordUrl` stays on the header.
    const {
      entityId: captureEntityId,
      intendedUsage: captureIntendedUsage,
      fundableProjectId: captureFundableProjectId,
      regionalRestrictionType: captureRegionalRestrictionType,
      usageRestrictionType: captureUsageRestrictionType,
      timeRestrictionType: captureTimeRestrictionType,
      grantYear: captureGrantYear,
      ...headerBody
    } = body;
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(giftsAndPayments)
        .values({
          id: newId(),
          ...headerBody,
          // Dual-write the authoritative loan_or_grant flag from the gift type
          // (legacy `type` stays the read source this phase).
          loanOrGrant: giftTypeToLoanOrGrant(headerBody.type),
        })
        .returning(giftHeaderColumns);
      const created = inserted[0];
      if (created) {
        // Seed a single full-amount allocation (fiscal year from the gift date,
        // or the explicit grantYear if the body carried one) so the new gift is
        // never scope-less. Coding captured at creation is threaded on here;
        // anything left blank lands the gift in the incomplete-gift queue.
        await seedInitialGiftAllocation(tx, {
          giftId: created.id,
          amount: created.amount,
          dateReceived: created.dateReceived,
          grantYear: captureGrantYear,
          entityId: captureEntityId,
          intendedUsage: captureIntendedUsage,
          fundableProjectId: captureFundableProjectId,
          regionalRestrictionType: captureRegionalRestrictionType,
          usageRestrictionType: captureUsageRestrictionType,
          timeRestrictionType: captureTimeRestrictionType,
        });
        await assertGiftHasAllocations(tx, created.id);
      }
      return inserted;
    });
    await applyDerivedOppFieldsMany(row?.opportunityId);
    await applyGiftQbTieMany(row?.id);
    if (row) {
      // New gift is a fresh relationship signal — refresh the donor's
      // cached next-step suggestion (debounced + priority-gated downstream).
      enqueueDonorSignal({
        organizationId: row.organizationId,
        individualGiverPersonId: row.individualGiverPersonId,
      });
      await auditCreate(req, "gift", row.id, "Created gift");
    }
    res.status(201).json(row);
  }),
);

// Resolve an over-paid, audited (frozen) gift by booking the SURPLUS as a NEW
// gift in the current open FY, linked back via overpay_of_gift_id. The audited
// original is NEVER mutated — it stays quickbooks_tie_status='amount_mismatch'
// forever and reads as "resolved" only because this active linked child exists.
// Guards: governing FY must actually be audit-closed (pre-close mismatches are
// corrected in place), the gift must not already have an active surplus child,
// an open FY must exist to book into, and there must be a positive surplus
// (derived server-side from settled evidence, never trusted from the client).
router.post(
  "/gifts-and-payments/:id/resolve-overpay",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(ResolveGiftOverpayBody, req.body, res);
    if (!body) return;

    const original = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!original) return notFound(res, "gift");

    // The governing FY must be audit-closed. If it is still open, the mismatch
    // is corrected in place — the surplus gift is the post-close mechanism.
    const freeze = await resolveGiftFreeze(undefined, original.dateReceived);
    if (!freeze.frozen) {
      return res.status(409).json({
        error: "fiscal_year_not_closed",
        message:
          "This gift's fiscal year is still open — correct it in place instead of booking a surplus gift.",
      });
    }

    // At most one active surplus child per audited gift (also enforced by the
    // partial-unique index on overpay_of_gift_id).
    const [{ n: existing }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(giftsAndPayments)
      .where(
        and(
          eq(giftsAndPayments.overpayOfGiftId, id),
          isNull(giftsAndPayments.archivedAt),
        ),
      );
    if (existing > 0) {
      return res.status(409).json({
        error: "overpay_resolution_exists",
        message: "This gift already has an active surplus gift.",
      });
    }

    // Surplus lands in the current open FY; if none is open there is nowhere
    // valid to recognise it.
    const openFy = await getCurrentOpenFiscalYear();
    if (!openFy) {
      return res.status(409).json({
        error: "no_open_fiscal_year",
        message: "There is no open fiscal year to book the surplus gift into.",
      });
    }

    // Compute the surplus (settled evidence gross minus recorded amount) inside
    // the mint transaction; a non-positive surplus aborts the mint (nothing is
    // inserted) and returns 409.
    const surplusGiftId = newId();
    let surplus = 0;
    const row = await db.transaction(async (tx) => {
      surplus = await computeGiftSurplus(tx, {
        id: original.id,
        amount: original.amount,
      });
      if (surplus <= 0) return null;
      const inserted = await tx
        .insert(giftsAndPayments)
        .values({
          id: surplusGiftId,
          name: original.name ? `Overpayment — ${original.name}` : "Overpayment",
          // Donor XOR: copy all three FKs (exactly one is non-null on the source).
          organizationId: original.organizationId,
          individualGiverPersonId: original.individualGiverPersonId,
          householdId: original.householdId,
          amount: surplus.toFixed(2),
          dateReceived: todayInChicago(),
          type: original.type,
          loanOrGrant: giftTypeToLoanOrGrant(original.type),
          overpayOfGiftId: id,
          details: body.reason ?? null,
        })
        .returning(giftHeaderColumns);
      const created = inserted[0];
      if (created) {
        // Seed the mandatory full-amount allocation in the open FY so the
        // surplus gift is never scope-less.
        await seedInitialGiftAllocation(tx, {
          giftId: created.id,
          amount: created.amount,
          dateReceived: created.dateReceived,
          grantYear: openFy.id,
        });
        await assertGiftHasAllocations(tx, created.id);
      }
      return created;
    });
    if (surplus <= 0) {
      return res.status(409).json({
        error: "no_surplus",
        message: "This gift is not over-paid — there is no surplus to book.",
      });
    }
    await applyGiftQbTieMany(row?.id);
    if (row) {
      await auditCreate(
        req,
        "gift",
        row.id,
        `Booked overpayment surplus of gift ${id}`,
      );
    }
    res.status(201).json(row);
  }),
);

router.patch(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateGiftOrPaymentBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const existing = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "gift");

    // Validate merged post-update state so partial PATCHes can't bypass the
    // donor_xor DB CHECK and produce a 500.
    const merged = { ...existing, ...body };
    const issues = validateGiftInvariants({
      organizationId: merged.organizationId,
      individualGiverPersonId: merged.individualGiverPersonId,
      householdId: merged.householdId,
    });
    if (issues.length) return respondInvariantFailure(res, issues);

    // Freeze guard: block edits to a gift whose governing FY is audit-closed, and
    // block moving date_received into a closed FY.
    const freeze = await resolveGiftFreeze(existing.dateReceived, merged.dateReceived);
    if (freeze.frozen) return respondFrozen(res, freeze);

    // Mirror loan_or_grant whenever the legacy `type` is touched (derive from
    // the merged state so an explicit type change maps correctly).
    const giftWrite: typeof body & {
      loanOrGrant?: "loan" | "grant";
      grantLetterUploadedAt?: string | null;
      thankYouLetterUploadedAt?: string | null;
    } = { ...body };
    if (body.type !== undefined) {
      giftWrite.loanOrGrant = giftTypeToLoanOrGrant(merged.type);
    }
    // Stamp the file-upload timestamps server-side: set to now when a URL is
    // provided, cleared to null when the URL is removed. Never client-settable.
    if (body.grantLetterUrl !== undefined) {
      giftWrite.grantLetterUploadedAt = body.grantLetterUrl ? new Date().toISOString() : null;
    }
    if (body.thankYouLetterUrl !== undefined) {
      giftWrite.thankYouLetterUploadedAt = body.thankYouLetterUrl ? new Date().toISOString() : null;
    }
    const [row] = await db
      .update(giftsAndPayments)
      .set({ ...giftWrite, updatedAt: new Date() })
      .where(eq(giftsAndPayments.id, id))
      .returning(giftHeaderColumns);
    if (!row) return notFound(res, "gift");
    // PATCH may re-point opportunity_id — recompute on both the
    // old and the new pledge so a newly-covered target advances.
    await applyDerivedOppFieldsMany(existing.opportunityId, row.opportunityId);
    // A gift amount edit changes the QB-tie status. Off-books is now derived
    // from the allocation entities, so allocation/entity edits recompute the tie
    // on their own endpoints; a header PATCH only needs to react to `amount`.
    // Only recompute when amount actually changed so a pure-annotation edit
    // (e.g. the needs-research flag) is a no-op for derivation.
    if (existing.amount !== row.amount) {
      await applyGiftQbTieMany(row.id);
    }
    // Revenue coding is no longer a persisted snapshot on the allocation
    // (Task #449) — it's derived on demand from the allocation's scope + the
    // gift donor/type, so a donor or gift-type change needs no allocation rewrite.
    await auditUpdate(req, "gift", row.id, existing as Record<string, unknown>, row as Record<string, unknown>, Object.keys(body), "Updated gift");
    res.json(row);
  }),
);

router.post(
  "/gifts-and-payments/bulk-archive",
  asyncHandler(async (req, res) => {
    // Archive is non-destructive: it only stamps archived_at, so unlike the
    // bulk DELETE it neither removes allocation rows nor needs the QuickBooks
    // split-link guard (the link is preserved) nor a pledge-coverage recompute.
    await executeBulkArchive(req, res, {
      entity: "gifts_and_payments",
      table: giftsAndPayments,
      bodySchema: BulkArchiveGiftsAndPaymentsBody,
      freezeResolver: resolveGiftFreezeById,
    });
  }),
);

router.post(
  "/gifts-and-payments/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, {
      entity: "gift",
      table: giftsAndPayments,
      responseColumns: giftHeaderColumns,
      freezeResolver: resolveGiftFreezeById,
    });
  }),
);

router.post(
  "/gifts-and-payments/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, {
      entity: "gift",
      table: giftsAndPayments,
      responseColumns: giftHeaderColumns,
      freezeResolver: resolveGiftFreezeById,
    });
  }),
);

// ──────────────────────────────────────────────────────────────────
// Merge routes
// ──────────────────────────────────────────────────────────────────

/**
 * Donor identity key for a row carrying the three donor FKs — used to compare
 * whether two records (gifts, pledges) share the same donor. "none" when no
 * donor FK is set (shouldn't happen for valid rows, which enforce donor XOR).
 */
function donorKeyOf(r: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): string {
  if (r.organizationId != null) return `org:${r.organizationId}`;
  if (r.individualGiverPersonId != null) return `person:${r.individualGiverPersonId}`;
  if (r.householdId != null) return `household:${r.householdId}`;
  return "none";
}

/**
 * Merge several gifts into one. The survivor (`primaryId`) absorbs every
 * loser's (`mergeIds`) allocation rows, its `amount` becomes the SUM of all
 * selected gifts, and the losers are permanently deleted. Exactly one donor
 * field must resolve (donor XOR) — when none is supplied the survivor's own
 * donor is kept. Blocked (409) if any LOSER is linked to a QuickBooks staged
 * payment, since deleting it would silently null that reconciliation link.
 */
router.post(
  "/gifts-and-payments/merge",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(MergeGiftsAndPaymentsBody, req.body, res);
    if (!body) return;
    const primaryId = body.primaryId;

    // De-dupe losers, drop the primary if it slipped into mergeIds.
    const seen = new Set<string>([primaryId]);
    const loserIds: string[] = [];
    for (const id of body.mergeIds) {
      if (!seen.has(id)) {
        seen.add(id);
        loserIds.push(id);
      }
    }
    if (loserIds.length === 0) {
      res.status(400).json({
        error: "validation_error",
        message: "mergeIds must contain at least one gift distinct from primaryId",
      });
      return;
    }

    const allIds = [primaryId, ...loserIds];
    const actor = getAppUser(req);

    type Outcome =
      | { ok: true; pledges: string[]; donorOrgId: string | null }
      | { ok: false; status: number; json: Record<string, unknown> }
      | { ok: false; invariant: InvariantIssue[] };

    // Everything that decides the outcome — the authoritative row read, the
    // sum, the donor default, and the QuickBooks-link guard — happens INSIDE
    // the transaction after FOR UPDATE so a concurrent edit, delete, or QB
    // reconcile can't race between a guard and the destructive delete below.
    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const rows = await tx
        .select()
        .from(giftsAndPayments)
        .where(inArray(giftsAndPayments.id, allIds))
        .for("update");
      const byId = new Map(rows.map((r) => [r.id, r]));
      const primaryRow = byId.get(primaryId);
      if (!primaryRow) {
        return {
          ok: false,
          status: 400,
          json: { error: "validation_error", message: "primary gift not found" },
        };
      }
      const missing = loserIds.filter((id) => !byId.has(id));
      if (missing.length) {
        return {
          ok: false,
          status: 400,
          json: {
            error: "validation_error",
            message: `gift(s) not found: ${missing.join(", ")}`,
          },
        };
      }

      // Reject any already-archived participant. Losers are now ARCHIVED (not
      // hard-deleted), so without this guard a replayed request (double-click /
      // retry) would re-sum the still-present loser amounts onto the survivor,
      // and an archived coarse QB-derived gift (which Stripe reconciliation
      // archives precisely so its money never re-enters totals) could be
      // resurrected into a live survivor. Keeps the merge idempotent.
      const archived = allIds.filter((id) => byId.get(id)?.archivedAt != null);
      if (archived.length) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "archived_gift",
            message: `gift(s) already archived, cannot merge: ${archived.join(", ")}`,
          },
        };
      }

      // Donor XOR. When the selected gifts disagree on donor the caller MUST
      // resolve it explicitly — guessing is out of scope and a data-integrity
      // risk. Otherwise default to the survivor's own (locked) donor.
      const bodyDonorProvided =
        body.organizationId != null ||
        body.individualGiverPersonId != null ||
        body.householdId != null;
      if (!bodyDonorProvided && new Set(rows.map(donorKeyOf)).size > 1) {
        return {
          ok: false,
          status: 400,
          json: {
            error: "donor_resolution_required",
            message:
              "The selected gifts have different donors. Choose which donor the merged gift should use.",
          },
        };
      }
      const donor = bodyDonorProvided
        ? {
            organizationId: body.organizationId ?? null,
            individualGiverPersonId: body.individualGiverPersonId ?? null,
            householdId: body.householdId ?? null,
          }
        : {
            organizationId: primaryRow.organizationId,
            individualGiverPersonId: primaryRow.individualGiverPersonId,
            householdId: primaryRow.householdId,
          };
      const issues = validateGiftInvariants(donor);
      if (issues.length) return { ok: false, invariant: issues };

      // Absorb every loser's reconciled payment evidence — the QuickBooks
      // staged pointers, the Stripe/Donorbox pointers, the cash-application
      // ledger, and corroborating evidence links — onto the survivor. This runs
      // BEFORE any other write so a genuinely unrepresentable link shape (a
      // staged-payment split, or two+ Stripe/Donorbox charges landing on one
      // gift) 409s with a clean, no-op rollback instead of a half-applied merge.
      const absorb = await absorbGiftEvidenceIntoSurvivor(tx, primaryId, loserIds);
      if (absorb.collision) {
        const detail =
          absorb.collision.kind === "split_link"
            ? "a staged-payment split"
            : absorb.collision.kind === "stripe_charge"
              ? "two or more Stripe charges"
              : "two or more Donorbox donations";
        return {
          ok: false,
          status: 409,
          json: {
            error: "reconciled_evidence_conflict",
            conflict: absorb.collision.kind,
            message: `One of the duplicate gifts is linked to reconciled payment evidence that can't be combined automatically (${detail}). Resolve that link before merging.`,
          },
        };
      }

      // Sum amounts from the locked rows (numeric text; null → 0).
      const sum = rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
      const summedAmount = sum.toFixed(2);

      // Any pledge whose paid total changes — survivor's + every loser's pledge.
      const pledges = new Set<string>();
      for (const r of rows) if (r.opportunityId) pledges.add(r.opportunityId);

      // Move every loser's allocation rows onto the survivor.
      await tx
        .update(giftAllocations)
        .set({ giftId: primaryId, updatedAt: new Date() })
        .where(inArray(giftAllocations.giftId, loserIds));

      // Survivor absorbs the summed amount and the resolved donor.
      await tx
        .update(giftsAndPayments)
        .set({
          amount: summedAmount,
          organizationId: donor.organizationId,
          individualGiverPersonId: donor.individualGiverPersonId,
          householdId: donor.householdId,
          updatedAt: new Date(),
        })
        .where(eq(giftsAndPayments.id, primaryId));

      // Clear any gift_being_matched_id that points at a loser. On the old
      // hard-delete path the DB SET these NULL for us; losers are now archived
      // (soft-deleted), so we must clear the self-reference ourselves.
      await tx
        .update(giftsAndPayments)
        .set({ giftBeingMatchedId: null, updatedAt: new Date() })
        .where(inArray(giftsAndPayments.giftBeingMatchedId, loserIds));

      // Archive the losers (soft-delete — the app-wide default) instead of
      // hard-deleting: their reconciled payment evidence now lives on the
      // survivor and the archived tombstones preserve the merge lineage.
      await tx
        .update(giftsAndPayments)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(inArray(giftsAndPayments.id, loserIds));

      if (actor) {
        await tx.insert(bulkOperations).values({
          id: newId(),
          actorUserId: actor.id,
          entity: "gifts-and-payments/merge",
          fields: ["amount", "organizationId", "individualGiverPersonId", "householdId"],
          targetIds: allIds,
          succeededIds: allIds,
          failedIds: [],
        });
      }

      return { ok: true, pledges: [...pledges], donorOrgId: donor.organizationId };
    });

    if (!outcome.ok) {
      if ("invariant" in outcome) return respondInvariantFailure(res, outcome.invariant);
      res.status(outcome.status).json(outcome.json);
      return;
    }

    await applyDerivedOppFieldsMany(...outcome.pledges);
    // The survivor absorbs the losers' payment evidence and the losers are now
    // archived tombstones with none — recompute the tie status on all of them.
    await applyGiftQbTieMany(primaryId, ...loserIds);
    if (outcome.donorOrgId) enqueueDonorSignal({ organizationId: outcome.donorOrgId });
    res.json({ primaryId, mergedIds: loserIds });
  }),
);

/**
 * Attach several gifts to a pledge as its payments. With `pledgeId` the gifts
 * are attached to that existing pledge; without it a NEW fully-paid pledge is
 * created (donor XOR required — defaults to the first gift's donor) whose
 * awarded amount is the SUM of the gifts. The gifts are NOT deleted; each keeps
 * its own donor and gets `opportunityId` set. Derived pledge fields
 * (status/stage/paid totals) are recomputed afterward — status is never written
 * directly.
 */
router.post(
  "/gifts-and-payments/merge-into-pledge",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(MergeGiftsIntoPledgeBody, req.body, res);
    if (!body) return;

    // De-dupe gift ids.
    const seen = new Set<string>();
    const giftIds: string[] = [];
    for (const id of body.giftIds) {
      if (!seen.has(id)) {
        seen.add(id);
        giftIds.push(id);
      }
    }
    if (giftIds.length === 0) {
      res.status(400).json({ error: "validation_error", message: "giftIds must not be empty" });
      return;
    }

    const actor = getAppUser(req);

    type Outcome =
      | { ok: true; pledgeId: string; created: boolean; pledges: string[] }
      | { ok: false; status: number; json: Record<string, unknown> }
      | { ok: false; invariant: InvariantIssue[] };

    // Read + lock the gifts (and the target pledge, if any) inside the tx so
    // the sum, donor default, and existence checks reflect the committed state
    // and can't race a concurrent edit or pledge deletion.
    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const gifts = await tx
        .select()
        .from(giftsAndPayments)
        .where(inArray(giftsAndPayments.id, giftIds))
        .for("update");
      const foundIds = new Set(gifts.map((g) => g.id));
      const missing = giftIds.filter((id) => !foundIds.has(id));
      if (missing.length) {
        return {
          ok: false,
          status: 400,
          json: {
            error: "validation_error",
            message: `gift(s) not found: ${missing.join(", ")}`,
          },
        };
      }

      const sum = gifts.reduce((acc, g) => acc + Number(g.amount ?? 0), 0);
      const summedAmount = sum.toFixed(2);

      // Pledges whose paid total changes — the target plus any pledge the gifts
      // were previously attached to.
      const pledges = new Set<string>();
      for (const g of gifts) if (g.opportunityId) pledges.add(g.opportunityId);

      // A gift that already pays a DIFFERENT pledge must be surfaced, not
      // silently re-pointed (the pledge payment link is RESTRICT and moving it
      // would quietly alter another pledge's paid total). Gifts already on the
      // requested target pledge are an idempotent no-op re-attach and allowed;
      // for a NEW pledge (no body.pledgeId) any existing link conflicts.
      const alreadyLinked = gifts.filter(
        (g) => g.opportunityId != null && g.opportunityId !== body.pledgeId,
      );
      if (alreadyLinked.length) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "gift_already_on_pledge",
            message: `${alreadyLinked.length} selected gift(s) already pay a different pledge. Detach them from that pledge before merging.`,
          },
        };
      }

      let pledgeId: string;
      let created: boolean;

      if (body.pledgeId) {
        // Lock the target pledge so it can't be deleted mid-merge, and read its
        // donor so we can confirm every gift belongs to it.
        const pledge = await tx
          .select({
            id: opportunitiesAndPledges.id,
            organizationId: opportunitiesAndPledges.organizationId,
            individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
            householdId: opportunitiesAndPledges.householdId,
          })
          .from(opportunitiesAndPledges)
          .where(eq(opportunitiesAndPledges.id, body.pledgeId))
          .for("update")
          .then((r) => r[0]);
        if (!pledge) {
          return {
            ok: false,
            status: 409,
            json: { error: "pledge_not_found", message: "Target pledge not found." },
          };
        }
        // Every selected gift must belong to the pledge's donor — otherwise a
        // payment would be filed under the wrong donor. Existing-pledge attach
        // has no donor picker, so a mismatch is rejected (create a new pledge to
        // resolve mixed donors instead).
        const pledgeDonor = donorKeyOf(pledge);
        const mismatched = gifts.filter((g) => donorKeyOf(g) !== pledgeDonor);
        if (mismatched.length) {
          return {
            ok: false,
            status: 409,
            json: {
              error: "donor_mismatch",
              message:
                "The selected gift(s) don't all belong to this pledge's donor. Attach gifts from the same donor, or create a new pledge instead.",
            },
          };
        }
        pledgeId = pledge.id;
        created = false;
      } else {
        // New pledge — donor XOR. When the selected gifts disagree on donor the
        // caller MUST resolve it explicitly; otherwise default to the first
        // (locked) gift's donor.
        const bodyDonorProvided =
          body.organizationId != null ||
          body.individualGiverPersonId != null ||
          body.householdId != null;
        if (!bodyDonorProvided && new Set(gifts.map(donorKeyOf)).size > 1) {
          return {
            ok: false,
            status: 400,
            json: {
              error: "donor_resolution_required",
              message:
                "The selected gifts have different donors. Choose which donor the new pledge should use.",
            },
          };
        }
        const g0 = gifts[0];
        const donor = bodyDonorProvided
          ? {
              organizationId: body.organizationId ?? null,
              individualGiverPersonId: body.individualGiverPersonId ?? null,
              householdId: body.householdId ?? null,
            }
          : {
              organizationId: g0.organizationId,
              individualGiverPersonId: g0.individualGiverPersonId,
              householdId: g0.householdId,
            };
        const issues = validateOppInvariants(donor);
        if (issues.length) return { ok: false, invariant: issues };
        pledgeId = newId();
        created = true;

        await tx.insert(opportunitiesAndPledges).values({
          id: pledgeId,
          name: body.name ?? null,
          organizationId: donor.organizationId,
          individualGiverPersonId: donor.individualGiverPersonId,
          householdId: donor.householdId,
          awardedAmount: summedAmount,
          // Cultivation stage is a pure funnel now; the commitment outcome is the
          // writtenPledge latch. applyDerivedOppFieldsMany below advances stage to
          // `complete` (won) and derives status/paid — never written by hand.
          stage: "verbal_confirmation",
          writtenPledge: true,
          // Inherit loan-vs-grant from the source gift(s) so loan-fund money
          // doesn't create a grant pledge; if any source gift is loan the
          // pledge is loan. Keep the legacy fundraising_category in lockstep.
          fundraisingCategory: loanOrGrantToLegacyCategory(
            gifts.some((g) => g.loanOrGrant === "loan") ? "loan" : "grant",
          ),
          loanOrGrant: gifts.some((g) => g.loanOrGrant === "loan") ? "loan" : "grant",
        });
        // Minimal allocation so the pledge satisfies the "at least one
        // allocation" expectation; carries the full summed amount.
        await tx.insert(pledgeAllocations).values({
          id: newId(),
          pledgeOrOpportunityId: pledgeId,
          subAmount: summedAmount,
        });
      }
      pledges.add(pledgeId);

      await tx
        .update(giftsAndPayments)
        .set({ opportunityId: pledgeId, updatedAt: new Date() })
        .where(inArray(giftsAndPayments.id, giftIds));

      if (actor) {
        await tx.insert(bulkOperations).values({
          id: newId(),
          actorUserId: actor.id,
          entity: "gifts-and-payments/merge-into-pledge",
          fields: ["opportunityId"],
          targetIds: giftIds,
          succeededIds: giftIds,
          failedIds: [],
        });
      }

      return { ok: true, pledgeId, created, pledges: [...pledges] };
    });

    if (!outcome.ok) {
      if ("invariant" in outcome) return respondInvariantFailure(res, outcome.invariant);
      res.status(outcome.status).json(outcome.json);
      return;
    }

    await applyDerivedOppFieldsMany(...outcome.pledges);
    // Attaching gifts as pledge payments doesn't change their own QB linkage,
    // but recompute defensively in case allocation/amount shifted.
    await applyGiftQbTieMany(...giftIds);
    res.json({ pledgeId: outcome.pledgeId, giftIds, created: outcome.created });
  }),
);

/**
 * Split ONE multi-allocation gift into a pledge plus one payment-gift per
 * allocation. Motivating case: a single recorded gift that actually arrived as
 * several separate payments (e.g. a $100k commitment paid as two QBO payments,
 * each booked to a different allocation). Non-destructive: the original gift is
 * KEPT and becomes the payment for its FIRST allocation; a new gift is minted
 * for every remaining allocation and that allocation is re-pointed onto its new
 * gift. A pledge (awarded = gift amount, donor = gift donor, written_pledge = true)
 * is created and every payment-gift links to it via opportunityId. Derived
 * pledge fields are recomputed afterward — status is never written directly.
 *
 * Guards (all checked inside one tx; nothing changes unless every check passes):
 *   - gift exists and is not archived
 *   - gift has >= 2 allocations, each with a positive sub-amount
 *   - the sub-amounts sum to the gift amount to the cent (the money trail must
 *     be preserved exactly)
 *   - the gift does not already pay a pledge (409)
 *   - the gift is not linked to a QuickBooks staged payment (409) — splitting
 *     changes its amount and would falsify an approved reconciliation; the new
 *     payment-gifts intentionally carry no QB links
 */
router.post(
  "/gifts-and-payments/:id/split-into-pledge",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(SplitGiftIntoPledgeBody, req.body ?? {}, res);
    if (!body) return;

    const actor = getAppUser(req);

    type Outcome =
      | { ok: true; pledgeId: string; giftIds: string[]; donorOrgId: string | null }
      | { ok: false; status: number; json: Record<string, unknown> }
      | { ok: false; invariant: InvariantIssue[] };

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // Lock the gift so its amount + allocation set can't race a concurrent edit.
      const [gift] = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, id))
        .for("update");
      if (!gift) {
        return { ok: false, status: 404, json: { error: "not_found", message: "Gift not found." } };
      }
      if (gift.archivedAt != null) {
        return {
          ok: false,
          status: 409,
          json: { error: "gift_archived", message: "Restore this gift before splitting it." },
        };
      }
      if (gift.opportunityId != null) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "gift_already_on_pledge",
            message: "This gift already pays a pledge. Detach it before splitting.",
          },
        };
      }

      // A gift wired into a QuickBooks staged payment must be unlinked first —
      // splitting changes its amount and would falsify an approved
      // reconciliation. New payment-gifts intentionally carry no QB links.
      // The counted QB ledger unifies direct + split + group links, so one
      // existence check covers every link shape (the legacy staged gift-link
      // columns are @deprecated and no longer written).
      const qbLedgerLink = await tx
        .select({ id: paymentApplications.id })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.giftId, id),
            eq(paymentApplications.evidenceSource, "quickbooks"),
            eq(paymentApplications.linkRole, "counted"),
          ),
        )
        .limit(1);
      if (qbLedgerLink.length) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "quickbooks_linked",
            message:
              "This gift is linked to a QuickBooks staged payment. Resolve that link before splitting.",
          },
        };
      }

      // Money-trail line items, ordered deterministically: the first stays on
      // the original gift, the rest each spawn a new payment-gift. Lock the
      // allocation rows too (not just the parent gift) so a concurrent edit to
      // an allocation's sub-amount can't slip between this sum check and the
      // re-point below and leave a gift header out of step with its allocation.
      const allocs = await tx
        .select()
        .from(giftAllocations)
        .where(eq(giftAllocations.giftId, id))
        .orderBy(asc(giftAllocations.id))
        .for("update");
      if (allocs.length < 2) {
        return {
          ok: false,
          status: 400,
          json: {
            error: "not_enough_allocations",
            message: "A gift needs at least two allocations to split into a pledge.",
          },
        };
      }

      // Cents-based arithmetic so float drift never breaks the reconciliation.
      const toCents = (v: string | null): number => Math.round(Number(v ?? 0) * 100);
      const giftCents = toCents(gift.amount);
      let allocCents = 0;
      for (const a of allocs) {
        const c = toCents(a.subAmount);
        if (c <= 0) {
          return {
            ok: false,
            status: 400,
            json: {
              error: "nonpositive_allocation",
              message: "Every allocation must have a positive amount to split.",
            },
          };
        }
        allocCents += c;
      }
      if (allocCents !== giftCents) {
        return {
          ok: false,
          status: 400,
          json: {
            error: "allocation_sum_mismatch",
            message:
              "The allocation amounts must add up to the gift amount before it can be split. Fix the allocations first.",
          },
        };
      }

      // Donor (XOR) carried by the gift — reused for the pledge and every
      // payment-gift. Belt-and-suspenders validate before writing anything.
      const donor = {
        organizationId: gift.organizationId,
        individualGiverPersonId: gift.individualGiverPersonId,
        householdId: gift.householdId,
      };
      const oppIssues = validateOppInvariants(donor);
      if (oppIssues.length) return { ok: false, invariant: oppIssues };

      // 1. Create the pledge: awarded = gift amount, donor inherited.
      const pledgeId = newId();
      await tx.insert(opportunitiesAndPledges).values({
        id: pledgeId,
        name: body.name ?? gift.name ?? null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        awardedAmount: gift.amount,
        // Cultivation stage is a pure funnel now; the commitment outcome is the
        // writtenPledge latch. Derived fields (status/stage→complete/paid) are
        // recomputed afterward — never written by hand (invariant #3).
        stage: "verbal_confirmation",
        writtenPledge: true,
        // Inherit loan-vs-grant from the source gift so a loan-fund gift
        // doesn't create a grant pledge; keep legacy fundraising_category in
        // lockstep with the authoritative flag.
        fundraisingCategory: loanOrGrantToLegacyCategory(gift.loanOrGrant),
        loanOrGrant: gift.loanOrGrant,
      });

      // 2. Mirror each gift allocation onto a pledge allocation. The gifts are
      // immediately canonical, so the pledge allocations are flagged
      // superseded_by_gift (the pledge derives cash_in from the payment-gifts).
      // pledge_allocations collapse the two gift-level restriction booleans into
      // one and have no school column (directToSchool stands in for it).
      for (const a of allocs) {
        await tx.insert(pledgeAllocations).values({
          id: newId(),
          pledgeOrOpportunityId: pledgeId,
          subAmount: a.subAmount,
          grantYear: a.grantYear,
          entityId: a.entityId,
          intendedUsage: a.intendedUsage,
          fundableProjectId: a.fundableProjectId,
          regionIds: a.regionIds,
          directToSchool: a.schoolRecipientId != null,
          // Carry the 3-axis restriction coding across the gift→pledge split so
          // the pledge allocation keeps the same restriction picture (Task #449).
          regionalRestrictionType: a.regionalRestrictionType,
          usageRestrictionType: a.usageRestrictionType,
          timeRestrictionType: a.timeRestrictionType,
          // Carry the direct/indirect reimbursement tag onto the pledge allocation
          // so the goal-analytics exclusion survives a gift→pledge split.
          reimbursementType: a.reimbursementType,
          status: "superseded_by_gift",
        });
      }

      // 3. Transform-in-place. The original gift becomes the payment for the
      // FIRST allocation; mint a new gift for each remaining allocation and
      // re-point that allocation onto it. The grant year follows the allocation;
      // off-books is now derived from the allocation entity, which is re-pointed
      // onto the new gift below, so it carries over automatically (no header flag
      // to copy). Thank-you / QB / Airtable / archive metadata stays only on the
      // original.
      const [first, ...rest] = allocs;
      const giftIds: string[] = [gift.id];

      await tx
        .update(giftsAndPayments)
        .set({
          amount: first.subAmount,
          opportunityId: pledgeId,
          updatedAt: new Date(),
        })
        .where(eq(giftsAndPayments.id, gift.id));

      for (const a of rest) {
        const newGiftId = newId();
        await tx.insert(giftsAndPayments).values({
          id: newGiftId,
          name: gift.name,
          details: gift.details,
          dateReceived: gift.dateReceived,
          paymentMethod: gift.paymentMethod,
          amount: a.subAmount,
          organizationId: gift.organizationId,
          individualGiverPersonId: gift.individualGiverPersonId,
          householdId: gift.householdId,
          type: gift.type,
          // Carry the authoritative loan_or_grant flag onto every split row so
          // it isn't silently reset to the column default.
          loanOrGrant: gift.loanOrGrant,
          opportunityId: pledgeId,
          advisorPersonId: gift.advisorPersonId,
          primaryContactPersonId: gift.primaryContactPersonId,
          paymentIntermediaryId: gift.paymentIntermediaryId,
          ownerUserId: gift.ownerUserId,
          tags: gift.tags,
        });
        // Re-point the allocation (a money-trail row — keep its id) onto the new
        // gift. Never touch display_usage (trigger-maintained).
        await tx
          .update(giftAllocations)
          .set({ giftId: newGiftId, updatedAt: new Date() })
          .where(eq(giftAllocations.id, a.id));
        giftIds.push(newGiftId);
      }

      if (actor) {
        await tx.insert(bulkOperations).values({
          id: newId(),
          actorUserId: actor.id,
          entity: "gifts-and-payments/split-into-pledge",
          fields: ["amount", "opportunityId"],
          targetIds: [gift.id],
          succeededIds: giftIds,
          failedIds: [],
        });
      }

      return { ok: true, pledgeId, giftIds, donorOrgId: donor.organizationId };
    });

    if (!outcome.ok) {
      if ("invariant" in outcome) return respondInvariantFailure(res, outcome.invariant);
      res.status(outcome.status).json(outcome.json);
      return;
    }

    await applyDerivedOppFieldsMany(outcome.pledgeId);
    // The split mints new payment-gifts and re-points the original — recompute
    // the QB tie for every resulting gift (new ones default to 'missing').
    await applyGiftQbTieMany(...outcome.giftIds);
    if (outcome.donorOrgId) enqueueDonorSignal({ organizationId: outcome.donorOrgId });
    res.json({ pledgeId: outcome.pledgeId, giftIds: outcome.giftIds, created: true });
  }),
);

// ──────────────────────────────────────────────────────────────────
// Revert a recorded gift back into a pipeline opportunity (or a pledge)
// ──────────────────────────────────────────────────────────────────
// Treats the gift as money that did NOT actually land. Unlike split-into-pledge
// (which keeps the gift as a payment), this mints a fresh opportunity from the
// gift, mirrors its allocations onto pledge_allocations, and ARCHIVES the gift
// (non-destructive). asPledge=true → a written PLEDGE; false → an open
// opportunity back in the pipeline. Derived opp fields recomputed afterward.
router.post(
  "/gifts-and-payments/:id/revert-to-opportunity",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(RevertGiftToOpportunityBody, req.body ?? {}, res);
    if (!body) return;
    const asPledge = body.asPledge ?? false;

    const actor = getAppUser(req);

    type Outcome =
      | { ok: true; opportunityId: string; donorOrgId: string | null }
      | { ok: false; status: number; json: Record<string, unknown> }
      | { ok: false; invariant: InvariantIssue[] };

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // Lock the gift so its allocation set can't race a concurrent edit.
      const [gift] = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, id))
        .for("update");
      if (!gift) {
        return { ok: false, status: 404, json: { error: "not_found", message: "Gift not found." } };
      }
      if (gift.archivedAt != null) {
        return {
          ok: false,
          status: 409,
          json: { error: "gift_archived", message: "Restore this gift before reverting it." },
        };
      }
      if (gift.opportunityId != null) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "gift_already_on_pledge",
            message: "This gift already pays a pledge. Detach it before reverting.",
          },
        };
      }

      // A gift wired into a QuickBooks staged payment must be unlinked first —
      // reverting archives it and would falsify an approved reconciliation.
      // The counted QB ledger unifies direct + split + group links, so one
      // existence check covers every link shape (the legacy staged gift-link
      // columns are @deprecated and no longer written).
      const qbLedgerLink = await tx
        .select({ id: paymentApplications.id })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.giftId, id),
            eq(paymentApplications.evidenceSource, "quickbooks"),
            eq(paymentApplications.linkRole, "counted"),
          ),
        )
        .limit(1);
      if (qbLedgerLink.length) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "quickbooks_linked",
            message:
              "This gift is linked to a QuickBooks staged payment. Resolve that link before reverting.",
          },
        };
      }

      // Lock the allocation rows too so a concurrent edit can't slip between the
      // read and the mirror+archive below.
      const allocs = await tx
        .select()
        .from(giftAllocations)
        .where(eq(giftAllocations.giftId, id))
        .orderBy(asc(giftAllocations.id))
        .for("update");

      // Donor (XOR) carried by the gift — reused for the new opportunity.
      const donor = {
        organizationId: gift.organizationId,
        individualGiverPersonId: gift.individualGiverPersonId,
        householdId: gift.householdId,
      };
      const oppIssues = validateOppInvariants(donor);
      if (oppIssues.length) return { ok: false, invariant: oppIssues };

      // 1. Mint the opportunity / pledge. Awarded = gift amount, donor inherited.
      // Cultivation stage is a pure funnel; the commitment outcome is the
      // writtenPledge latch. Derived fields (status/stage) are recomputed
      // afterward — never written by hand (invariant #3).
      const opportunityId = newId();
      await tx.insert(opportunitiesAndPledges).values({
        id: opportunityId,
        name: body.name ?? gift.name ?? null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        awardedAmount: gift.amount,
        stage: asPledge ? "verbal_confirmation" : "in_conversation",
        writtenPledge: asPledge,
        // Inherit loan-vs-grant from the source gift; keep legacy
        // fundraising_category in lockstep with the authoritative flag.
        fundraisingCategory: loanOrGrantToLegacyCategory(gift.loanOrGrant),
        loanOrGrant: gift.loanOrGrant,
      });

      // 2. Mirror each gift allocation onto a pledge allocation. The gift is
      // archived (money did not land), so these are genuine active commitments
      // (status left at default, like a normally-created pledge). pledge_allocations
      // collapse the gift's school column into directToSchool.
      for (const a of allocs) {
        await tx.insert(pledgeAllocations).values({
          id: newId(),
          pledgeOrOpportunityId: opportunityId,
          subAmount: a.subAmount,
          grantYear: a.grantYear,
          entityId: a.entityId,
          intendedUsage: a.intendedUsage,
          fundableProjectId: a.fundableProjectId,
          regionIds: a.regionIds,
          directToSchool: a.schoolRecipientId != null,
          regionalRestrictionType: a.regionalRestrictionType,
          usageRestrictionType: a.usageRestrictionType,
          timeRestrictionType: a.timeRestrictionType,
          reimbursementType: a.reimbursementType,
        });
      }

      // 3. Archive the source gift (non-destructive — the gift and its
      // allocations are retained, soft-deleted).
      await tx
        .update(giftsAndPayments)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(giftsAndPayments.id, id));

      if (actor) {
        await tx.insert(bulkOperations).values({
          id: newId(),
          actorUserId: actor.id,
          entity: "gifts-and-payments/revert-to-opportunity",
          fields: ["archivedAt"],
          targetIds: [id],
          succeededIds: [id],
          failedIds: [],
        });
      }

      return { ok: true, opportunityId, donorOrgId: donor.organizationId };
    });

    if (!outcome.ok) {
      if ("invariant" in outcome) return respondInvariantFailure(res, outcome.invariant);
      res.status(outcome.status).json(outcome.json);
      return;
    }

    // Recompute the new opportunity's derived status/stage (never written by hand).
    await applyDerivedOppFieldsMany(outcome.opportunityId);
    // The source gift is now archived; recompute its QB tie so it drops out of
    // the on-books reconciliation surfaces.
    await applyGiftQbTieMany(id);
    if (outcome.donorOrgId) enqueueDonorSignal({ organizationId: outcome.donorOrgId });
    res.json({ opportunityId: outcome.opportunityId, asPledge });
  }),
);

// ──────────────────────────────────────────────────────────────────
// Thank-you email linking
// ──────────────────────────────────────────────────────────────────

/**
 * Document mime check duplicated here from emailIntelligence.ts to
 * keep the routes module decoupled from the intel pipeline. Kept in
 * sync intentionally — both serve the same heuristic.
 */
function isDocumentMime(mime: string | null): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (m === "application/pdf") return true;
  if (m === "application/rtf" || m === "text/rtf") return true;
  if (m === "application/msword") return true;
  if (m === "application/vnd.ms-excel") return true;
  if (m === "application/vnd.ms-powerpoint") return true;
  if (m.startsWith("application/vnd.openxmlformats-officedocument")) return true;
  if (m.startsWith("application/vnd.oasis.opendocument")) return true;
  return false;
}

router.get(
  "/gifts-and-payments/:id/candidate-thank-you-emails",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const id = paramId(req);
    const gift = await db
      .select({
        id: giftsAndPayments.id,
        organizationId: giftsAndPayments.organizationId,
        dateReceived: giftsAndPayments.dateReceived,
      })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // Only organization-attached gifts have an obvious "thank the organization"
    // contact set. Household/individual gifts can use the manual link
    // path against the user's own search; we don't enumerate
    // candidates for them.
    if (!gift.organizationId || !gift.dateReceived) {
      return res.json({ data: [] });
    }

    // 90-day window centered loosely on dateReceived — the auto-suggest
    // heuristic uses 30 days, but the picker is wider so the reviewer
    // can grab a delayed send-out if needed.
    const giftDate = new Date(`${gift.dateReceived}T00:00:00Z`);
    const winStart = new Date(giftDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    const winEnd = new Date(giftDate.getTime() + 90 * 24 * 60 * 60 * 1000);

    // Resolve organization contacts: any email row of a person currently in a
    // people_entity_role for this organization.
    const contactRows = await db
      .selectDistinct({ email: sql<string>`lower(${emails.email})` })
      .from(emails)
      .innerJoin(peopleEntityRoles, and(
        eq(peopleEntityRoles.personId, emails.personId),
        eq(peopleEntityRoles.current, "current"),
        eq(peopleEntityRoles.organizationId, gift.organizationId!),
      ));
    const contactEmails = contactRows.map((r) => r.email).filter(Boolean);
    if (contactEmails.length === 0) return res.json({ data: [] });

    // Pull recent outbound mail from this mailbox to any of those
    // contacts. We over-fetch and filter in JS because Postgres array
    // overlap on toEmails would skip case-insensitive matching.
    const rows = await db
      .select({
        id: emailMessages.id,
        gmailMessageId: emailMessages.gmailMessageId,
        subject: emailMessages.subject,
        fromEmail: emailMessages.fromEmail,
        toEmails: emailMessages.toEmails,
        sentAt: emailMessages.sentAt,
        snippet: emailMessages.snippet,
      })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.mailboxUserId, user.id),
        eq(emailMessages.direction, "sent"),
        gte(emailMessages.sentAt, winStart),
        lte(emailMessages.sentAt, winEnd),
      ))
      .orderBy(desc(emailMessages.sentAt))
      .limit(200);

    const contactSet = new Set(contactEmails);
    const matching = rows.filter((r) =>
      (r.toEmails ?? []).some((t) => t && contactSet.has(t.toLowerCase())),
    );
    if (matching.length === 0) return res.json({ data: [] });

    // Annotate each with its document-attachment count in one query.
    const msgIds = matching.map((m) => m.id);
    const atts = await db
      .select({
        emailMessageId: emailAttachments.emailMessageId,
        mimeType: emailAttachments.mimeType,
      })
      .from(emailAttachments)
      .where(inArray(emailAttachments.emailMessageId, msgIds));
    const docCountByMsg = new Map<string, number>();
    for (const a of atts) {
      if (isDocumentMime(a.mimeType)) {
        docCountByMsg.set(a.emailMessageId, (docCountByMsg.get(a.emailMessageId) ?? 0) + 1);
      }
    }

    const data = matching.map((m) => {
      const docCount = docCountByMsg.get(m.id) ?? 0;
      const subjectMatch = !!m.subject && /\bthank/i.test(m.subject);
      const dateMatch = gift.dateReceived
        ? Math.abs(m.sentAt.getTime() - giftDate.getTime()) <= 30 * 24 * 60 * 60 * 1000
        : false;
      return {
        emailMessageId: m.id,
        gmailMessageId: m.gmailMessageId,
        subject: m.subject,
        fromEmail: m.fromEmail,
        toEmails: m.toEmails,
        sentAt: m.sentAt.toISOString(),
        snippet: m.snippet,
        hasDocumentAttachment: docCount > 0,
        documentAttachmentCount: docCount,
        autoSuggested: docCount > 0 && subjectMatch && dateMatch,
      };
    });
    res.json({ data });
  }),
);

router.post(
  "/gifts-and-payments/:id/link-thank-you-email",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const id = paramId(req);
    const body = (req.body ?? {}) as { emailMessageId?: unknown };
    if (typeof body.emailMessageId !== "string" || !body.emailMessageId) {
      return res.status(400).json({
        error: "validation_error",
        message: "emailMessageId is required.",
      });
    }
    const emailMessageId = body.emailMessageId;
    // Scope the message lookup to the caller's mailbox so a user can't
    // link an arbitrary message-id they happen to know.
    const msg = await db
      .select({ id: emailMessages.id, sentAt: emailMessages.sentAt })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.id, emailMessageId),
        eq(emailMessages.mailboxUserId, user.id),
      ))
      .then((r) => r[0]);
    if (!msg) return notFound(res, "email message");

    // Marking an email as the acknowledgement also captures a DURABLE copy of
    // its first document attachment onto the gift (thankYouLetter*), so the
    // acknowledgement file survives an eventual email purge. We only overwrite
    // the gift's letter when the linked email actually has a document
    // attachment — linking an attachment-less email leaves any existing
    // manually-uploaded letter untouched.
    const docAtt = await db
      .select({
        filename: emailAttachments.filename,
        mimeType: emailAttachments.mimeType,
        storageKey: emailAttachments.storageKey,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, msg.id))
      .then((rows) => rows.find((a) => isDocumentMime(a.mimeType)) ?? null);

    let letterFields: {
      thankYouLetterUrl: string;
      thankYouLetterFilename: string | null;
      thankYouLetterUploadedAt: string;
    } | null = null;
    if (docAtt?.storageKey) {
      try {
        const objectPath = await new ObjectStorageService().copyObjectToUploads(
          docAtt.storageKey,
        );
        letterFields = {
          thankYouLetterUrl: `/api/storage${objectPath}`,
          thankYouLetterFilename: docAtt.filename ?? "acknowledgement",
          thankYouLetterUploadedAt: new Date().toISOString(),
        };
      } catch (err) {
        // A copy failure must not block linking the pointer — log and continue.
        req.log.error(
          { err, giftId: id, emailMessageId: msg.id },
          "Failed to copy thank-you attachment onto gift",
        );
      }
    }

    const [updated] = await db
      .update(giftsAndPayments)
      .set({
        thankYouSentAt: msg.sentAt.toISOString().slice(0, 10),
        thankYouEmailMessageId: msg.id,
        ...(letterFields ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(giftsAndPayments.id, id))
      .returning();
    if (!updated) return notFound(res, "gift");
    const detail = await buildGiftDetail(id, getViewer(req));
    if (!detail) return notFound(res, "gift");
    return res.json(detail);
  }),
);

router.delete(
  "/gifts-and-payments/:id/link-thank-you-email",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const [updated] = await db
      .update(giftsAndPayments)
      .set({
        thankYouSentAt: null,
        thankYouEmailMessageId: null,
        updatedAt: new Date(),
      })
      .where(eq(giftsAndPayments.id, id))
      .returning({ id: giftsAndPayments.id });
    if (!updated) return notFound(res, "gift");
    res.status(204).end();
  }),
);

// ─── GET /gifts-and-payments/:id/stripe-chain ──────────────────────────────
// Read-only audit provenance for a gift: the Stripe charge it was minted from
// (or linked to) → the Stripe payout that charge settled in → the QuickBooks
// deposit lump that payout reconciles against. Returns a null leg for anything
// that doesn't apply (a non-Stripe gift, a charge not yet paid out, or a payout
// with no QB deposit candidate) so the UI can render the chain progressively.
router.get(
  "/gifts-and-payments/:id/stripe-chain",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const gift = await db
      .select({ id: giftsAndPayments.id })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // A gift is at most one charge's created_gift_id and at most one charge's
    // matched_gift_id (unique partial indexes). Prefer the "created" row — this
    // gift was minted from that charge — over a "matched" linkage.
    const row = await db
      .select({
        chargeId: stripeStagedCharges.id,
        chargeCreatedGiftId: stripeStagedCharges.createdGiftId,
        chargeGross: stripeStagedCharges.grossAmount,
        chargeFee: stripeStagedCharges.feeAmount,
        chargeNet: stripeStagedCharges.netAmount,
        chargeDate: stripeStagedCharges.dateReceived,
        chargePayer: stripeStagedCharges.payerName,
        chargeCurrency: stripeStagedCharges.currency,
        payoutId: stripePayouts.id,
        payoutAmount: stripePayouts.amount,
        payoutArrival: stripePayouts.arrivalDate,
        payoutGross: stripePayouts.grossTotal,
        payoutFee: stripePayouts.feeTotal,
        payoutNet: stripePayouts.netTotal,
        payoutChargeCount: stripePayouts.chargeCount,
        // Reconciliation status is DERIVED from the authoritative settlement
        // link (payoutStatusFromLink), never the deprecated mirror column.
        linkLifecycle: settlementLinks.lifecycle,
        linkConflictGiftId: settlementLinks.conflictGiftId,
        depositId: stagedPayments.id,
        depositAmount: stagedPayments.amount,
        depositDate: stagedPayments.dateReceived,
        depositPayer: stagedPayments.payerName,
        // DERIVED deposit status (no stored column) — NULL when the LEFT JOIN
        // found no deposit row (the CASE would otherwise read all-NULL facts
        // as a real status).
        depositStatus: sql<
          string | null
        >`CASE WHEN ${stagedPayments.id} IS NULL THEN NULL ELSE ${stagedStatusSql} END`.as(
          "deposit_status",
        ),
      })
      .from(stripeStagedCharges)
      .leftJoin(
        stripePayouts,
        eq(stripePayouts.id, stripeStagedCharges.stripePayoutId),
      )
      // Payout↔deposit tie now reads from the authoritative settlement_links row
      // (single `deposit_staged_payment_id`), not the legacy pointer columns.
      .leftJoin(
        settlementLinks,
        eq(settlementLinks.payoutId, stripePayouts.id),
      )
      .leftJoin(
        stagedPayments,
        eq(stagedPayments.id, settlementLinks.depositStagedPaymentId),
      )
      .where(
        or(
          eq(stripeStagedCharges.createdGiftId, id),
          eq(stripeStagedCharges.matchedGiftId, id),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${stripeStagedCharges.createdGiftId} = ${id} THEN 0 ELSE 1 END`,
      )
      .limit(1)
      .then((r) => r[0]);

    return res.json({
      giftId: id,
      charge: row?.chargeId
        ? {
            id: row.chargeId,
            linkage: row.chargeCreatedGiftId === id ? "created" : "matched",
            grossAmount: row.chargeGross,
            feeAmount: row.chargeFee,
            netAmount: row.chargeNet,
            dateReceived: row.chargeDate,
            payerName: row.chargePayer,
            currency: row.chargeCurrency,
          }
        : null,
      payout: row?.payoutId
        ? {
            id: row.payoutId,
            amount: row.payoutAmount,
            arrivalDate: row.payoutArrival,
            grossTotal: row.payoutGross,
            feeTotal: row.payoutFee,
            netTotal: row.payoutNet,
            chargeCount: row.payoutChargeCount,
            reconciliationStatus: payoutStatusFromLink(
              row.linkLifecycle
                ? {
                    lifecycle: row.linkLifecycle,
                    conflictGiftId: row.linkConflictGiftId,
                  }
                : null,
            ),
          }
        : null,
      qbDeposit: row?.depositId
        ? {
            id: row.depositId,
            amount: row.depositAmount,
            dateReceived: row.depositDate,
            payerName: row.depositPayer,
            status: row.depositStatus,
          }
        : null,
    });
  }),
);

// ─── GET /gifts-and-payments/:id/audit-reconciliation ──────────────────────
// Per-gift audit view (INV-10): when the money arrived, the QuickBooks
// record(s) it appears in ("where"), who gave it, and its restrictions.
// Off-books gifts (exempt) are flagged `auditExcluded` and carry no QB
// expectation — they're outside the audit reconciliation by design.
router.get(
  "/gifts-and-payments/:id/audit-reconciliation",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const gift = await db
      .select({
        id: giftsAndPayments.id,
        name: giftsAndPayments.name,
        amount: giftsAndPayments.amount,
        dateReceived: giftsAndPayments.dateReceived,
        quickbooksTieStatus: giftsAndPayments.quickbooksTieStatus,
        // Off-books is derived ONLY from allocation entities (a gift is off-books
        // when every allocation sits on a no-payment entity) — no header flags.
        offBooks: giftIsOffBooksExpr(),
        organizationId: giftsAndPayments.organizationId,
        individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
        householdId: giftsAndPayments.householdId,
      })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // Off-books gifts (exempt) are excluded from audit reconciliation by
    // design: they carry no QB expectation, so we return early with the
    // exclusion flag and no audit trail (no donor / QB records / restrictions).
    if (gift.offBooks) {
      return res.json({
        giftId: gift.id,
        name: gift.name,
        quickbooksTieStatus: gift.quickbooksTieStatus,
        reconciliationLanes: deriveGiftLanes(gift.quickbooksTieStatus),
        offBooks: true,
        auditExcluded: true,
        amount: gift.amount,
        dateReceived: gift.dateReceived,
        donor: null,
        quickbooksRecords: [],
        corroboratingRecords: [],
        restrictions: [],
      });
    }

    // WHO — resolve the single donor (Donor XOR) to a {kind,id,name}.
    let donor: { kind: string; id: string; name: string | null } | null = null;
    if (gift.organizationId) {
      const name = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, gift.organizationId))
        .then((r) => r[0]?.name ?? null);
      donor = { kind: "organization", id: gift.organizationId, name };
    } else if (gift.individualGiverPersonId) {
      const name = await db
        .select({
          name: sql<string | null>`COALESCE(
            NULLIF(TRIM(${people.fullName}), ''),
            NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
          )`,
        })
        .from(people)
        .where(eq(people.id, gift.individualGiverPersonId))
        .then((r) => r[0]?.name ?? null);
      donor = { kind: "individual", id: gift.individualGiverPersonId, name };
    } else if (gift.householdId) {
      const name = await db
        .select({ name: households.name })
        .from(households)
        .where(eq(households.id, gift.householdId))
        .then((r) => r[0]?.name ?? null);
      donor = { kind: "household", id: gift.householdId, name };
    }

    // WHERE — the QuickBooks staged record(s) this gift ties to, sourced from the
    // authoritative cash-application ledger (payment_applications): one row per QB
    // payment applied to this gift, `amount` = the applied amount (the split
    // sub-amount for split rows, the full staged amount for direct/group rows).
    // The staged_payments join supplies the QB record detail; the cosmetic
    // linkType label is derived from the ledger itself (the legacy staged
    // gift-link columns are @deprecated and no longer written): a payment
    // whose counted rows fan out to >1 application is a split; a payment in a
    // QuickBooks unit group booked its gift through the group; created comes
    // straight from created_the_gift. Off-books gifts may still surface
    // evidence if any exists, but it isn't required of them.
    const ledgerRows = await db
      .select({
        stagedPaymentId: paymentApplications.paymentId,
        amountApplied: paymentApplications.amountApplied,
        createdTheGift: paymentApplications.createdTheGift,
        realmId: stagedPayments.realmId,
        qbEntityType: stagedPayments.qbEntityType,
        qbEntityId: stagedPayments.qbEntityId,
        qbDocNumber: stagedPayments.qbDocNumber,
        qbDepositToAccountName: stagedPayments.qbDepositToAccountName,
        qbPaymentMethod: stagedPayments.qbPaymentMethod,
        payerName: stagedPayments.payerName,
        dateReceived: stagedPayments.dateReceived,
        isGroupMember: sql<boolean>`EXISTS (
          SELECT 1 FROM unit_group_members ugm
          WHERE ugm.evidence_source = 'quickbooks'
            AND ugm.source_id = ${paymentApplications.paymentId}
        )`,
        countedAppCount: sql<number>`(
          SELECT COUNT(*)::int FROM payment_applications pa2
          WHERE pa2.payment_id = ${paymentApplications.paymentId}
            AND pa2.evidence_source = 'quickbooks'
            AND pa2.link_role = 'counted'
        )`,
      })
      .from(paymentApplications)
      .innerJoin(
        stagedPayments,
        eq(stagedPayments.id, paymentApplications.paymentId),
      )
      .where(
        and(
          eq(paymentApplications.giftId, id),
          eq(paymentApplications.evidenceSource, "quickbooks"),
          // Money-trail display only — corroborating rows (Phase 5) never appear here.
          eq(paymentApplications.linkRole, "counted"),
        ),
      );

    const quickbooksRecords = ledgerRows.map((r) => ({
      stagedPaymentId: r.stagedPaymentId,
      linkType: (r.countedAppCount > 1
        ? "split"
        : r.createdTheGift
          ? "created"
          : r.isGroupMember
            ? "group"
            : "matched") as "matched" | "created" | "group" | "split",
      realmId: r.realmId,
      qbEntityType: r.qbEntityType,
      qbEntityId: r.qbEntityId,
      qbDocNumber: r.qbDocNumber,
      qbDepositToAccountName: r.qbDepositToAccountName,
      qbPaymentMethod: r.qbPaymentMethod,
      payerName: r.payerName,
      amount: r.amountApplied ?? "0",
      dateReceived: r.dateReceived,
    }));

    // CORROBORATING — non-counting QB evidence rows (link_role='corroborating',
    // e.g. a coarse deposit line that corroborates a Stripe-settled gift). These
    // are audit-only and MUST NOT be summed into the money trail, so amount is
    // always null (mirrors payment_applications.amount_applied being null there).
    const corroboratingRows = await db
      .select({
        stagedPaymentId: paymentApplications.paymentId,
        createdTheGift: paymentApplications.createdTheGift,
        realmId: stagedPayments.realmId,
        qbEntityType: stagedPayments.qbEntityType,
        qbEntityId: stagedPayments.qbEntityId,
        qbDocNumber: stagedPayments.qbDocNumber,
        qbDepositToAccountName: stagedPayments.qbDepositToAccountName,
        qbPaymentMethod: stagedPayments.qbPaymentMethod,
        payerName: stagedPayments.payerName,
        dateReceived: stagedPayments.dateReceived,
        isGroupMember: sql<boolean>`EXISTS (
          SELECT 1 FROM unit_group_members ugm
          WHERE ugm.evidence_source = 'quickbooks'
            AND ugm.source_id = ${paymentApplications.paymentId}
        )`,
      })
      .from(paymentApplications)
      .innerJoin(
        stagedPayments,
        eq(stagedPayments.id, paymentApplications.paymentId),
      )
      .where(
        and(
          eq(paymentApplications.giftId, id),
          eq(paymentApplications.evidenceSource, "quickbooks"),
          eq(paymentApplications.linkRole, "corroborating"),
        ),
      );

    // A corroborating row is never how a split books (splits write counted
    // rows), so its label needs no split branch — matched/created/group only.
    const corroboratingRecords = corroboratingRows.map((r) => ({
      stagedPaymentId: r.stagedPaymentId,
      linkType: (r.createdTheGift
        ? "created"
        : r.isGroupMember
          ? "group"
          : "matched") as "matched" | "created" | "group" | "split",
      realmId: r.realmId,
      qbEntityType: r.qbEntityType,
      qbEntityId: r.qbEntityId,
      qbDocNumber: r.qbDocNumber,
      qbDepositToAccountName: r.qbDepositToAccountName,
      qbPaymentMethod: r.qbPaymentMethod,
      payerName: r.payerName,
      amount: null,
      dateReceived: r.dateReceived,
    }));

    // RESTRICTIONS — the per-allocation restriction coding under this gift.
    const restrictions = await db
      .select({
        allocationId: giftAllocations.id,
        regionalRestrictionType: giftAllocations.regionalRestrictionType,
        usageRestrictionType: giftAllocations.usageRestrictionType,
        timeRestrictionType: giftAllocations.timeRestrictionType,
        purposeVerbatim: giftAllocations.purposeVerbatim,
        subAmount: giftAllocations.subAmount,
        displayUsage: giftAllocations.displayUsage,
      })
      .from(giftAllocations)
      .where(eq(giftAllocations.giftId, id));

    return res.json({
      giftId: gift.id,
      name: gift.name,
      quickbooksTieStatus: gift.quickbooksTieStatus,
      reconciliationLanes: deriveGiftLanes(gift.quickbooksTieStatus),
      offBooks: gift.offBooks,
      auditExcluded: gift.offBooks,
      amount: gift.amount,
      dateReceived: gift.dateReceived,
      donor,
      quickbooksRecords,
      corroboratingRecords,
      restrictions,
    });
  }),
);

export default router;
