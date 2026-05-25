import { db } from "@workspace/db";
import { emails, funders } from "@workspace/db/schema";
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

/**
 * Extract the lowercase domain part from a normalized address.
 * Returns null for malformed addresses (no `@`, empty domain).
 */
function domainOf(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const d = addr.slice(at + 1).trim();
  return d.length > 0 ? d : null;
}

export async function matchEmails(
  addresses: string[],
  mailboxOwnerEmail: string | null,
): Promise<EmailMatchResult> {
  const cleaned = normalizeForMatching(addresses, mailboxOwnerEmail);
  if (cleaned.length === 0) return EMPTY_MATCH;

  // Domains we'll match against funders.email_domain so that mail
  // to/from an unrecognized person at a known funder org (e.g. a
  // new program officer we haven't added yet) still threads onto
  // the funder timeline. Internal domains are already stripped by
  // normalizeForMatching above.
  const domains = [...new Set(cleaned.map(domainOf).filter((d): d is string => !!d))];

  // lower(email) IN (cleaned). We have no functional index on
  // lower(email) yet — for the read volumes this is fine (the
  // `emails` table is in the low five-figures), but worth adding
  // an expression index later if email matching ever becomes hot.
  const [addrRows, domainRows] = await Promise.all([
    db
      .select({
        personId: emails.personId,
        funderId: emails.funderId,
        householdId: emails.householdId,
      })
      .from(emails)
      .where(inArray(sql`lower(${emails.email})`, cleaned)),
    domains.length === 0
      ? Promise.resolve([] as Array<{ funderId: string }>)
      : db
          .select({ funderId: funders.id })
          .from(funders)
          .where(inArray(sql`lower(${funders.emailDomain})`, domains)),
  ]);

  const personIds = new Set<string>();
  const funderIds = new Set<string>();
  const householdIds = new Set<string>();
  for (const r of addrRows) {
    if (r.personId) personIds.add(r.personId);
    if (r.funderId) funderIds.add(r.funderId);
    if (r.householdId) householdIds.add(r.householdId);
  }
  for (const r of domainRows) {
    if (r.funderId) funderIds.add(r.funderId);
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
