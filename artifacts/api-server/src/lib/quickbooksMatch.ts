import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Scored matcher for QuickBooks staged payments. Resolves a staged payment to
 * a CRM donor (organization / person / household) and, when possible, an
 * existing gifts_and_payments row to reconcile against — instead of always
 * minting a new gift.
 *
 * Two scored axes plus an intermediary axis:
 *
 *   1. DONOR  — strongest signal first:
 *        email exact (100) → CRM name (trigram fuzzy / exact) → donor names
 *        parsed out of a free-text memo/reference. Name scoring uses pg_trgm
 *        `similarity()` against organizations.name / people.full_name /
 *        households.name (all GIN-trigram indexed). A name hit only counts as
 *        high-confidence when it is both strong AND unambiguous (one clear
 *        winner across all three tables).
 *
 *   2. EXISTING GIFT — once a donor is resolved, look for an already-recorded
 *        gift for that donor with the SAME amount within a date window. Exactly
 *        one ⇒ a reconcile target (matchedGiftId); zero ⇒ safe to mint a new
 *        gift; many ⇒ ambiguous, leave for a human. A donor is only ever taken
 *        from real evidence on the QuickBooks record (email, payer name, or a
 *        name in the memo) — never guessed from a coincidental amount/date
 *        collision with an unrelated gift.
 *
 *   3. INTERMEDIARY — when the payer name resolves to a payment intermediary
 *        (DAF / giving platform / wealth manager), the conduit is recorded and
 *        the real donor is sought in the memo.
 *
 * The result carries a 0–100 score, a method (audit + UI badge), and a tier
 * (high / suggested / none). The sync worker turns `high` into an auto-applied
 * action (reconcile if one gift matches, mint if none) and anything weaker into
 * a "needs review" hint. Follows the Donor XOR rule — at most one donor FK set.
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

export type MatchTier = "high" | "suggested" | "none";

export type MatchMethod =
  | "email"
  | "name"
  | "name_amount_date"
  | "memo"
  | "intermediary";

export interface ScoredMatch {
  donor: DonorMatch;
  /** Conduit the payer resolved to (DAF / platform), when applicable. */
  intermediaryId: string | null;
  /**
   * A pre-existing gift to reconcile against — set when there is an unambiguous
   * target: exactly one same-amount gift in the date window, or (when there is no
   * exact match) exactly one fee-band gift. Null when none (mint a new gift) or
   * many (ambiguous; a human chooses).
   */
  matchedGiftId: string | null;
  /** How many same-amount in-window gifts the resolved donor already has. */
  giftCandidateCount: number;
  /** 0–100 best confidence found. */
  score: number;
  method: MatchMethod | null;
  tier: MatchTier;
}

/** Score at/above which a match is auto-applied to the ledger. */
export const HIGH_THRESHOLD = 90;
/** Score at/above which a match is surfaced as a hint (but not applied). */
export const SUGGEST_THRESHOLD = 70;

/** ± days around the staged date that counts as the same gift. */
const GIFT_WINDOW_DAYS = 60;
/** Trigram similarity at/above which a payer is treated as an intermediary. */
const INTERMEDIARY_SIM = 0.6;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function tierFor(score: number): MatchTier {
  if (score >= HIGH_THRESHOLD) return "high";
  if (score >= SUGGEST_THRESHOLD) return "suggested";
  return "none";
}

/**
 * Donor names embedded in a free-text reference/memo. Many Donorbox→QuickBooks
 * deposits carry a blank CustomerRef and instead put the donor's name in the
 * memo, e.g. "Donation for BWF - Kathleen Rash" or "Contribution from Fidelity
 * Foundation". We pull the trailing segment after a dash and any name following
 * a "from / for / by" keyword. Candidates are kept conservative — at least two
 * whitespace-separated tokens — so acronyms and single common words never feed
 * the name matcher. Pure/synchronous for testing.
 */
export function candidateNamesFromReference(ref: string | null): string[] {
  if (!ref) return [];
  const norm = ref.replace(/\s+/g, " ").trim();
  if (!norm) return [];

  const out: string[] = [];
  const add = (s: string | undefined | null): void => {
    if (!s) return;
    const v = s.trim();
    if (v.length >= 4 && /\s/.test(v)) out.push(v);
  };

  const dash = norm.lastIndexOf(" - ");
  if (dash !== -1) add(norm.slice(dash + 3));

  const kw = norm.match(/\b(?:from|for|by)\s+(.+)$/i);
  if (kw) add(kw[1]);

  return [...new Set(out)];
}

interface NameHit {
  donor: DonorMatch;
  key: string;
  name: string;
  sim: number;
}

/**
 * Best fuzzy name candidates across organizations / people / households,
 * ordered by trigram similarity. Uses the `%` operator so the GIN trigram
 * indexes are used and only rows above the similarity threshold are returned.
 */
