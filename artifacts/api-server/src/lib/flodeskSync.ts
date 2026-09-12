import { recordFlodeskUnsubscribe } from "./newsletterPreferences";
import { db } from "@workspace/db";
import { people, emails, newsletterPreferenceEvents } from "@workspace/db/schema";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  addSubscriberToSegments,
  removeSubscriberFromSegments,
  getFlodeskSegmentId,
  getSubscriber,
  isFlodeskConfigured,
  listSubscribers,
  unsubscribeSubscriber,
  upsertSubscriber,
  type FlodeskSubscriber,
} from "./flodeskClient";

/** Flodesk delivery sync consumes the evidence-derived CRM preference.
 * Staff removal only removes segment membership. An opt-out suppresses delivery;
 * resubscription supplies an actual consent timestamp for Flodesk to validate.
 * Inbound observations append evidence; they never write preference flags.
 */

const UNSUBSCRIBED_STATUS = "unsubscribed";

export type FlodeskOutboundOutcome =
  | "subscribed"
  | "unsubscribed"
  | "removed_from_segment"
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
      const latestConsent = await db.select({ occurredAt: newsletterPreferenceEvents.occurredAt })
        .from(newsletterPreferenceEvents).where(and(eq(newsletterPreferenceEvents.personId, personId), eq(newsletterPreferenceEvents.eventType, "consent_given"), isNotNull(newsletterPreferenceEvents.occurredAt)))
        .orderBy(sql`${newsletterPreferenceEvents.occurredAt} DESC`).limit(1).then((rows) => rows[0]?.occurredAt ?? null);
      // Current eligibility already proves this consent is later than any recorded opt-out.
      // Flodesk independently checks optin_timestamp before allowing reactivation.
      if (existing?.status === UNSUBSCRIBED_STATUS && !latestConsent) {
        await recordFlodeskUnsubscribe(personId, email);
        return { outcome: "mirrored_unsubscribe", email };
      }
      const pushed = await upsertSubscriber(email, {
        firstName: person.firstName, lastName: person.lastName,
        optinTimestamp: latestConsent?.toISOString() ?? null,
      });
      if (pushed?.status === UNSUBSCRIBED_STATUS) {
        await recordFlodeskUnsubscribe(personId, email);
        return { outcome: "mirrored_unsubscribe", email };
      }
      await addSubscriberToSegments(email, [segmentId]);
      return { outcome: "subscribed", email };
    }

    if (person.unsubscribedToNewsletter) {
      await unsubscribeSubscriber(email);
      return { outcome: "unsubscribed", email };
    }
    await removeSubscriberFromSegments(email, [segmentId]);
    return { outcome: "removed_from_segment", email };
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
    .selectDistinct({ personId: emails.personId, email: emails.email })
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

  let applied = 0;
  for (const personId of personIds) {
    const matching = ownerRows.find((row) => row.personId === personId);
    if (matching && await recordFlodeskUnsubscribe(personId, matching.email)) applied += 1;
  }
  return applied;
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
