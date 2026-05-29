import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { correspondentIgnore } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import {
  ListUnrecognizedCorrespondentsQueryParams,
  CreateCorrespondentIgnoreBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, parseOrBadRequest } from "../lib/helpers";

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
    // Mailbox owner is always the caller (private email data).
    const mailboxUserId = user.id;
    if (q.mailboxUserId && q.mailboxUserId !== user.id) {
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

    const rows = await db.execute<{
      email_address: string;
      thread_count: number | string;
      first_seen_at: Date;
      last_seen_at: Date;
      last_subject: string | null;
    }>(sql`
      WITH recents AS (
        SELECT
          gmail_thread_id,
          sent_at,
          subject,
          LOWER(unnest(COALESCE(to_emails, '{}'::text[]) || COALESCE(cc_emails, '{}'::text[]))) AS addr
        FROM email_messages
        WHERE mailbox_user_id = ${mailboxUserId}
          AND direction = 'sent'
          AND sent_at >= ${cutoffSql}
      ),
      candidate AS (
        SELECT
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
            'sendgrid.net', 'mailchimp.com', 'mailgun.org'
          )
        GROUP BY addr
      )
      SELECT c.*
      FROM candidate c
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
          SELECT 1 FROM correspondent_ignore i
          WHERE i.mailbox_user_id = ${mailboxUserId}
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
    await db
      .insert(correspondentIgnore)
      .values({ mailboxUserId: user.id, emailLower: lower })
      .onConflictDoNothing();
    res.status(204).end();
  }),
);

export default router;
