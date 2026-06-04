import { db } from "@workspace/db";
import { people, emails } from "@workspace/db/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  addSubscriberToSegments,
  getFlodeskSegmentId,
  getSubscriber,
  isFlodeskConfigured,
  listSubscribers,
  unsubscribeSubscriber,
  upsertSubscriber,
  type FlodeskSubscriber,
} from "./flodeskClient";

/**
 * Flodesk subscriber sync.
 *
 * OUTBOUND (CRM → Flodesk): `syncPersonToFlodesk` pushes a single person's
 * newsletter membership into the configured Flodesk segment. Eligible people
 * (newsletter on, not unsubscribed, with a usable email) are upserted as
 * active subscribers in the segment; ineligible people are unsubscribed in
 * Flodesk. The helper never throws — it returns a result and logs warnings —
 * so a future one-time backfill is a thin loop over eligible people.
 *
 * INBOUND (Flodesk → CRM): `reconcileFlodeskUnsubscribes` pages through the
 * segment's subscribers and flips `unsubscribedToNewsletter = true` on any CRM
 * person whose email is unsubscribed in Flodesk.
 *
 * Precedence (the two directions must not fight): inbound is monotonic — it
 * only ever SETS unsubscribed, never clears it — so a CRM unsubscribe can never
 * be overwritten by a stale Flodesk subscribe. Outbound guards the reverse:
 * before (re)subscribing an eligible person it checks Flodesk's current status
 * and, if Flodesk already shows them unsubscribed, mirrors that into the CRM
 * instead of clobbering it. The most recent explicit status therefore wins.
 */

const UNSUBSCRIBED_STATUS = "unsubscribed";

export type FlodeskOutboundOutcome =
  | "subscribed"
  | "unsubscribed"
  | "mirrored_unsubscribe"
  | "skipped_no_email"
  | "skipped_not_configured"
  | "error";

export interface FlodeskPersonSyncResult {
  outcome: FlodeskOutboundOutcome;
  email: string | null;
  error?: string;
}

interface PersonForSync {
  id: string;
  firstName: string | null;
  lastName: string | null;
  newsletter: boolean;
  unsubscribedToNewsletter: boolean;
}

/**
 * Pick the best usable email for a person: the preferred one first, then the
 * oldest, excluding addresses explicitly marked invalid. Returns a lowercased
 * address or null when the person has no usable email.
 */
export async function getUsablePersonEmail(
  personId: string,
): Promise<string | null> {
  const row = await db
    .select({ email: emails.email })
    .from(emails)
    .where(
      and(eq(emails.personId, personId), ne(emails.validity, "invalid")),
    )
    .orderBy(sql`${emails.isPreferred} DESC`, sql`${emails.createdAt} ASC`)
    .limit(1)
    .then((r) => r[0]);
  const email = row?.email?.trim().toLowerCase();
  return email ? email : null;
}

/** Eligible = newsletter on AND not unsubscribed (email checked separately). */
export function isNewsletterEligible(p: {
  newsletter: boolean;
  unsubscribedToNewsletter: boolean;
}): boolean {
  return p.newsletter === true && p.unsubscribedToNewsletter === false;
}

/**
 * Push one person's newsletter membership to Flodesk. Safe to call in a loop
 * (never throws) and safe to call fire-and-forget from the person CRUD paths.
 */
