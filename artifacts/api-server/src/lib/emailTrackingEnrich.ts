import { db } from "@workspace/db";
import { trackedEmails, trackedEmailViews } from "@workspace/db/schema";
import { eq, inArray, or, sql, type SQL } from "drizzle-orm";

/**
 * Enriches synced Gmail `email_messages` rows with their open-tracking
 * status, sourced from the `tracked_emails` / `tracked_email_views`
 * tables. This is what lets a contact's activity feed show an
 * "Opened / Not opened yet" badge directly on the sent email, instead
 * of forcing the user over to the standalone Email Tracking page.
 *
 * A synced sent message is matched to its tracking row(s) by EITHER:
 *   - exact `gmail_message_id` (per-recipient "Path A" sends record the
 *     id at send time — exact, unambiguous), OR
 *   - a fuzzy key: same sender + same subject within a short time window
 *     (legacy single-pixel sends never captured the gmail id, so this is
 *     the only way to reconnect them after the sync imports the message).
 *
 * The match window guards against attributing opens to the wrong send
 * when the same person was emailed twice with an identical subject.
 */

export const TRACKING_MATCH_WINDOW_MS = 2 * 60 * 60_000; // 2h slack

export interface TrackingFields {
  isTracked: boolean;
  trackingTotalViews: number | null;
  trackingLastOpenedAt: string | null;
}

/** Minimal shape of a synced email row needed for matching. */
export interface SentEmailLike {
  id: string;
  direction: string;
  gmailMessageId: string | null;
  fromEmail: string | null;
  subject: string | null;
  sentAt: Date | string;
}

/** A tracked-email row with its views pre-aggregated. */
export interface TrackedAgg {
  id: string;
  gmailMessageId: string | null;
  /** lowercased sender address */
  sender: string;
  /** lowercased subject */
  subject: string;
  createdAt: Date | string;
  totalViews: number;
  lastView: Date | string | null;
}

/**
 * Pure matcher: given synced sent rows and the candidate tracked rows
 * (already scoped/fetched), returns a map of email id → tracking fields
 * for the rows that matched. No DB access — unit-testable.
 */
export function matchSentEmailTracking(
  rows: SentEmailLike[],
  tracked: TrackedAgg[],
): Map<string, TrackingFields> {
  const out = new Map<string, TrackingFields>();
  if (tracked.length === 0) return out;

  for (const r of rows) {
    if (r.direction !== "sent") continue;
    const fromLower = (r.fromEmail ?? "").toLowerCase().trim();
    const subjLower = (r.subject ?? "").toLowerCase().trim();
    const sentMs = new Date(r.sentAt).getTime();

    // Exact gmail-id matches are authoritative (per-recipient "Path A"
    // sends record the id at send time). Only fall back to the fuzzy
    // sender+subject key when NO exact match exists, so a same-subject
    // legacy row can never inflate the count of an exactly-matched send.
    const exacts = r.gmailMessageId
      ? tracked.filter(
          (te) => !!te.gmailMessageId && te.gmailMessageId === r.gmailMessageId,
        )
      : [];
    const matchSet =
      exacts.length > 0
        ? exacts
        : tracked.filter(
            (te) =>
              !!fromLower &&
              te.sender.trim() === fromLower &&
              !!subjLower &&
              te.subject.trim() === subjLower &&
              Math.abs(new Date(te.createdAt).getTime() - sentMs) <=
                TRACKING_MATCH_WINDOW_MS,
          );

    if (matchSet.length === 0) continue;

    let total = 0;
    let last: number | null = null;
    for (const te of matchSet) {
      total += te.totalViews ?? 0;
      const lv = te.lastView ? new Date(te.lastView).getTime() : null;
      if (lv !== null && (last === null || lv > last)) last = lv;
    }

    out.set(r.id, {
      isTracked: true,
      trackingTotalViews: total,
      trackingLastOpenedAt:
        last !== null ? new Date(last).toISOString() : null,
    });
  }
  return out;
}

export interface TrackingScope {
  personId?: string;
  organizationId?: string;
  householdId?: string;
}

/**
 * DB-backed enrichment. Fetches the candidate tracked rows (scoped to the
 * contact when a scope is given, else by the page's gmail message ids) with
 * their views aggregated, then runs the pure matcher.
 */
export async function computeTracking(
  rows: SentEmailLike[],
  scope: TrackingScope,
): Promise<Map<string, TrackingFields>> {
  const sent = rows.filter((r) => r.direction === "sent");
  if (sent.length === 0) return new Map();

  const scopePreds: SQL[] = [];
  if (scope.personId)
    scopePreds.push(
      sql`${trackedEmails.recipientPersonIds} @> ARRAY[${scope.personId}]::text[]`,
    );
  if (scope.organizationId)
    scopePreds.push(
      sql`${trackedEmails.recipientOrganizationIds} @> ARRAY[${scope.organizationId}]::text[]`,
    );
  if (scope.householdId)
    scopePreds.push(
      sql`${trackedEmails.recipientHouseholdIds} @> ARRAY[${scope.householdId}]::text[]`,
    );

  let whereExpr: SQL | undefined;
  if (scopePreds.length > 0) {
    // The activity feed always scopes by exactly ONE contact dimension, so
    // this is normally a single predicate. If callers ever pass more than one
    // they are OR-combined (not AND like the email-messages list): a tracked
    // email is xor-linked to a single donor type, so AND-combining person AND
    // funder predicates would never match any tracked row.
    whereExpr =
      scopePreds.length === 1 ? scopePreds[0]! : or(...scopePreds)!;
  } else {
    const gmailIds = sent
      .map((r) => r.gmailMessageId)
      .filter((x): x is string => !!x);
    if (gmailIds.length === 0) return new Map();
    whereExpr = inArray(trackedEmails.gmailMessageId, gmailIds);
  }

  const tracked = await db
    .select({
      id: trackedEmails.id,
      gmailMessageId: trackedEmails.gmailMessageId,
      sender: sql<string>`lower(${trackedEmails.sender})`,
      subject: sql<string>`lower(${trackedEmails.subject})`,
      createdAt: trackedEmails.createdAt,
      totalViews: sql<number>`COUNT(${trackedEmailViews.id})::int`,
      lastView: sql<Date | null>`MAX(${trackedEmailViews.viewedAt})`,
    })
    .from(trackedEmails)
    .leftJoin(
      trackedEmailViews,
      eq(trackedEmailViews.emailId, trackedEmails.id),
    )
    .where(whereExpr)
    .groupBy(trackedEmails.id);

  return matchSentEmailTracking(sent, tracked);
}
