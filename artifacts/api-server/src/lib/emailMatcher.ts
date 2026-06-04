import { db } from "@workspace/db";
import {
  emails,
  organizations,
  personSuppressionWindows,
  internalEmailDomains,
} from "@workspace/db/schema";
import { and, eq, inArray, lte, or, sql, isNull, gte } from "drizzle-orm";
import { isFreeMailDomain } from "./freeMailDomains";

/**
 * Lookup which people / organizations / households in the CRM are
 * associated with the given set of email addresses. Used by the
 * Gmail + Calendar sync workers to decide whether a message /
 * event is worth keeping.
 *
 * Filters:
 *   - mailboxOwnerEmail is dropped (don't match the sync user
 *     against themselves)
 *   - any address in an internal domain (`@wildflowerschools.org` or
 *     `@blackwildflowers.org`) is dropped — internal staff-to-staff
 *     threads pollute the donor timeline and the user explicitly
 *     opted them out at the matching layer (we still sync the
 *     message, we just route unmatched copies to the skip table —
 *     see the session plan note).
 *   - addresses are lowercased + deduped before query.
 *   - personIds whose suppression window covers `messageDate` are
 *     excluded — e.g. a Wildflower staff member's personal address
 *     is suppressed during their employment window.
 *
 * Returns three deduped, sorted arrays of entity IDs. Empty array
 * (length 0) means "no match" — the worker treats that as the
 * skip path.
 *
 * NB: the `emails` table allows owners across five entity types
 * (person/organization/payment_intermediary/household) but
 * the timeline surface only renders against people / organizations /
 * households, so PI ownership is ignored on purpose. If we
 * ever want PI timelines we'll add a fourth array here without
 * touching callers.
 */

/**
 * Seed / fallback internal domains. Used when the singleton settings row
 * has not been created yet (so behavior is unchanged on rollout) and as the
 * default for the pure `normalizeForMatching` helper (keeps unit tests and
 * any non-DB callers behaving like the old hardcoded Set). Admins manage the
 * live list via the `internal_email_domains` settings table.
 */
export const DEFAULT_INTERNAL_DOMAINS: readonly string[] = [
  "wildflowerschools.org",
  "blackwildflowers.org",
];

// Short-lived in-memory cache of the configured internal domains. matchEmails
// runs once per synced message/event during sync, so we avoid a DB round-trip
// on every call. The Admin update route calls `invalidateInternalDomainsCache`
// so edits take effect immediately rather than after the TTL.
const INTERNAL_DOMAINS_TTL_MS = 60_000;
let internalDomainsCache: { value: Set<string>; expiresAt: number } | null =
  null;

export function invalidateInternalDomainsCache(): void {
  internalDomainsCache = null;
}

/**
 * Load the configured internal domains from the settings table, lowercased.
 * Falls back to `DEFAULT_INTERNAL_DOMAINS` when the singleton row does not
 * exist yet (pre-seed) so sync drops the original two domains unchanged.
 */
export async function loadInternalDomains(): Promise<Set<string>> {
  const now = Date.now();
  if (internalDomainsCache && internalDomainsCache.expiresAt > now) {
    return internalDomainsCache.value;
  }
  const rows = await db
    .select({ domains: internalEmailDomains.domains })
    .from(internalEmailDomains)
    .where(eq(internalEmailDomains.id, "singleton"));
  const row = rows[0];
  const value = row
    ? new Set(row.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))
    : new Set(DEFAULT_INTERNAL_DOMAINS);
  internalDomainsCache = { value, expiresAt: now + INTERNAL_DOMAINS_TTL_MS };
  return value;
}

export interface EmailMatchResult {
  personIds: string[];
  organizationIds: string[];
  householdIds: string[];
}

export const EMPTY_MATCH: EmailMatchResult = {
  personIds: [],
  organizationIds: [],
  householdIds: [],
};

