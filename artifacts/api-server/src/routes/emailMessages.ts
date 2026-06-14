import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { emailAttachments, emailMessages } from "@workspace/db/schema";
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  ListEmailMessagesQueryParams,
  UpdateEmailMessagePrivacyBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { computeTracking } from "../lib/emailTrackingEnrich";

/**
 * Read-only-ish surface over the synced Gmail messages. The sync
 * worker is the only writer for body / participants; the only thing
 * a CRM user can mutate from the UI is the privacy flag, and only
 * if they're the mailbox owner.
 *
 * Privacy semantics (applied at the SQL layer, never client-side):
 *
 *   visible to caller = (is_private = false) OR (mailbox_user_id = caller.id)
 *
 * The same predicate is appended to both the list endpoint and the
 * single-record GET so private messages stay invisible to everyone
 * but the mailbox owner.
 */
const router: IRouter = Router();
router.use(requireAuth);

function visibleToCaller(callerId: string): SQL {
  return or(
    eq(emailMessages.isPrivate, false),
    eq(emailMessages.mailboxUserId, callerId),
  )!;
}

router.get(
  "/email-messages",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const q = parseOrBadRequest(ListEmailMessagesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [visibleToCaller(user.id)];
    if (q.search) {
      const term = `%${q.search}%`;
      const orClause = or(
        ilike(emailMessages.subject, term),
        ilike(emailMessages.snippet, term),
        ilike(emailMessages.bodyText, term),
      );
      if (orClause) filters.push(orClause);
    }
    if (q.mailboxUserId) {
      filters.push(eq(emailMessages.mailboxUserId, q.mailboxUserId));
    }
    if (q.personId) {
      filters.push(
        sql`${emailMessages.matchedPersonIds} @> ARRAY[${q.personId}]::text[]`,
      );
    }
    if (q.organizationId) {
      filters.push(
        sql`${emailMessages.matchedOrganizationIds} @> ARRAY[${q.organizationId}]::text[]`,
      );
    }
    if (q.householdId) {
      filters.push(
        sql`${emailMessages.matchedHouseholdIds} @> ARRAY[${q.householdId}]::text[]`,
      );
    }
    const where = and(...filters);

    // Deduplicate across mailboxes: the same physical Gmail message is stored
    // once per synced mailbox (unique key = mailboxUserId + gmailMessageId), so
    // a donor who corresponds with two staff users whose Gmail is synced would
    // otherwise see the same email twice. DISTINCT ON (gmail_message_id) keeps
    // one row per thread message, preferring the SENT copy over an INBOX copy
    // for a richer "from" perspective, then falling back to sentAt DESC.
    const selectedFields = {
      id: emailMessages.id,
      gmailMessageId: emailMessages.gmailMessageId,
      gmailThreadId: emailMessages.gmailThreadId,
      mailboxUserId: emailMessages.mailboxUserId,
      direction: emailMessages.direction,
      sentAt: emailMessages.sentAt,
      subject: emailMessages.subject,
      snippet: emailMessages.snippet,
      fromEmail: emailMessages.fromEmail,
      toEmails: emailMessages.toEmails,
      ccEmails: emailMessages.ccEmails,
      bccEmails: emailMessages.bccEmails,
      hasAttachments: emailMessages.hasAttachments,
      isPrivate: emailMessages.isPrivate,
      matchedPersonIds: emailMessages.matchedPersonIds,
      matchedOrganizationIds: emailMessages.matchedOrganizationIds,
      matchedHouseholdIds: emailMessages.matchedHouseholdIds,
      aiSummary: emailMessages.aiSummary,
    };
    const deduped = db
      .selectDistinctOn([emailMessages.gmailMessageId], selectedFields)
      .from(emailMessages)
      .where(where)
      .orderBy(
        emailMessages.gmailMessageId,
        // Prefer sent over inbox so the outgoing perspective is canonical.
        sql`(CASE WHEN ${emailMessages.direction} = 'sent' THEN 0 ELSE 1 END)`,
        desc(emailMessages.sentAt),
      )
      .as("deduped");

    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(deduped)
        .orderBy(desc(deduped.sentAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(deduped),
    ]);
    const trackingMap = await computeTracking(rows, {
      personId: q.personId,
      organizationId: q.organizationId,
      householdId: q.householdId,
    });
    const data = rows.map((r) => {
      const t = trackingMap.get(r.id);
      return t
        ? { ...r, ...t }
        : {
            ...r,
            isTracked: false,
            trackingTotalViews: null,
            trackingLastOpenedAt: null,
          };
    });
    res.json({ data, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/email-messages/:id",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const row = await db
      .select()
      .from(emailMessages)
      .where(
        and(eq(emailMessages.id, paramId(req)), visibleToCaller(user.id)),
      )
      .then((r) => r[0]);
    if (!row) return notFound(res, "email message");
    const atts = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        mimeType: emailAttachments.mimeType,
        sizeBytes: emailAttachments.sizeBytes,
        gmailAttachmentId: emailAttachments.gmailAttachmentId,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, row.id));
    res.json({ ...row, attachments: atts });
  }),
);

router.patch(
  "/email-messages/:id/privacy",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = parseOrBadRequest(UpdateEmailMessagePrivacyBody, req.body, res);
    if (!body) return;
    // Owner-only check: the WHERE clause restricts the UPDATE to
    // rows where mailbox_user_id matches the caller. A non-owner
    // hitting this endpoint gets 404 (we don't reveal the row's
    // existence — same behavior as a private message they can't
    // see in the list).
    const [row] = await db
      .update(emailMessages)
      .set({
        isPrivate: body.isPrivate,
        privateSetByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailMessages.id, paramId(req)),
          eq(emailMessages.mailboxUserId, user.id),
        ),
      )
      .returning();
    if (!row) return notFound(res, "email message");
    res.json(row);
  }),
);

export default router;
