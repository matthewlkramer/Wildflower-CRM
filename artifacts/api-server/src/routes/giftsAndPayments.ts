import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { enqueueDonorSignal } from "../lib/taskSuggestionQueue";
import {
  giftsAndPayments,
  giftAllocations,
  stagedPaymentSplits,
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
const donorJoinSelect = {
  ...getTableColumns(giftsAndPayments),
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
  validateGiftInvariants,
  validateOppInvariants,
  giftTypeToLoanOrGrant,
  loanOrGrantToLegacyCategory,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { auditCreate, auditUpdate } from "../lib/audit";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { activeOnlyUnlessAdmin, archiveOne, executeBulkArchive, unarchiveOne } from "../lib/archive";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { applyGiftQbTieMany } from "../lib/giftQbTie";
import {
  qbLedgerExistsForGift,
  qbLedgerPaymentIdForGift,
} from "../lib/paymentApplications";
import { deriveGiftLanes } from "../lib/reconciliationLanes";
import { rederiveGiftAllocations } from "../lib/revenueCoding";
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
    if (q.paymentOnPledgeId) filters.push(eq(giftsAndPayments.paymentOnPledgeId, q.paymentOnPledgeId));
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
  return {
    ...masked,
    reconciliationLanes: deriveGiftLanes(masked.quickbooksTieStatus),
    allocations,
    thankYouAttachments,
    donorbox: donorboxEnrichmentOrNull(donorboxRow),
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
      allowedFields: ["ownerUserId", "type"],
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
    const [row] = await db
      .insert(giftsAndPayments)
      .values({
        id: newId(),
        ...body,
        // Dual-write the authoritative loan_or_grant flag from the gift type
        // (legacy `type` stays the read source this phase).
        loanOrGrant: giftTypeToLoanOrGrant(body.type),
      })
      .returning();
    await applyDerivedOppFieldsMany(row?.paymentOnPledgeId);
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

    // Mirror loan_or_grant whenever the legacy `type` is touched (derive from
    // the merged state so an explicit type change maps correctly).
    const giftWrite: typeof body & { loanOrGrant?: "loan" | "grant" } = { ...body };
    if (body.type !== undefined) {
      giftWrite.loanOrGrant = giftTypeToLoanOrGrant(merged.type);
    }
    const [row] = await db
      .update(giftsAndPayments)
      .set({ ...giftWrite, updatedAt: new Date() })
      .where(eq(giftsAndPayments.id, id))
      .returning();
    if (!row) return notFound(res, "gift");
    // PATCH may re-point payment_on_pledge_id — recompute on both the
    // old and the new pledge so a newly-covered target advances.
    await applyDerivedOppFieldsMany(existing.paymentOnPledgeId, row.paymentOnPledgeId);
    // Amount / off-books / designated-to-school edits change the QB-tie status.
    // Only recompute when one of those tie-affecting fields actually changed so
    // a pure-annotation edit (e.g. the needs-research flag) is a no-op for
    // derivation, never silently re-deriving tie status.
    if (
      existing.amount !== row.amount ||
      existing.offBooksFiscalSponsor !== row.offBooksFiscalSponsor ||
      existing.designatedToSchool !== row.designatedToSchool
    ) {
      await applyGiftQbTieMany(row.id);
    }
    // A donor or gift-type change shifts the derived revenue coding (payer type /
    // loan exclusion) of every allocation under this gift — re-derive snapshots.
    if (
      existing.organizationId !== row.organizationId ||
      existing.individualGiverPersonId !== row.individualGiverPersonId ||
      existing.householdId !== row.householdId ||
      existing.type !== row.type
    ) {
      await rederiveGiftAllocations(row.id);
    }
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
    });
  }),
);

router.post(
  "/gifts-and-payments/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "gift", table: giftsAndPayments });
  }),
);