async function bestNameHits(name: string): Promise<NameHit[]> {
  const q = name.trim();
  if (q.length < 3) return [];
  const rows = (
    await db.execute(sql`
      SELECT id, kind, name, sim FROM (
        SELECT id, 'organization' AS kind, name AS name,
               similarity(name, ${q}) AS sim
          FROM organizations WHERE name % ${q}
        UNION ALL
        SELECT id, 'person' AS kind, full_name AS name,
               similarity(full_name, ${q}) AS sim
          FROM people WHERE full_name IS NOT NULL AND full_name % ${q}
        UNION ALL
        SELECT id, 'household' AS kind, name AS name,
               similarity(name, ${q}) AS sim
          FROM households WHERE name % ${q}
      ) t
      ORDER BY sim DESC
      LIMIT 10
    `)
  ).rows as Array<{ id: string; kind: string; name: string; sim: number }>;

  return rows.map((r) => {
    const donor: DonorMatch =
      r.kind === "organization"
        ? { ...NO_MATCH, organizationId: r.id }
        : r.kind === "person"
          ? { ...NO_MATCH, individualGiverPersonId: r.id }
          : { ...NO_MATCH, householdId: r.id };
    return { donor, key: `${r.kind}:${r.id}`, name: r.name, sim: Number(r.sim) };
  });
}

interface ScoredName {
  donor: DonorMatch;
  score: number;
}

/**
 * Turn a query string into a scored donor (or null). An exact case-insensitive
 * match scores 95 when unique. A fuzzy winner scores round(sim*100) when it is
 * clearly ahead of the next *different* donor (margin ≥ 0.08); ambiguous
 * winners are capped at the suggest ceiling so they never auto-apply.
 */
async function scoreName(name: string): Promise<ScoredName | null> {
  const hits = await bestNameHits(name);
  if (hits.length === 0) return null;

  const target = normalize(name);
  const exact = hits.filter((h) => normalize(h.name) === target);
  if (exact.length === 1) {
    return { donor: exact[0].donor, score: 95 };
  }
  if (exact.length > 1) {
    // Same spelling, different entities — genuinely ambiguous.
    return { donor: exact[0].donor, score: SUGGEST_THRESHOLD };
  }

  const best = hits[0];
  const nextDifferent = hits.find((h) => h.key !== best.key);
  const unique = !nextDifferent || best.sim - nextDifferent.sim >= 0.08;
  let score = Math.round(best.sim * 100);
  if (!unique) score = Math.min(score, SUGGEST_THRESHOLD);
  if (score < SUGGEST_THRESHOLD) return null;
  return { donor: best.donor, score };
}

function donorWhere(donor: DonorMatch) {
  if (donor.organizationId)
    return sql`organization_id = ${donor.organizationId}`;
  if (donor.individualGiverPersonId)
    return sql`individual_giver_person_id = ${donor.individualGiverPersonId}`;
  if (donor.householdId) return sql`household_id = ${donor.householdId}`;
  return null;
}

/**
 * Result of the existing-gift lookup for a resolved donor (each candidate carries
 * its date_received for the reconcile-target tiebreak):
 *   - `exact`         — gifts whose amount equals the staged amount (within a
 *                       cent). A single one — or, among several, a single one on
 *                       the payment's own date — is the auto-reconcile target;
 *                       that gift adopts no fee assumption.
 *   - `plausible`     — gifts in the wider amount band (the CRM gross gift can
 *                       sit just above the QB net deposit by a processor fee).
 *                       Gates auto-create (we mint only when NONE exist) and,
 *                       when there is exactly one and no exact match, is the
 *                       fee-band auto-reconcile target. Includes the exact ids.
 * Exclusion is evidence-kind-aware (see giftsInWindow): a gift already owned by
 * the SAME channel never counts, but a gift the OTHER channel booked stays a
 * valid target (parallel evidence for the same money).
 */
/**
 * The kind of money evidence being scored. Stripe charges and QuickBooks staged
 * payments are PARALLEL evidence for the same gift, so "already linked" is only a
 * conflict within the SAME kind (see giftsInWindow).
 */
export type EvidenceKind = "staged" | "charge";

/** A candidate gift with the date needed for the reconcile-target tiebreak. */
export interface GiftWindowCandidate {
  id: string;
  dateReceived: string | null;
}

interface GiftWindowResult {
  exact: GiftWindowCandidate[];
  plausible: GiftWindowCandidate[];
}

