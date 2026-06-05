import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { enqueueDonorSignal } from "../lib/taskSuggestionQueue";
import {
  giftsAndPayments,
  giftAllocations,
  organizations,
  households,
  people,
  emailMessages,
  emailAttachments,
  emails,
  peopleEntityRoles,
  type NewGiftAllocation,
} from "@workspace/db/schema";
import { and, count, desc, eq, getTableColumns, gte, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getAppUser } from "../lib/appRequest";

// See opportunitiesAndPledges.ts for rationale — same denormalized
// donor display names joined from funders / households / people, plus
// three de-duplicated aggregates from gift_allocations so the gifts
// list can render Entities / Usages / Grant years inline without
// fanning out per-row fetches.
const donorJoinSelect = {
  ...getTableColumns(giftsAndPayments),
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  // See opportunitiesAndPledges.ts donorJoinSelect for rationale.
  organizationPriority: organizations.priority,
  individualGiverPersonPriority: people.priority,
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
};
import {
  ListGiftsAndPaymentsQueryParams,
  CreateGiftOrPaymentBodyRefined,
  UpdateGiftOrPaymentBody,
  BulkUpdateGiftsAndPaymentsBody,
  validateGiftInvariants,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { inArray } from "drizzle-orm";

const GIFTS_ARRAY_PARAMS = ["type", "paymentMethod", "ownerUserId", "entityId", "fiscalYear"] as const;

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
        )!,
      );
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
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(donorJoinSelect)
        .from(giftsAndPayments)
        .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(where)
        .orderBy(desc(giftsAndPayments.dateReceived))
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
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

async function buildGiftDetail(id: string) {
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
  return { ...row, allocations, thankYouAttachments };
}

router.get(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const detail = await buildGiftDetail(id);
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
    const [row] = await db.insert(giftsAndPayments).values({ id: newId(), ...body }).returning();
    await applyDerivedOppFieldsMany(row?.paymentOnPledgeId);
    if (row) {
      // New gift is a fresh relationship signal — refresh the donor's
      // cached next-step suggestion (debounced + priority-gated downstream).
      enqueueDonorSignal({
        organizationId: row.organizationId,
        individualGiverPersonId: row.individualGiverPersonId,
      });
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

    const [row] = await db
      .update(giftsAndPayments)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(giftsAndPayments.id, id))
      .returning();
    if (!row) return notFound(res, "gift");
    // PATCH may re-point payment_on_pledge_id — recompute on both the
    // old and the new pledge so a newly-covered target advances.
    await applyDerivedOppFieldsMany(existing.paymentOnPledgeId, row.paymentOnPledgeId);
    res.json(row);
  }),
);

router.delete(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    // Capture the link before delete so we can still recompute the
    // pledge's coverage afterwards. (Deletion can only *reduce* paid
    // total, so the helper will no-op unless a concurrent insert just
    // pushed it over — cheap to call regardless.)
    const existing = await db
      .select({ paymentOnPledgeId: giftsAndPayments.paymentOnPledgeId })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    await db.delete(giftsAndPayments).where(eq(giftsAndPayments.id, id));
    await applyDerivedOppFieldsMany(existing?.paymentOnPledgeId);
    res.status(204).end();
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
      .where(sql`${emailAttachments.emailMessageId} = ANY(${msgIds}::text[])`);
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
    const detail = await buildGiftDetail(id);
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

export default router;