router.post(
  "/gifts-and-payments/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "gift", table: giftsAndPayments });
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

      // Block if any LOSER is linked to a QuickBooks staged payment (split,
      // matched, created, or group-reconciled). Those FKs are SET NULL, so
      // deleting the loser would silently sever QB reconciliation history.
      const splitLink = await tx
        .select({ giftId: stagedPaymentSplits.giftId })
        .from(stagedPaymentSplits)
        .where(inArray(stagedPaymentSplits.giftId, loserIds))
        .then((r) => r[0]);
      const stagedLink = await tx
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(
          or(
            inArray(stagedPayments.matchedGiftId, loserIds),
            inArray(stagedPayments.createdGiftId, loserIds),
            inArray(stagedPayments.groupReconciledGiftId, loserIds),
          ),
        )
        .then((r) => r[0]);
      // Block, too, if a loser carries a QuickBooks cash-application ledger row
      // (payment_applications.gift_id is RESTRICT). The ledger is empty in
      // Phase 1, so this changes no behaviour yet; it keeps the merge guard
      // correct once the ledger becomes the QB linkage authority.
      const ledgerLink = await tx
        .select({ giftId: paymentApplications.giftId })
        .from(paymentApplications)
        .where(inArray(paymentApplications.giftId, loserIds))
        .then((r) => r[0]);
      if (splitLink || stagedLink || ledgerLink) {
        return {
          ok: false,
          status: 409,
          json: {
            error: "quickbooks_linked",
            message:
              "One of the duplicate gifts is linked to a QuickBooks staged payment. Unlink it in QuickBooks Review before merging.",
          },
        };
      }

      // Sum amounts from the locked rows (numeric text; null → 0).
      const sum = rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
      const summedAmount = sum.toFixed(2);

      // Any pledge whose paid total changes — survivor's + every loser's pledge.
      const pledges = new Set<string>();
      for (const r of rows) if (r.paymentOnPledgeId) pledges.add(r.paymentOnPledgeId);

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

      // Delete the losers. giftBeingMatchedId references (including the
      // survivor's) are SET NULL by the DB on delete.
      await tx
        .delete(giftsAndPayments)
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
    // The surviving gift may absorb the losers' QB linkage — recompute its tie.
    await applyGiftQbTieMany(primaryId);
    if (outcome.donorOrgId) enqueueDonorSignal({ organizationId: outcome.donorOrgId });
    res.json({ primaryId, mergedIds: loserIds });
  }),
);