/**
 * Gifts for a donor within ±GIFT_WINDOW_DAYS of the staged date whose amount is
 * at or just above the staged amount (the fee band), ordered by amount then date
 * proximity.
 *
 * A gift already claimed by another money event is only excluded when that event
 * is the SAME evidence kind, because Stripe and QuickBooks are PARALLEL evidence
 * for one gift: a Stripe charge may legitimately reconcile to a gift a QuickBooks
 * payment already booked (the same money seen through two channels, resolved by
 * the book-once ledger), and vice versa — but never to a gift its OWN channel
 * already owns. Mirrors the anchor-kind-aware ownership the search path uses.
 * `evidenceKind` "staged" (default) keeps the status-quo behaviour of excluding
 * both channels; "charge" drops only the staged-payment exclusion.
 */
async function giftsInWindow(
  donor: DonorMatch,
  amount: string,
  dateReceived: string | null,
  evidenceKind: EvidenceKind = "staged",
): Promise<GiftWindowResult> {
  const where = donorWhere(donor);
  if (!where) return { exact: [], plausible: [] };
  const order = dateReceived
    ? sql`ORDER BY ABS(amount - ${amount}::numeric), ABS(date_received - ${dateReceived}::date) NULLS LAST`
    : sql`ORDER BY ABS(amount - ${amount}::numeric), date_received DESC NULLS LAST`;
  const dateClause = dateReceived
    ? sql`AND (date_received IS NULL OR ABS(date_received - ${dateReceived}::date) <= ${GIFT_WINDOW_DAYS})`
    : sql``;
  const notOwnedByCharge = sql`AND NOT EXISTS (
          SELECT 1 FROM stripe_staged_charges sc
          WHERE sc.matched_gift_id = g.id OR sc.created_gift_id = g.id
        )`;
  const notOwnedByStaged = sql`AND NOT EXISTS (
          SELECT 1 FROM staged_payments sp
          WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id
        )`;
  const ownershipClause =
    evidenceKind === "charge"
      ? notOwnedByCharge
      : sql`${notOwnedByStaged} ${notOwnedByCharge}`;
  const rows = (
    await db.execute(sql`
      SELECT id, amount, date_received::text AS date_received
      FROM gifts_and_payments g
      WHERE ${where}
        AND amount >= ${amount}::numeric - 0.01
        AND amount <= ${amount}::numeric * 1.10 + 1
        ${dateClause}
        ${ownershipClause}
      ${order}
      LIMIT 10
    `)
  ).rows as Array<{ id: string; amount: string; date_received: string | null }>;
  const target = Number(amount);
  const toCandidate = (r: {
    id: string;
    date_received: string | null;
  }): GiftWindowCandidate => ({ id: r.id, dateReceived: r.date_received });
  const exact = rows
    .filter((r) => Math.abs(Number(r.amount) - target) <= 0.01)
    .map(toCandidate);
  return { exact, plausible: rows.map(toCandidate) };
}

/**
 * The unambiguous auto-reconcile target among a donor's in-window gifts, or null
 * when ambiguous. Prefer a single EXACT-amount gift; when there is no exact
 * match, fall back to a single FEE-BAND gift (its gross sits just above the QB
 * net deposit by a processor fee).
 *
 * When SEVERAL exact-amount gifts exist (a recurring donor giving the same amount
 * month after month), the set is not blindly ambiguous: if exactly ONE of them
 * falls on the payment's own date (`anchorDate`), that is the unmistakable gift
 * to reconcile against — its siblings pair with their own months' payments. Any
 * other shape — several exact but none (or more than one) on the date, multiple
 * fee-band, or none — is ambiguous and yields null (a human picks, or a gift is
 * minted when there are none). `plausible` includes the exact ids.
 */
export function reconcileTarget(
  exact: GiftWindowCandidate[],
  plausible: GiftWindowCandidate[],
  anchorDate: string | null = null,
): string | null {
  if (exact.length === 1) return exact[0].id;
  if (exact.length === 0 && plausible.length === 1) return plausible[0].id;
  if (exact.length >= 2 && anchorDate) {
    const day = anchorDate.slice(0, 10);
    const sameDate = exact.filter((g) => (g.dateReceived ?? "").slice(0, 10) === day);
    if (sameDate.length === 1) return sameDate[0].id;
  }
  return null;
}

/** Email is the strongest donor signal — exact, owner-unique → 100. */
async function matchByEmail(email: string): Promise<DonorMatch | null> {
  const rows = (
    await db.execute(sql`
      SELECT person_id, organization_id, household_id
      FROM emails
      WHERE lower(email) = ${email.toLowerCase()}
    `)
  ).rows as Array<{
    person_id: string | null;
    organization_id: string | null;
    household_id: string | null;
  }>;
  if (rows.length === 0) return null;
  const owners = new Set<string>();
  let match: DonorMatch = NO_MATCH;
  for (const r of rows) {
    if (r.person_id) {
      owners.add(`p:${r.person_id}`);
      match = { ...NO_MATCH, individualGiverPersonId: r.person_id };
    } else if (r.organization_id) {
      owners.add(`o:${r.organization_id}`);
      match = { ...NO_MATCH, organizationId: r.organization_id };
    } else if (r.household_id) {
      owners.add(`h:${r.household_id}`);
      match = { ...NO_MATCH, householdId: r.household_id };
    }
  }
  return owners.size === 1 ? match : null;
}