export async function syncPersonToFlodesk(
  personId: string,
): Promise<FlodeskPersonSyncResult> {
  // Skip silently when Flodesk isn't wired up yet — person CRUD must not break.
  // The scheduler + manual reconcile fail loudly on missing config instead.
  if (!isFlodeskConfigured()) {
    return { outcome: "skipped_not_configured", email: null };
  }

  let person: PersonForSync | undefined;
  try {
    person = await db
      .select({
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        newsletter: people.newsletter,
        unsubscribedToNewsletter: people.unsubscribedToNewsletter,
      })
      .from(people)
      .where(eq(people.id, personId))
      .then((r) => r[0]);
  } catch (err) {
    logger.warn({ err, personId }, "Flodesk sync: failed to load person");
    return {
      outcome: "error",
      email: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!person) {
    return { outcome: "skipped_no_email", email: null };
  }

  const email = await getUsablePersonEmail(personId);
  if (!email) {
    return { outcome: "skipped_no_email", email: null };
  }

  try {
    const segmentId = getFlodeskSegmentId();
    if (isNewsletterEligible(person)) {
      // Guardrail: don't resurrect a subscriber the recipient unsubscribed in
      // Flodesk. If Flodesk already has them unsubscribed, that explicit signal
      // wins — mirror it into the CRM instead of re-subscribing.
      const existing = await getSubscriber(email);
      if (existing && existing.status === UNSUBSCRIBED_STATUS) {
        await db
          .update(people)
          .set({ unsubscribedToNewsletter: true, updatedAt: new Date() })
          .where(
            and(
              eq(people.id, personId),
              eq(people.unsubscribedToNewsletter, false),
            ),
          );
        logger.info(
          { personId, email },
          "Flodesk sync: subscriber already unsubscribed in Flodesk — mirrored to CRM",
        );
        return { outcome: "mirrored_unsubscribe", email };
      }
      await upsertSubscriber(email, {
        firstName: person.firstName,
        lastName: person.lastName,
      });
      await addSubscriberToSegments(email, [segmentId]);
      return { outcome: "subscribed", email };
    }

    // Ineligible (newsletter off or unsubscribed) — unsubscribe in Flodesk.
    await unsubscribeSubscriber(email);
    return { outcome: "unsubscribed", email };
  } catch (err) {
    logger.warn(
      { err, personId, email },
      "Flodesk sync: outbound push failed",
    );
    return {
      outcome: "error",
      email,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Fire-and-forget wrapper for the person CRUD paths. Never rejects. */
export function syncPersonToFlodeskInBackground(personId: string): void {
  void syncPersonToFlodesk(personId)
    .then((res) => {
      if (res.outcome === "error") {
        logger.warn(
          { personId, res },
          "Flodesk background sync finished with error",
        );
      } else {
        logger.debug({ personId, res }, "Flodesk background sync finished");
      }
    })
    .catch((err) => {
      logger.warn({ err, personId }, "Flodesk background sync threw");
    });
}

export interface FlodeskReconcileSummary {
  subscribersChecked: number;
  unsubscribedSeen: number;
  unsubscribesApplied: number;
  pages: number;
}

/** Apply a batch of unsubscribed Flodesk emails to the matching CRM people. */
async function applyUnsubscribes(emailsLower: string[]): Promise<number> {
  if (emailsLower.length === 0) return 0;
  // Find CRM people who own any of these emails.
  const ownerRows = await db
    .selectDistinct({ personId: emails.personId })
    .from(emails)
    .where(
      and(
        sql`lower(${emails.email}) IN (${sql.join(
          emailsLower.map((e) => sql`${e}`),
          sql`, `,
        )})`,
        sql`${emails.personId} IS NOT NULL`,
      ),
    );
  const personIds = ownerRows
    .map((r) => r.personId)
    .filter((id): id is string => !!id);
  if (personIds.length === 0) return 0;

  const updated = await db
    .update(people)
    .set({ unsubscribedToNewsletter: true, updatedAt: new Date() })
    .where(
      and(
        inArray(people.id, personIds),
        eq(people.unsubscribedToNewsletter, false),
      ),
    )
    .returning({ id: people.id });
  return updated.length;
}

/**
 * INBOUND reconcile: page through the configured segment's subscribers,
 * collect those Flodesk reports as unsubscribed, and mark the matching CRM
 * people unsubscribed. Throws (loudly) when Flodesk isn't configured.
 *
 * `maxPages` bounds a single run; pagination stops early once the reported
 * total is reached or a short page is returned.
 */
export async function reconcileFlodeskUnsubscribes(opts?: {
  maxPages?: number;
  perPage?: number;
}): Promise<FlodeskReconcileSummary> {
  const segmentId = getFlodeskSegmentId();
  const maxPages = Math.max(opts?.maxPages ?? 100, 1);
  const perPage = Math.min(Math.max(opts?.perPage ?? 100, 1), 100);

  const summary: FlodeskReconcileSummary = {
    subscribersChecked: 0,
    unsubscribedSeen: 0,
    unsubscribesApplied: 0,
    pages: 0,
  };

  for (let page = 1; page <= maxPages; page++) {
    const res = await listSubscribers({
      segmentId,
      status: UNSUBSCRIBED_STATUS,
      page,
      perPage,
    });
    summary.pages += 1;
    summary.subscribersChecked += res.subscribers.length;

    // Server-side status filter may or may not be honored — filter again here.
    const unsubscribed = res.subscribers.filter(
      (s: FlodeskSubscriber) => s.status === UNSUBSCRIBED_STATUS,
    );
    const emailsLower = Array.from(
      new Set(unsubscribed.map((s) => s.email.toLowerCase())),
    );
    summary.unsubscribedSeen += emailsLower.length;
    summary.unsubscribesApplied += await applyUnsubscribes(emailsLower);

    const reachedEnd =
      res.subscribers.length < perPage ||
      (res.totalPages != null && page >= res.totalPages);
    if (reachedEnd) break;
  }

  logger.info({ summary }, "Flodesk unsubscribe reconcile finished");
  return summary;
}
