import { db } from "@workspace/db";
import {
  emails,
  organizations,
  people,
  households,
} from "@workspace/db/schema";
import { and, eq, ilike, isNotNull, sql } from "drizzle-orm";

/**
 * Auto-match a staged QuickBooks payment to a CRM donor by email and then
 * name. A match is only returned when it is unambiguous (exactly one
 * candidate); anything ambiguous or absent stays unmatched so a human
 * makes the call. Follows the Donor XOR rule — at most one FK is set.
 */

export interface DonorMatch {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}

const NO_MATCH: DonorMatch = {
  organizationId: null,
  individualGiverPersonId: null,
  householdId: null,
};

/**
 * Email is the strongest signal. The `emails` table is owned by exactly
 * one of person / organization / household, so a single owning row maps
 * straight to a donor. Ambiguous (multiple distinct owners) → no match.
 */
async function matchByEmail(email: string): Promise<DonorMatch | null> {
  const rows = await db
    .select({
      personId: emails.personId,
      organizationId: emails.organizationId,
      householdId: emails.householdId,
    })
    .from(emails)
    .where(eq(sql`lower(${emails.email})`, email.toLowerCase()));
  if (rows.length === 0) return null;

  // Collapse to the distinct set of owning donors.
  const owners = new Set<string>();
  let match: DonorMatch = NO_MATCH;
  for (const r of rows) {
    if (r.personId) {
      owners.add(`p:${r.personId}`);
      match = { ...NO_MATCH, individualGiverPersonId: r.personId };
    } else if (r.organizationId) {
      owners.add(`o:${r.organizationId}`);
      match = { ...NO_MATCH, organizationId: r.organizationId };
    } else if (r.householdId) {
      owners.add(`h:${r.householdId}`);
      match = { ...NO_MATCH, householdId: r.householdId };
    }
  }
  return owners.size === 1 ? match : null;
}

/**
 * Name fallback. Tries organizations.name, people.fullName, and
 * households.name (case-insensitive exact). Only returns a match when the
 * name resolves to exactly one donor across ALL three tables combined.
 */
async function matchByName(name: string): Promise<DonorMatch | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const [orgs, ppl, hhs] = await Promise.all([
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(ilike(organizations.name, trimmed))
      .limit(2),
    db
      .select({ id: people.id })
      .from(people)
      .where(and(isNotNull(people.fullName), ilike(people.fullName, trimmed)))
      .limit(2),
    db
      .select({ id: households.id })
      .from(households)
      .where(ilike(households.name, trimmed))
      .limit(2),
  ]);

  const total = orgs.length + ppl.length + hhs.length;
  if (total !== 1) return null;
  if (orgs[0]) return { ...NO_MATCH, organizationId: orgs[0].id };
  if (ppl[0]) return { ...NO_MATCH, individualGiverPersonId: ppl[0].id };
  if (hhs[0]) return { ...NO_MATCH, householdId: hhs[0].id };
  return null;
}

/**
 * Donor names embedded in a free-text reference/memo. Many Donorbox→QuickBooks
 * deposits carry a blank CustomerRef and instead put the donor's name in the
 * memo, e.g. "Donation for BWF - Kathleen Rash" or "Contribution from Fidelity
 * Foundation". We pull the trailing segment after a dash and any name following
 * a "from / for / by" keyword. Candidates are kept conservative — at least two
 * whitespace-separated tokens — so acronyms and single common words never feed
 * the (strict, exact, unambiguous) name matcher. Pure/synchronous for testing.
 */
export function candidateNamesFromReference(ref: string | null): string[] {
  if (!ref) return [];
  const norm = ref.replace(/\s+/g, " ").trim();
  if (!norm) return [];

  const out: string[] = [];
  const add = (s: string | undefined | null): void => {
    if (!s) return;
    const v = s.trim();
    // Require a multi-token, reasonably long string to stay conservative.
    if (v.length >= 4 && /\s/.test(v)) out.push(v);
  };

  // "... - Kathleen Rash" → trailing segment after the LAST " - ".
  const dash = norm.lastIndexOf(" - ");
  if (dash !== -1) add(norm.slice(dash + 3));

  // "Contribution from Fidelity Foundation" / "Donation for Jane Doe".
  const kw = norm.match(/\b(?:from|for|by)\s+(.+)$/i);
  if (kw) add(kw[1]);

  return [...new Set(out)];
}

/**
 * Attempt email match first, then payer name, then names embedded in the raw
 * reference/memo. Returns the donor match plus whether it counts as "matched"
 * (exactly one confident donor). The reference fallback is purely additive —
 * it only fires when nothing else matched — and still requires a strict,
 * unambiguous CRM name hit, so it never weakens the existing guarantees.
 */
export async function autoMatchDonor(
  payerName: string | null,
  payerEmail: string | null,
  rawReference: string | null = null,
): Promise<{ match: DonorMatch; matched: boolean }> {
  if (payerEmail) {
    const byEmail = await matchByEmail(payerEmail);
    if (byEmail) return { match: byEmail, matched: true };
  }
  if (payerName) {
    const byName = await matchByName(payerName);
    if (byName) return { match: byName, matched: true };
  }
  for (const candidate of candidateNamesFromReference(rawReference)) {
    const byRef = await matchByName(candidate);
    if (byRef) return { match: byRef, matched: true };
  }
  return { match: NO_MATCH, matched: false };
}
