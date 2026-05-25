import { db } from "@workspace/db";
import { emails } from "@workspace/db/schema";
import { inArray, sql } from "drizzle-orm";

/**
 * Lookup which people / funders / households in the CRM are
 * associated with the given set of email addresses. Used by the
 * Gmail + Calendar sync workers to decide whether a message /
 * event is worth keeping.
 *
 * Filters:
 *   - mailboxOwnerEmail is dropped (don't match the sync user
 *     against themselves)
 *   - any address in `@wildflowerschools.org` is dropped — internal
 *     staff-to-staff threads pollute the donor timeline and the
 *     user explicitly opted them out at the matching layer (we
 *     still sync the message, we just route unmatched copies to
 *     the skip table — see the session plan note).
 *   - addresses are lowercased + deduped before query.
 *
 * Returns three deduped, sorted arrays of entity IDs. Empty array
 * (length 0) means "no match" — the worker treats that as the
 * skip path.
 *
 * NB: the `emails` table allows owners across five entity types
 * (person/funder/organization/payment_intermediary/household) but
 * the timeline surface only renders against people / funders /
 * households, so org / PI ownership is ignored on purpose. If we
 * ever want org timelines we'll add a fourth array here without
 * touching callers.
 */

const INTERNAL_DOMAINS = new Set(["wildflowerschools.org"]);

export interface EmailMatchResult {
  personIds: string[];
  funderIds: string[];
  householdIds: string[];
}

export const EMPTY_MATCH: EmailMatchResult = {
  personIds: [],
  funderIds: [],
  householdIds: [],
};

export function normalizeForMatching(
  addrs: Iterable<string>,
  mailboxOwnerEmail: string | null,
): string[] {
  const owner = mailboxOwnerEmail?.toLowerCase() ?? null;
  const out = new Set<string>();
  for (const raw of addrs) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (owner && a === owner) continue;
    const domain = a.split("@")[1];
    if (domain && INTERNAL_DOMAINS.has(domain)) continue;
    out.add(a);
  }
  return [...out];
}

export async function matchEmails(
  addresses: string[],
  mailboxOwnerEmail: string | null,
): Promise<EmailMatchResult> {
  const cleaned = normalizeForMatching(addresses, mailboxOwnerEmail);
  if (cleaned.length === 0) return EMPTY_MATCH;
  // lower(email) IN (cleaned). We have no functional index on
  // lower(email) yet — for the read volumes this is fine (the
  // `emails` table is in the low five-figures), but worth adding
  // an expression index later if email matching ever becomes hot.
  const rows = await db
    .select({
      personId: emails.personId,
      funderId: emails.funderId,
      householdId: emails.householdId,
    })
    .from(emails)
    .where(inArray(sql`lower(${emails.email})`, cleaned));

  const personIds = new Set<string>();
  const funderIds = new Set<string>();
  const householdIds = new Set<string>();
  for (const r of rows) {
    if (r.personId) personIds.add(r.personId);
    if (r.funderId) funderIds.add(r.funderId);
    if (r.householdId) householdIds.add(r.householdId);
  }
  return {
    personIds: [...personIds].sort(),
    funderIds: [...funderIds].sort(),
    householdIds: [...householdIds].sort(),
  };
}

export function isMatchEmpty(m: EmailMatchResult): boolean {
  return (
    m.personIds.length === 0 &&
    m.funderIds.length === 0 &&
    m.householdIds.length === 0
  );
}