/** Resolve a payer name to a payment intermediary (DAF / platform) by trigram. */
async function matchIntermediary(name: string): Promise<string | null> {
  const q = name.trim();
  if (q.length < 3) return null;
  const rows = (
    await db.execute(sql`
      SELECT id, similarity(name, ${q}) AS sim
      FROM payment_intermediaries
      WHERE name % ${q}
      ORDER BY sim DESC
      LIMIT 1
    `)
  ).rows as Array<{ id: string; sim: number }>;
  if (rows.length === 0) return null;
  return Number(rows[0].sim) >= INTERMEDIARY_SIM ? rows[0].id : null;
}

export interface ScoreInput {
  payerName: string | null;
  payerEmail: string | null;
  rawReference: string | null;
  lineDescription: string | null;
  amount: string | null;
  dateReceived: string | null;
  /**
   * The channel this row came from. "staged" (default) = a QuickBooks staged
   * payment — a candidate gift already claimed by ANOTHER staged payment OR by a
   * Stripe charge is off-limits. "charge" = a Stripe charge — only a gift owned
   * by another Stripe charge is off-limits; a gift a QuickBooks payment already
   * booked is parallel evidence for the same money and remains a valid target.
   */
  evidenceKind?: EvidenceKind;
}

const NO_SCORE: ScoredMatch = {
  donor: NO_MATCH,
  intermediaryId: null,
  matchedGiftId: null,
  giftCandidateCount: 0,
  score: 0,
  method: null,
  tier: "none",
};

/**
 * Score a staged payment against CRM donors and existing gifts. Pure of any
 * write side-effects — the sync/route layer decides what to do with the result.
 */
export async function scoreStagedPayment(
  input: ScoreInput,
): Promise<ScoredMatch> {
  const memo = [input.rawReference, input.lineDescription]
    .filter((s): s is string => !!s)
    .join(" ");

  // ── Intermediary axis: is the payer itself a conduit? ──
  const intermediaryId = input.payerName
    ? await matchIntermediary(input.payerName)
    : null;

  // ── Donor axis ──
  let donor: DonorMatch = NO_MATCH;
  let score = 0;
  let method: MatchMethod | null = null;

  // 1. Email exact.
  if (input.payerEmail) {
    const byEmail = await matchByEmail(input.payerEmail);
    if (byEmail) {
      donor = byEmail;
      score = 100;
      method = "email";
    }
  }

  // 2. Payer name (skipped when the payer is an intermediary — the name is the
  //    conduit, not the donor; look in the memo instead).
  if (!method && input.payerName && !intermediaryId) {
    const byName = await scoreName(input.payerName);
    if (byName) {
      donor = byName.donor;
      score = byName.score;
      method = "name";
    }
  }

  // 3. Donor names parsed from the memo / reference.
  if (!method) {
    for (const candidate of candidateNamesFromReference(memo)) {
      const byRef = await scoreName(candidate);
      if (byRef) {
        donor = byRef.donor;
        score = byRef.score;
        method = intermediaryId ? "intermediary" : "memo";
        break;
      }
    }
  }

  // ── Existing-gift axis ──
  let matchedGiftId: string | null = null;
  let giftCandidateCount = 0;
  if (method && input.amount) {
    const gifts = await giftsInWindow(
      donor,
      input.amount,
      input.dateReceived,
      input.evidenceKind ?? "staged",
    );
    // Mint-gate uses the full plausible (fee-band) set; the reconcile target is a
    // single exact-amount gift, or — when there is no exact match — a single
    // fee-band gift (the QB net deposit is the gift gross minus a processor fee).
    // The payment's own date breaks ties among several same-amount gifts.
    giftCandidateCount = gifts.plausible.length;
    matchedGiftId = reconcileTarget(gifts.exact, gifts.plausible, input.dateReceived);
    // Amount+date corroboration strengthens a name hit into name_amount_date.
    if (
      giftCandidateCount >= 1 &&
      (method === "name" || method === "memo") &&
      input.dateReceived
    ) {
      method = "name_amount_date";
      score = Math.max(score, HIGH_THRESHOLD);
    }
  }

  if (!method) {
    // Nothing on the donor axes; still surface the intermediary as a weak hint
    // for human review.
    return intermediaryId
      ? {
          ...NO_SCORE,
          intermediaryId,
          score: SUGGEST_THRESHOLD,
          tier: "suggested",
        }
      : NO_SCORE;
  }

  return {
    donor,
    intermediaryId,
    matchedGiftId,
    giftCandidateCount,
    score,
    method,
    tier: tierFor(score),
  };
}
