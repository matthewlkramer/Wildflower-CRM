import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { emails } from "@workspace/db/schema";
import { and, count, desc, eq, getTableColumns, ne, sql, type SQL } from "drizzle-orm";
import {
  ListEmailsQueryParams,
  CreateEmailBody,
  UpdateEmailBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  parseOrBadRequest,
  parsePagination,
  paramId,
} from "../lib/helpers";
import { invalidateStaffDefaultSuppressionCache } from "../lib/emailMatcher";
import { queueContactHistoryBackfill } from "../lib/contactHistoryBackfill";

const router: IRouter = Router();
router.use(requireAuth);

// An email address is globally unique (case-insensitive) — enforced by the
// emails_email_lower_unique index. Surface the Postgres unique violation
// (SQLSTATE 23505) as a 409 instead of a 500.
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

// A preferred address belongs to its contact owner, not to a particular
// editor. Use this for both the full dialog and the inline preference action.
function preferredSiblingWhere(row: typeof emails.$inferSelect): SQL {
  const owner = row.personId
    ? eq(emails.personId, row.personId)
    : row.organizationId
      ? eq(emails.organizationId, row.organizationId)
      : row.paymentIntermediaryId
        ? eq(emails.paymentIntermediaryId, row.paymentIntermediaryId)
        : eq(emails.householdId, row.householdId!);
  return and(owner, ne(emails.id, row.id))!;
}

function historicalAttributionQueries(personId: string, emailAddress: string) {
  return [
    sql`
      UPDATE email_messages
      SET matched_person_ids =
        COALESCE(matched_person_ids, '{}') || ARRAY[${personId}]::text[]
      WHERE NOT (COALESCE(matched_person_ids, '{}') @> ARRAY[${personId}]::text[])
        AND (
          lower(COALESCE(from_email, '')) = lower(${emailAddress})
          OR EXISTS (
            SELECT 1 FROM unnest(
              COALESCE(to_emails, '{}') || COALESCE(cc_emails, '{}') || COALESCE(bcc_emails, '{}')
            ) AS addr WHERE lower(addr) = lower(${emailAddress})
          )
        )
    `,
    sql`
      UPDATE calendar_events
      SET matched_person_ids =
        COALESCE(matched_person_ids, '{}') || ARRAY[${personId}]::text[],
        updated_at = NOW()
      WHERE NOT (COALESCE(matched_person_ids, '{}') @> ARRAY[${personId}]::text[])
        AND (
          lower(COALESCE(organizer_email, '')) = lower(${emailAddress})
          OR EXISTS (
            SELECT 1 FROM unnest(COALESCE(attendee_emails, '{}')) AS addr
            WHERE lower(addr) = lower(${emailAddress})
          )
        )
    `,
  ];
}

router.get(
  "/emails",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListEmailsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.email)
      filters.push(sql`lower(${emails.email}) = lower(${q.email.trim()})`);
    if (q.personId) filters.push(eq(emails.personId, q.personId));

    if (q.organizationId)
      filters.push(eq(emails.organizationId, q.organizationId));
    if (q.paymentIntermediaryId)
      filters.push(eq(emails.paymentIntermediaryId, q.paymentIntermediaryId));
    if (q.householdId) filters.push(eq(emails.householdId, q.householdId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select({
          ...getTableColumns(emails),
          // An inbound exchange proves delivery. Preserve an explicit/hard-
          // bounce invalidation, but do not require staff to mark historical
          // correspondents valid one by one. Message privacy is unchanged.
          validity: sql<"valid" | "invalid" | "unknown">`CASE
            WHEN ${emails.validity} = 'unknown' AND EXISTS (
              SELECT 1 FROM email_messages m
              WHERE m.direction = 'received'
                AND lower(m.from_email) = lower(${emails.email})
            ) THEN 'valid'
            ELSE ${emails.validity}
          END`.as("validity"),
        })
        .from(emails)
        .where(where)
        .orderBy(desc(emails.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(emails).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/emails",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateEmailBody, req.body, res);
    if (!body) return;
    // Trim before storing so whitespace-padded input can't create a near-dup
    // that slips past the case-insensitive uniqueness rule.
    if (typeof body.email === "string") body.email = body.email.trim();
    try {
      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(emails)
          .values({ id: newId(), ...body })
          .returning();
        if (created.isPreferred) {
          await tx.update(emails).set({ isPreferred: false, updatedAt: new Date() })
            .where(preferredSiblingWhere(created));
        }
        // Re-attribute HISTORY: synced messages store matched_person_ids at
        // sync time, so messages that predate this link would never surface on
        // the person's activity feed. Keep this in the same transaction as the
        // email row so a failed history update cannot leave an un-linkable
        // partial record behind.
        if (created.personId && created.email) {
          for (const query of historicalAttributionQueries(
            created.personId,
            created.email,
          )) {
            await tx.execute(query);
          }
        }
        return created;
      });
      // Adding/changing a person's email can change the staff-default
      // suppression set (an internal-domain address makes them staff). Bust
      // the cache only after the transaction commits.
      invalidateStaffDefaultSuppressionCache();
      if (row.personId && row.email) {
        queueContactHistoryBackfill({
          personId: row.personId,
          emailAddress: row.email,
        });
      }
      res.status(201).json(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "conflict",
          message: `The email address "${body.email}" is already on file. An email can only be attached to one record.`,
        });
        return;
      }
      throw err;
    }
  }),
);

router.patch(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateEmailBody, req.body, res);
    if (!body) return;
    if (typeof body.email === "string") body.email = body.email.trim();
    try {
      const id = paramId(req);
      const previous = await db
        .select({ email: emails.email, personId: emails.personId })
        .from(emails)
        .where(eq(emails.id, id))
        .then((rows) => rows[0]);
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(emails)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(emails.id, id))
          .returning();
        if (updated?.isPreferred) {
          await tx.update(emails).set({ isPreferred: false, updatedAt: new Date() })
            .where(preferredSiblingWhere(updated));
        }
        if (updated?.personId && updated.email) {
          const changed =
            previous?.personId !== updated.personId ||
            previous?.email.trim().toLowerCase() !==
              updated.email.trim().toLowerCase();
          if (changed) {
            for (const query of historicalAttributionQueries(
              updated.personId,
              updated.email,
            )) {
              await tx.execute(query);
            }
          }
        }
        return updated;
      });
      if (!row) return notFound(res, "email");
      invalidateStaffDefaultSuppressionCache();
      const historyChanged =
        !!row.personId &&
        (previous?.personId !== row.personId ||
          previous?.email.trim().toLowerCase() !==
            row.email.trim().toLowerCase());
      if (historyChanged && row.personId) {
        queueContactHistoryBackfill({
          personId: row.personId,
          emailAddress: row.email,
        });
      }
      res.json(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "conflict",
          message: `The email address "${body.email}" is already on file. An email can only be attached to one record.`,
        });
        return;
      }
      throw err;
    }
  }),
);

router.delete(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    await db.delete(emails).where(eq(emails.id, paramId(req)));
    invalidateStaffDefaultSuppressionCache();
    res.status(204).end();
  }),
);

export default router;
