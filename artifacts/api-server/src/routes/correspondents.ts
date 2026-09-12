import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { correspondentIgnore, emailProposals, emails, people } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  ListUnrecognizedCorrespondentsQueryParams,
  CreateCorrespondentIgnoreBody,
} from "@workspace/api-zod";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, newId, parseBoolQuery, parseOrBadRequest } from "../lib/helpers";
import { invalidateStaffDefaultSuppressionCache } from "../lib/emailMatcher";

/**
 * "People you've been emailing who aren't in the CRM yet" dashboard
 * panel. Computed live from email_messages: takes every distinct
 * recipient on a message the caller has sent in the last N days,
 * subtracts any address that already exists in the `emails` table,
 * subtracts the caller's own ignore list, and groups by address with
 * a thread count + first/last-seen window.
 *
 * Sent-direction only: an unrecognized SENDER (received) is too noisy
 * — every newsletter, every reply-to-noreply, every cold pitch shows
 * up. A sent address means the user actively chose to email this
 * person, which is the strongest "should be in CRM" signal.
 *
 * `minThreads` defaults to 2 so a single one-off email doesn't
 * surface as a prospect. The query uses array unnest on `to_emails`
 * + `cc_emails`.
 */

const router: IRouter = Router();
router.use(requireAuth);
const MatchEmailIdentityBody = z.object({
  emailAddress: z.string(),
  personId: z.string().nullish(),
  createPerson: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    fullName: z.string().optional(),
  }).nullish(),
  proposalId: z.string().nullish(),
  invalidateObservedEmail: z.boolean().optional(),
});