export function normalizeForMatching(
  addrs: Iterable<string>,
  mailboxOwnerEmail: string | null,
  internalDomains: ReadonlySet<string> = new Set(DEFAULT_INTERNAL_DOMAINS),
): string[] {
  const owner = mailboxOwnerEmail?.toLowerCase() ?? null;
  const out = new Set<string>();
  for (const raw of addrs) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (owner && a === owner) continue;
    const domain = a.split("@")[1];
    if (domain && internalDomains.has(domain)) continue;
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

/**
 * Load the set of person IDs that have an active suppression window
 * covering `date`. A window covers date D when:
 *   (start_date IS NULL OR start_date <= D)
 *   AND (end_date IS NULL OR end_date >= D)
 */
async function loadSuppressedPersonIds(date: Date): Promise<Set<string>> {
  // Normalize to the start-of-day in UTC so window boundaries cover the
  // entire calendar day.  Without this, an endDate stored as midnight
  // would fail the `endDate >= messageDate` check for any message arriving
  // later in the same day, causing a false "not suppressed" result.
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ personId: personSuppressionWindows.personId })
    .from(personSuppressionWindows)
    .where(
      and(
        or(
          isNull(personSuppressionWindows.startDate),
          lte(personSuppressionWindows.startDate, dayStart),
        ),
        or(
          isNull(personSuppressionWindows.endDate),
          gte(personSuppressionWindows.endDate, dayStart),
        ),
      ),
    );
  return new Set(rows.map((r) => r.personId));
}

export async function matchEmails(
  addresses: string[],
  mailboxOwnerEmail: string | null,
  messageDate: Date = new Date(),
): Promise<EmailMatchResult> {
  const internalDomains = await loadInternalDomains();
  const cleaned = normalizeForMatching(
    addresses,
    mailboxOwnerEmail,
    internalDomains,
  );
  if (cleaned.length === 0) return EMPTY_MATCH;

  // Domains we'll match against organizations.email_domain so that mail
  // to/from an unrecognized person at a known org (e.g. a
  // new program officer we haven't added yet) still threads onto
  // the organization timeline. Internal domains are already stripped by
  // normalizeForMatching above. Free-mail domains (gmail.com, yahoo.com,
  // etc.) are excluded here so a free domain mistakenly stored in
  // organizations.email_domain can never attach every consumer-mail
  // attendee to that org — the exact-address lookup against `emails`
  // below is left untouched, so jane@gmail.com still matches directly.
  const domains = [
    ...new Set(
      cleaned
        .map(domainOf)
        .filter((d): d is string => !!d && !isFreeMailDomain(d)),
    ),
  ];

  // lower(email) IN (cleaned). We have no functional index on
  // lower(email) yet — for the read volumes this is fine (the
  // `emails` table is in the low five-figures), but worth adding
  // an expression index later if email matching ever becomes hot.
  const [addrRows, domainRows, suppressedIds] = await Promise.all([
    db
      .select({
        personId: emails.personId,
        organizationId: emails.organizationId,
        householdId: emails.householdId,
      })
      .from(emails)
      .where(inArray(sql`lower(${emails.email})`, cleaned)),
    domains.length === 0
      ? Promise.resolve([] as Array<{ organizationId: string }>)
      : db
          .select({ organizationId: organizations.id })
          .from(organizations)
          .where(inArray(sql`lower(${organizations.emailDomain})`, domains)),
    loadSuppressedPersonIds(messageDate),
  ]);

  const personIds = new Set<string>();
  const organizationIds = new Set<string>();
  const householdIds = new Set<string>();
  for (const r of addrRows) {
    if (r.personId && !suppressedIds.has(r.personId)) personIds.add(r.personId);
    if (r.organizationId) organizationIds.add(r.organizationId);
    if (r.householdId) householdIds.add(r.householdId);
  }
  for (const r of domainRows) {
    if (r.organizationId) organizationIds.add(r.organizationId);
  }
  return {
    personIds: [...personIds].sort(),
    organizationIds: [...organizationIds].sort(),
    householdIds: [...householdIds].sort(),
  };
}

export function isMatchEmpty(m: EmailMatchResult): boolean {
  return (
    m.personIds.length === 0 &&
    m.organizationIds.length === 0 &&
    m.householdIds.length === 0
  );
}