/**
 * Attach several gifts to a pledge as its payments. With `pledgeId` the gifts
 * are attached to that existing pledge; without it a NEW fully-paid pledge is
 * created (donor XOR required — defaults to the first gift's donor) whose
 * awarded amount is the SUM of the gifts. The gifts are NOT deleted; each keeps
 * its own donor and gets `paymentOnPledgeId` set. Derived pledge fields
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
      for (const g of gifts) if (g.paymentOnPledgeId) pledges.add(g.paymentOnPledgeId);

      // A gift that already pays a DIFFERENT pledge must be surfaced, not
      // silently re-pointed (the pledge payment link is RESTRICT and moving it
      // would quietly alter another pledge's paid total). Gifts already on the
      // requested target pledge are an idempotent no-op re-attach and allowed;
      // for a NEW pledge (no body.pledgeId) any existing link conflicts.
      const alreadyLinked = gifts.filter(
        (g) => g.paymentOnPledgeId != null && g.paymentOnPledgeId !== body.pledgeId,
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
          stage: "written_commitment",
          wasPledge: true,
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
        .set({ paymentOnPledgeId: pledgeId, updatedAt: new Date() })
        .where(inArray(giftsAndPayments.id, giftIds));

      if (actor) {
        await tx.insert(bulkOperations).values({
          id: newId(),
          actorUserId: actor.id,
          entity: "gifts-and-payments/merge-into-pledge",
          fields: ["paymentOnPledgeId"],
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
 * gift. A pledge (awarded = gift amount, donor = gift donor, was_pledge = true)
 * is created and every payment-gift links to it via paymentOnPledgeId. Derived
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
      if (gift.paymentOnPledgeId != null) {
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
      const qbLink = await tx
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(
          or(
            eq(stagedPayments.matchedGiftId, id),
            eq(stagedPayments.createdGiftId, id),
            eq(stagedPayments.groupReconciledGiftId, id),
          ),
        )
        .limit(1);
      const qbSplitLink = await tx
        .select({ id: stagedPaymentSplits.id })
        .from(stagedPaymentSplits)
        .where(eq(stagedPaymentSplits.giftId, id))
        .limit(1);
      if (qbLink.length || qbSplitLink.length) {
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
        stage: "written_commitment",
        wasPledge: true,
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
          formallyRestricted: a.formalFundUseRestriction || a.formalRegionalRestriction,
          status: "superseded_by_gift",
        });
      }

      // 3. Transform-in-place. The original gift becomes the payment for the
      // FIRST allocation; mint a new gift for each remaining allocation and
      // re-point that allocation onto it. Header fields are allocation-aware
      // (grant year follows the allocation; designated-to-school is OR'd with
      // the allocation's school recipient) so split rows aren't mislabeled.
      // Thank-you / QB / Airtable / archive metadata stays only on the original.
      const [first, ...rest] = allocs;
      const giftIds: string[] = [gift.id];

      await tx
        .update(giftsAndPayments)
        .set({
          amount: first.subAmount,
          paymentOnPledgeId: pledgeId,
          grantYear: first.grantYear ?? gift.grantYear,
          designatedToSchool: gift.designatedToSchool || first.schoolRecipientId != null,
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
          paymentOnPledgeId: pledgeId,
          advisorPersonId: gift.advisorPersonId,
          grantYear: a.grantYear ?? gift.grantYear,
          primaryContactPersonId: gift.primaryContactPersonId,
          paymentIntermediaryId: gift.paymentIntermediaryId,
          ownerUserId: gift.ownerUserId,
          designatedToSchool: gift.designatedToSchool || a.schoolRecipientId != null,
          // Carry the source gift's goal/payment flags onto every split row so
          // they aren't silently reset to their column defaults.
          paymentExpected: gift.paymentExpected,
          countsTowardGoal: gift.countsTowardGoal,
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
          fields: ["amount", "paymentOnPledgeId", "grantYear", "designatedToSchool"],
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
    const [updated] = await db
      .update(giftsAndPayments)
      .set({
        thankYouSentAt: msg.sentAt.toISOString().slice(0, 10),
        thankYouEmailMessageId: msg.id,
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
        payoutReconStatus: stripePayouts.qbReconciliationStatus,
        depositId: stagedPayments.id,
        depositAmount: stagedPayments.amount,
        depositDate: stagedPayments.dateReceived,
        depositPayer: stagedPayments.payerName,
        depositStatus: stagedPayments.status,
      })
      .from(stripeStagedCharges)
      .leftJoin(
        stripePayouts,
        eq(stripePayouts.id, stripeStagedCharges.stripePayoutId),
      )
      .leftJoin(
        stagedPayments,
        sql`${stagedPayments.id} = COALESCE(${stripePayouts.matchedQbStagedPaymentId}, ${stripePayouts.proposedQbStagedPaymentId}, ${stripePayouts.qbConflictStagedPaymentId})`,
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
            qbReconciliationStatus: row.payoutReconStatus,
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
        offBooks: sql<boolean>`(${giftsAndPayments.offBooksFiscalSponsor} OR ${giftsAndPayments.designatedToSchool})`,
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
    // linkType label still reads the legacy split table + group column (display
    // only — deprecated in the cleanup phase). Off-books gifts may still surface
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
        groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
        splitMarker: stagedPaymentSplits.stagedPaymentId,
      })
      .from(paymentApplications)
      .innerJoin(
        stagedPayments,
        eq(stagedPayments.id, paymentApplications.paymentId),
      )
      .leftJoin(
        stagedPaymentSplits,
        and(
          eq(stagedPaymentSplits.stagedPaymentId, paymentApplications.paymentId),
          eq(stagedPaymentSplits.giftId, id),
        ),
      )
      .where(
        and(
          eq(paymentApplications.giftId, id),
          eq(paymentApplications.evidenceSource, "quickbooks"),
        ),
      );

    const quickbooksRecords = ledgerRows.map((r) => ({
      stagedPaymentId: r.stagedPaymentId,
      linkType: (r.splitMarker != null
        ? "split"
        : r.createdTheGift
          ? "created"
          : r.groupReconciledGiftId === id
            ? "group"
            : "matched") as "matched" | "created" | "group" | "split",
      realmId: r.realmId,
      qbEntityType: r.qbEntityType,
      qbEntityId: r.qbEntityId,
      qbDocNumber: r.qbDocNumber,
      qbDepositToAccountName: r.qbDepositToAccountName,
      qbPaymentMethod: r.qbPaymentMethod,
      payerName: r.payerName,
      amount: r.amountApplied,
      dateReceived: r.dateReceived,
    }));

    // RESTRICTIONS — the per-allocation restriction coding under this gift.
    const restrictions = await db
      .select({
        allocationId: giftAllocations.id,
        restrictionType: giftAllocations.restrictionType,
        purposeVerbatim: giftAllocations.purposeVerbatim,
        restrictionEvidence: giftAllocations.restrictionEvidence,
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
      restrictions,
    });
  }),
);

export default router;