router.get(
  "/correspondents/unrecognized",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const q = parseOrBadRequest(
      ListUnrecognizedCorrespondentsQueryParams,
      req.query,
      res,
    );
    if (!q) return;
    // Admin-only all-mailboxes mode. Read the raw query value (not the
    // orval-coerced boolean, where "false" → true); non-admins passing
    // the flag are silently kept on their own mailbox.
    const allMailboxes =
      parseBoolQuery(req, "allMailboxes") === true && user.role === "admin";
    // Mailbox owner is always the caller (private email data) unless in
    // admin all-mailboxes mode.
    const mailboxUserId = user.id;
    if (!allMailboxes && q.mailboxUserId && q.mailboxUserId !== user.id) {
      res.json({ data: [] });
      return;
    }
    const days = q.days;
    const minThreads = q.minThreads;

    // Single-query SQL: unnest to+cc recipients of sent messages,
    // lowercase, exclude addresses already known to the CRM
    // (existing `emails` row, case-insensitive) and addresses on
    // the caller's ignore list. Group by address, return thread
    // count + first/last seen + the most recent subject for
    // context.
    const cutoffSql = sql`NOW() - (${days}::int * INTERVAL '1 day')`;

    // In all-mailboxes mode the grouping key includes the mailbox owner,
    // so the same address emailed by two different staff members shows
    // once per mailbox (each row is actionable within that mailbox's
    // ignore list).
    const rows = await db.execute<{
      email_address: string;
      mailbox_user_id: string | null;
      mailbox_user_name: string | null;
      thread_count: number | string;
      first_seen_at: Date;
      last_seen_at: Date;
      last_subject: string | null;
    }>(sql`
      WITH recents AS (
        SELECT
          mailbox_user_id,
          gmail_thread_id,
          sent_at,
          subject,
          LOWER(unnest(COALESCE(to_emails, '{}'::text[]) || COALESCE(cc_emails, '{}'::text[]))) AS addr
        FROM email_messages
        WHERE ${allMailboxes ? sql`TRUE` : sql`mailbox_user_id = ${mailboxUserId}`}
          AND direction = 'sent'
          AND (is_private = false OR mailbox_user_id = ${mailboxUserId})
          AND sent_at >= ${cutoffSql}
      ),
      candidate AS (
        SELECT
          mailbox_user_id,
          addr AS email_address,
          COUNT(DISTINCT gmail_thread_id) AS thread_count,
          MIN(sent_at) AS first_seen_at,
          MAX(sent_at) AS last_seen_at,
          (ARRAY_AGG(subject ORDER BY sent_at DESC))[1] AS last_subject
        FROM recents
        WHERE addr <> ''
          AND addr LIKE '%@%'
          -- Suppress addresses that are obviously not a human
          -- correspondent. Sent-to noreply / mailer-daemon /
          -- notifications-style endpoints occasionally happen
          -- (forwarding, replying to a bot thread) and would
          -- otherwise clutter the "people to add to CRM" panel.
          AND split_part(addr, '@', 1) NOT IN (
            'noreply', 'no-reply', 'donotreply', 'do-not-reply',
            'mailer-daemon', 'postmaster', 'bounces', 'bounce',
            'notifications', 'notification', 'alerts', 'alert',
            'updates', 'newsletter', 'news', 'support',
            'help', 'info', 'hello', 'hi', 'team',
            'noreply-calendar', 'calendar-notification'
          )
          AND split_part(addr, '@', 1) NOT LIKE 'noreply%'
          AND split_part(addr, '@', 1) NOT LIKE 'no-reply%'
          AND split_part(addr, '@', 1) NOT LIKE 'notification%'
          AND split_part(addr, '@', 1) NOT LIKE 'bounce%'
          AND split_part(addr, '@', 1) NOT LIKE 'mailer-%'
          AND split_part(addr, '@', 2) NOT IN (
            'bounces.google.com', 'bounce.linkedin.com',
            'email.linkedin.com', 'bounces.amazonses.com',
            'sendgrid.net', 'mailchimp.com', 'mailgun.org',
            'wildflowerschools.org'
          )
        GROUP BY mailbox_user_id, addr
      )
      SELECT
        c.*,
        COALESCE(
          NULLIF(u.display_name, ''),
          NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
          u.email
        ) AS mailbox_user_name
      FROM candidate c
      LEFT JOIN users u ON u.id = c.mailbox_user_id
      WHERE c.thread_count >= ${minThreads}
        AND NOT EXISTS (
          SELECT 1 FROM emails e WHERE LOWER(e.email) = c.email_address
        )
        AND NOT EXISTS (
          -- Same distinctive local-part already on file against a real
          -- person — e.g. josephina@yassprize.org is on file, so
          -- josephina@edreform.com is the same human writing from a
          -- second address, not a brand-new lead. Gated on length >= 6
          -- so short / generic handles (joe, info, team) can't collapse
          -- unrelated people together.
          SELECT 1 FROM emails e2
          WHERE e2.person_id IS NOT NULL
            AND length(split_part(c.email_address, '@', 1)) >= 6
            AND LOWER(split_part(e2.email, '@', 1)) = split_part(c.email_address, '@', 1)
        )
        AND NOT EXISTS (
          -- Ignore list is per-mailbox: in all-mailboxes mode each row is
          -- suppressed by ITS OWN mailbox's ignore entries.
          SELECT 1 FROM correspondent_ignore i
          WHERE i.mailbox_user_id = c.mailbox_user_id
            AND i.email_lower = c.email_address
        )
      ORDER BY c.thread_count DESC, c.last_seen_at DESC
      LIMIT 100
    `);

    const data = rows.rows.map((r) => {
      const addr = r.email_address;
      const at = addr.lastIndexOf("@");
      return {
        emailAddress: addr,
        displayName: null,
        ...(allMailboxes
          ? {
              mailboxUserId: r.mailbox_user_id,
              mailboxUserName: r.mailbox_user_name,
            }
          : {}),
        domain: at >= 0 ? addr.slice(at + 1) : null,
        threadCount: Number(r.thread_count),
        firstSeenAt:
          r.first_seen_at instanceof Date
            ? r.first_seen_at.toISOString()
            : new Date(r.first_seen_at).toISOString(),
        lastSeenAt:
          r.last_seen_at instanceof Date
            ? r.last_seen_at.toISOString()
            : new Date(r.last_seen_at).toISOString(),
        lastSubject: r.last_subject ?? null,
      };
    });
    res.json({ data });
  }),
);

router.post(
  "/correspondent-ignore",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = parseOrBadRequest(CreateCorrespondentIgnoreBody, req.body, res);
    if (!body) return;
    const lower = body.emailAddress.trim().toLowerCase();
    if (!lower || !lower.includes("@")) {
      res.status(400).json({
        error: "validation_error",
        message: "emailAddress must look like an email",
      });
      return;
    }
    // Admins reviewing the all-mailboxes view may ignore on behalf of
    // the originating mailbox so the row leaves THAT user's queue.
    // Everyone else can only write to their own ignore list.
    const targetMailboxUserId = body.mailboxUserId ?? user.id;
    if (targetMailboxUserId !== user.id && user.role !== "admin") {
      res.status(403).json({
        error: "forbidden",
        message: "Only admins can ignore a correspondent for another mailbox.",
      });
      return;
    }
    await db
      .insert(correspondentIgnore)
      .values({ mailboxUserId: targetMailboxUserId, emailLower: lower })
      .onConflictDoNothing();
    res.status(204).end();
  }),
);

/**
 * The single write boundary for observed-email identity review. Bounce rows
 * and unmatched-correspondent rows use this same transaction: attach the
 * address to an existing person or create one, optionally resolve a bounce
 * proposal, and only invalidate when the caller explicitly confirms the
 * hard-bounce action.
 */
router.post(
  "/email-identity/match",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = parseOrBadRequest(MatchEmailIdentityBody, req.body, res);
    if (!body) return;
    const emailAddress = body.emailAddress.trim();
    if (!emailAddress || !emailAddress.includes("@")) {
      res.status(400).json({ error: "validation_error", message: "emailAddress must look like an email" });
      return;
    }
    if (!body.personId && !body.createPerson) {
      res.status(400).json({ error: "validation_error", message: "Choose an existing person or provide createPerson." });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        let personId = body.personId ?? null;
        if (body.proposalId) {
          const [proposal] = await tx
            .select({
              id: emailProposals.id,
              kind: emailProposals.kind,
              mailboxUserId: emailProposals.mailboxUserId,
              status: emailProposals.status,
            })
            .from(emailProposals)
            .where(and(eq(emailProposals.id, body.proposalId), eq(emailProposals.status, "pending")))
            .limit(1);
          if (!proposal || (proposal.mailboxUserId !== user.id && user.role !== "admin")) {
            throw Object.assign(new Error("Proposal not found or is no longer pending."), { statusCode: 404 });
          }
          if (proposal.kind !== "bounce_invalid" && proposal.kind !== "bounce_soft") {
            throw Object.assign(new Error("Only bounce proposals can use the identity workflow."), { statusCode: 400 });
          }
          if (body.invalidateObservedEmail && proposal.kind !== "bounce_invalid") {
            throw Object.assign(new Error("Soft bounces cannot permanently invalidate an email."), { statusCode: 400 });
          }
        } else if (body.invalidateObservedEmail) {
          throw Object.assign(new Error("Email invalidation requires a hard-bounce proposal."), { statusCode: 400 });
        }

        if (!personId) {
          const create = body.createPerson!;
          personId = newId();
          await tx.insert(people).values({
            id: personId,
            firstName: create.firstName?.trim() || null,
            lastName: create.lastName?.trim() || null,
            fullName: create.fullName?.trim() || [create.firstName, create.lastName].filter(Boolean).join(" ") || null,
          });
        } else {
          const [person] = await tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).limit(1);
          if (!person) throw Object.assign(new Error("Person not found."), { statusCode: 404 });
        }

        const [existing] = await tx.select({ id: emails.id, personId: emails.personId })
          .from(emails).where(sql`lower(${emails.email}) = lower(${emailAddress})`).limit(1);
        let emailId: string;
        if (existing) {
          if (existing.personId !== personId) {
            throw Object.assign(new Error("That email is already attached to another record."), { statusCode: 409 });
          }
          emailId = existing.id;
          if (body.invalidateObservedEmail) {
            await tx.update(emails).set({ validity: "invalid", updatedAt: new Date() }).where(eq(emails.id, emailId));
          }
        } else {
          emailId = newId();
          await tx.insert(emails).values({
            id: emailId,
            email: emailAddress,
            personId,
            validity: body.invalidateObservedEmail ? "invalid" : "unknown",
          });
        }
        await tx.execute(sql`
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
        `);

        if (body.proposalId) {
          await tx.update(emailProposals).set({
            status: "applied",
            resolvedAt: new Date(),
            resolvedByUserId: user.id,
            updatedAt: new Date(),
          }).where(and(eq(emailProposals.id, body.proposalId), eq(emailProposals.status, "pending")));
        }
        return { personId, emailId, proposalId: body.proposalId ?? null };
      });
      invalidateStaffDefaultSuppressionCache();
      res.json(result);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status) {
        res.status(status).json({ error: status === 404 ? "not_found" : "validation_error", message: (error as Error).message });
        return;
      }
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "conflict", message: "That email is already attached to another record." });
        return;
      }
      throw error;
    }
  }),
);

export default router;
