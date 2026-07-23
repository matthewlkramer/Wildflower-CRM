// Unified "complete-match" reconciler — read-only graph proposer (Phase E, slice A).
//
// Given a QuickBooks staged_payments row (the REQUIRED anchor) plus any Stripe
// payout/charge evidence, this module derives the proposed 4-node match graph —
// donor / gift / opportunity, with QB (+ optional Stripe) attached as evidence —
// WITHOUT mutating anything. It reuses the existing matchers
// (scoreStagedPayment / scoreStripeCharge) and the QuickBooks reconciler's
// candidate SQL (gift-candidates / gift-window / donor trigram search) so the
// auto-proposal here stays consistent with the legacy /staged-payments queue.
//
// Edge states mirror the contract (openapi ReconciliationEdgeState):
//   determined  — exactly one confident candidate, auto-locked (human may override)
//   ambiguous   — several plausible candidates; the human must choose
//   filter_only — only narrows the others (e.g. donor → which gift)
//   conflict    — a candidate disagrees with an already-locked node
//   none        — no candidate found
//   create      — (never emitted here; that is a human intent expressed at approve)
//
// Anonymous masking: the LIST card mirrors the legacy finance queue (raw names),
// but every candidate label surfaced here in the graph / search is masked when
// the viewer can't see the identity (org/person only; households never).

import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  opportunitiesAndPledges,
  organizations,
  people,
  households,
  stripePayouts,
  stripeStagedCharges,
  pledgeAllocations,
  pledgeExpectedPayments,
  settlementLinks,
} from "@workspace/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  HIGH_THRESHOLD,
  scoreStagedPayment,
  type DonorMatch,
  type MatchMethod,
  type ScoredMatch,
} from "./quickbooksMatch";
import { scoreStripeCharge } from "./stripeMatch";
import { amountWithinFeeBand } from "./reconciliationGate";
import {
  GIFT_MATCH_WINDOW_DAYS,
  giftMatchAmountBounds,
  giftMatchAmountBoundsKnownNet,
} from "./giftMatch";
import { stripeChargeSearchWhere } from "./stripeChargeSearch";
import {
  chargeStatusCaseText,
  chargeStatusWhere,
  stagedChargeTieLinkExists,
  stagedConfirmedSettlementLinkExists,
  stagedStatusSql,
  stagedStatusWhere,
} from "./derivedStatus";
import {
  giftCandidateJoins,
  giftCandidateSelect,
  stagedSearchWhere,
  escapeLike,
} from "../routes/quickbooks/shared";
import {
  DEFAULT_GIFT_ID_SQL,
  chargeIdOwningGiftExcludingCharge,
  qbLedgerSoleGiftIdForPayment,
  stripeLedgerGiftIdForCharge,
} from "./paymentApplications";
import { payoutStatusFromLink } from "./settlementLink";
import { personDisplayNameSql } from "./personNameSql";
import {
  ANON_LABEL,
  canSeeIdentity,
  maskName,
  type Viewer,
} from "./identityVisibility";

// ─── Contract-shaped local types (camelCase, mirror openapi schemas) ─────────

// "stripe" is NOT a graph node — it appears only as the candidate label on the
// un-anchored qb-search results when includeStripe is set (a Stripe staged
// charge, linkable via the per-charge link-gift path). The anchored
// /reconciliation/search/{nodeType} route rejects it.
export type RecNodeType = "qb" | "donor" | "gift" | "opportunity" | "stripe";
export type RecEdgeState =
  | "determined"
  | "ambiguous"
  | "filter_only"
  | "conflict"
  | "none"
  | "create";
export type RecCandidateSource =
  | "donor_xor"
  | "payment_on_pledge"
  | "name"
  | "email"
  | "amount_date"
  | "memo"
  | "intermediary"
  | "stripe"
  | "manual";
export type RecDonorKind = "organization" | "person" | "household";

export interface RecCandidate {
  nodeType: RecNodeType;
  id: string;
  label: string;
  sublabel: string | null;
  amount: string | null;
  date: string | null;
  confidence: number | null;
  source: RecCandidateSource | null;
  donorKind: RecDonorKind | null;
  /** For gift/opportunity candidates: the record id of the candidate's current
   *  donor, so the client can detect a picked-donor-vs-gift-donor mismatch. */
  donorId: string | null;
  alreadyLinkedStagedPaymentId: string | null;
  /** For QB staged-payment candidates (the reverse picker): the gift this
   *  payment is already matched to / created / group-reconciled onto, so the
   *  client can gray the row and offer an unlink to free it before re-linking. */
  alreadyLinkedGiftId: string | null;
  conflictReason: string | null;
  /** Structured discriminator behind conflictReason (qb-search pick lists):
   *  `excluded` is human-overridable (the confirm endpoints accept
   *  overrideExclusion to re-include in the same tx); the other kinds mean the
   *  row's money is already claimed and overriding would double-count. */
  conflictKind: "excluded" | "settled_elsewhere" | "tied_to_charge" | null;
}

export interface RecNode {
  nodeType: RecNodeType;
  state: RecEdgeState;
  selectedId: string | null;
  locked: boolean;
  candidates: RecCandidate[];
}

export interface RecEvidence {
  qb: {
    stagedPaymentId: string;
    amount: string | null;
    dateReceived: string | null;
    payerName: string | null;
    paymentMethod: string | null;
    docNumber: string | null;
    depositId: string | null;
  };
  stripe: {
    payoutId: string;
    chargeId: string | null;
    grossAmount: string | null;
    feeAmount: string | null;
    netAmount: string | null;
    chargeCount: number | null;
    reconciliationStatus: string | null;
  } | null;
}

export interface RecGraph {
  stagedPaymentId: string;
  nodes: RecNode[];
  evidence: RecEvidence;
  ready: boolean;
  blockers: string[];
}

export interface RecSearchParams {
  nodeType: RecNodeType;
  /** QB staged-payment anchor; "" when anchored on a Stripe charge instead. */
  stagedPaymentId: string;
  /** Stripe charge anchor (its GROSS amount + date); null for a QB anchor. */
  stripeChargeId: string | null;
  q: string | null;
  donorId: string | null;
  /**
   * Split mode (gift search only): candidate gifts are FRACTIONS of the payment,
   * not near-equal to it. Drops the lower amount bound, relaxes the date window,
   * and orders by date proximity/recency instead of proximity to the full amount.
   */
  split: boolean;
  days: number;
  limit: number;
  viewer: Viewer;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

type CandidateInit = Pick<RecCandidate, "nodeType" | "id" | "label"> &
  Partial<Omit<RecCandidate, "nodeType" | "id" | "label">>;

function candidate(init: CandidateInit): RecCandidate {
  return {
    sublabel: null,
    amount: null,
    date: null,
    confidence: null,
    source: null,
    donorKind: null,
    donorId: null,
    alreadyLinkedStagedPaymentId: null,
    alreadyLinkedGiftId: null,
    conflictReason: null,
    conflictKind: null,
    ...init,
  };
}

// Canonical person display chain (full → first+last → nickname); see
// lib/personNameSql.ts.
const personNameSql = personDisplayNameSql(people);

function methodToSource(m: MatchMethod | null): RecCandidateSource {
  const s = (m ?? "") as string;
  if (s === "email") return "email";
  if (s === "intermediary") return "intermediary";
  if (s === "memo") return "memo";
  if (s.includes("amount") || s.includes("date")) return "amount_date";
  return "name";
}

function donorPickFromMatch(
  d: DonorMatch,
): { kind: RecDonorKind; id: string } | null {
  if (d.organizationId) return { kind: "organization", id: d.organizationId };
  if (d.individualGiverPersonId)
    return { kind: "person", id: d.individualGiverPersonId };
  if (d.householdId) return { kind: "household", id: d.householdId };
  return null;
}

function donorPickFromStaged(s: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): { kind: RecDonorKind; id: string } | null {
  return donorPickFromMatch(s as DonorMatch);
}

const donorKey = (p: { kind: RecDonorKind; id: string }) => `${p.kind}:${p.id}`;

function donorEqGift(d: { kind: RecDonorKind; id: string }): SQL {
  return d.kind === "organization"
    ? eq(giftsAndPayments.organizationId, d.id)
    : d.kind === "person"
      ? eq(giftsAndPayments.individualGiverPersonId, d.id)
      : eq(giftsAndPayments.householdId, d.id);
}

function amountConfidence(anchor: string | null, gift: string | null): number {
  const a = Number(anchor);
  const g = Number(gift);
  if (!Number.isFinite(a) || !Number.isFinite(g) || a <= 0) return 80;
  const diffPct = Math.abs(g - a) / a;
  return Math.max(50, Math.round(100 - diffPct * 100));
}

// ─── Donor display + masking ─────────────────────────────────────────────────

interface DonorDisplay {
  kind: RecDonorKind;
  name: string | null;
  anonymous: boolean | null;
  ownerUserId: string | null;
}

async function loadDonorDisplays(
  pairs: Array<{ kind: RecDonorKind; id: string }>,
): Promise<Map<string, DonorDisplay>> {
  const map = new Map<string, DonorDisplay>();
  const orgIds = [
    ...new Set(pairs.filter((p) => p.kind === "organization").map((p) => p.id)),
  ];
  const personIds = [
    ...new Set(pairs.filter((p) => p.kind === "person").map((p) => p.id)),
  ];
  const hhIds = [
    ...new Set(pairs.filter((p) => p.kind === "household").map((p) => p.id)),
  ];

  const [orgs, persons, hhs] = await Promise.all([
    orgIds.length
      ? db
          .select({
            id: organizations.id,
            name: organizations.name,
            anonymous: organizations.anonymous,
            ownerUserId: organizations.ownerUserId,
          })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : Promise.resolve([] as Array<{
          id: string;
          name: string | null;
          anonymous: boolean | null;
          ownerUserId: string | null;
        }>),
    personIds.length
      ? db
          .select({
            id: people.id,
            name: personNameSql,
            anonymous: people.anonymous,
            ownerUserId: people.ownerUserId,
          })
          .from(people)
          .where(inArray(people.id, personIds))
      : Promise.resolve([] as Array<{
          id: string;
          name: string | null;
          anonymous: boolean | null;
          ownerUserId: string | null;
        }>),
    hhIds.length
      ? db
          .select({ id: households.id, name: households.name })
          .from(households)
          .where(inArray(households.id, hhIds))
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
  ]);

  for (const o of orgs)
    map.set(`organization:${o.id}`, {
      kind: "organization",
      name: o.name,
      anonymous: o.anonymous,
      ownerUserId: o.ownerUserId,
    });
  for (const p of persons)
    map.set(`person:${p.id}`, {
      kind: "person",
      name: p.name,
      anonymous: p.anonymous,
      ownerUserId: p.ownerUserId,
    });
  for (const h of hhs)
    map.set(`household:${h.id}`, {
      kind: "household",
      name: h.name,
      anonymous: null,
      ownerUserId: null,
    });
  return map;
}

function maskDonorDisplay(
  d: DonorDisplay | undefined,
  viewer: Viewer,
): { name: string; hidden: boolean } {
  if (!d) return { name: ANON_LABEL, hidden: false };
  if (d.kind === "household") return { name: d.name ?? "Household", hidden: false };
  const hidden = !canSeeIdentity(
    { anonymous: d.anonymous, ownerUserId: d.ownerUserId },
    viewer,
  );
  return { name: hidden ? ANON_LABEL : (d.name ?? "(unnamed)"), hidden };
}

// ─── Gift candidates (donor names + anon/owner for masking) ──────────────────

/**
 * Which anchor is searching for a gift to link to. This picks WHICH existing
 * link counts as an already-owned ("linked elsewhere") gift the UI disables:
 *
 *   - `staged`: a QuickBooks staged payment. A gift already tied to ANOTHER
 *     staged payment via the QB cash-application ledger is owned. (default)
 *   - `charge`: a Stripe charge. A gift's QB ledger row is EXPECTED here (same
 *     money, parallel evidence) so only ANOTHER Stripe charge already owning the
 *     gift disqualifies it — never the QB ledger.
 */
type GiftLinkAnchor =
  | { kind: "staged"; excludeStagedId: string }
  | { kind: "charge"; excludeChargeId: string };

function recGiftSelect(link: GiftLinkAnchor) {
  return {
    ...giftCandidateSelect(
      link.kind === "staged" ? link.excludeStagedId : "",
    ),
    // For a Stripe-charge anchor, the QB-ledger disable is wrong (QB + Stripe
    // are parallel evidence for one gift). Override it with the charge-ownership
    // guard: only another charge already tied to the gift disqualifies it.
    ...(link.kind === "charge"
      ? {
          alreadyLinkedStagedPaymentId: chargeIdOwningGiftExcludingCharge(
            DEFAULT_GIFT_ID_SQL,
            sql`${link.excludeChargeId}`,
          ),
        }
      : {}),
    // Override raw full_name with the COALESCE display name.
    individualGiverPersonName: personNameSql,
    organizationAnonymous: organizations.anonymous,
    organizationOwnerUserId: organizations.ownerUserId,
    individualGiverAnonymous: people.anonymous,
    individualGiverOwnerUserId: people.ownerUserId,
  };
}

type RecGiftRow = Awaited<ReturnType<typeof fetchGiftById>>;

// The shared gift↔payment matcher (amount band + date window) lives in
// ./giftMatch so every surface — this graph search, the reconciler card list,
// the QuickBooks candidate/window endpoints, and the ingest matcher — composes
// ONE definition and can never drift. See that module for the policy split
// (widened donor-scoped proposals vs strict gate-parity vs known-net charge).

async function fetchGiftCandidates(opts: {
  link: GiftLinkAnchor;
  donorFilter?: SQL;
  amount: string | null;
  date: string | null;
  days: number;
  limit: number;
  q?: string | null;
  split?: boolean;
}) {
  if (opts.amount == null) return [];
  const split = opts.split === true;
  const donorScoped = opts.donorFilter != null;
  // Split mode: candidate gifts are FRACTIONS of the payment, so accept any
  // positive gift up to the payment total (upper fee-band tolerance only). For a
  // 1:1 match, defer to the shared matcher (giftMatchAmountBounds) so this search
  // and the card queue's auto-proposal pool stay identical.
  const amountBound = split
    ? sql`(${giftsAndPayments.amount} > 0 AND ${giftsAndPayments.amount} <= ${opts.amount}::numeric * 1.10 + 1)`
    : giftMatchAmountBounds(
        sql`${giftsAndPayments.amount}`,
        sql`${opts.amount}::numeric`,
        donorScoped,
      );
  const q = (opts.q ?? "").trim();
  const textSearch = q.length >= 2;
  const conds: SQL[] = [isNull(giftsAndPayments.archivedAt)];
  if (opts.donorFilter) conds.push(opts.donorFilter);
  if (textSearch) {
    // Free-text search: the fundraiser is hunting for a SPECIFIC gift by name,
    // so the amount band + date window would only hide the very gift they want
    // (a gift booked at the net, in a different month, or well outside the
    // fee band). Drop those constraints and match across the gift name AND its
    // donor names (organization / household / person). alreadyLinkedStagedPaymentId
    // is still computed per row, so already-matched gifts still surface (grayed).
    const like = `%${escapeLike(q)}%`;
    const textMatch = or(
      ilike(giftsAndPayments.name, like),
      ilike(organizations.name, like),
      ilike(households.name, like),
      ilike(personNameSql, like),
    );
    if (textMatch) conds.push(textMatch);
  } else {
    conds.push(amountBound);
    // A lump payment routinely covers gifts booked across many months, so a tight
    // ± days window would hide legitimate split candidates: relax it in split mode
    // (order by recency below instead). For a donor-scoped 1:1 match, widen to at
    // least GIFT_MATCH_WINDOW_DAYS — the booked gift date routinely trails the
    // settlement/charge date. Otherwise keep the caller's window.
    const windowDays =
      !split && donorScoped
        ? Math.max(opts.days, GIFT_MATCH_WINDOW_DAYS)
        : opts.days;
    if (opts.date && !split)
      conds.push(
        sql`(${giftsAndPayments.dateReceived} IS NULL OR ABS(${giftsAndPayments.dateReceived} - ${opts.date}::date) <= ${windowDays})`,
      );
  }

  // 1:1 match: cluster by proximity to the full amount. Split: proximity to the
  // full amount is meaningless (candidates are fractions), so prefer date
  // proximity to the payment, then recency.
  const orderBy: SQL[] = [];
  if (!split)
    orderBy.push(
      sql`ABS(${giftsAndPayments.amount} - ${opts.amount}::numeric) ASC`,
    );
  if (opts.date)
    orderBy.push(
      sql`ABS(${giftsAndPayments.dateReceived} - ${opts.date}::date) ASC NULLS LAST`,
    );

  return giftCandidateJoins(
    db.select(recGiftSelect(opts.link)).from(giftsAndPayments).$dynamic(),
  )
    .where(and(...conds))
    .orderBy(...orderBy, desc(giftsAndPayments.dateReceived))
    .limit(opts.limit);
}

async function fetchGiftById(id: string, link: GiftLinkAnchor) {
  return giftCandidateJoins(
    db.select(recGiftSelect(link)).from(giftsAndPayments).$dynamic(),
  )
    .where(eq(giftsAndPayments.id, id))
    .limit(1)
    .then((r) => r[0] ?? null);
}

function giftDonorHidden(g: NonNullable<RecGiftRow>, viewer: Viewer): boolean {
  if (g.organizationName != null)
    return !canSeeIdentity(
      { anonymous: g.organizationAnonymous, ownerUserId: g.organizationOwnerUserId },
      viewer,
    );
  if (g.individualGiverPersonName != null)
    return !canSeeIdentity(
      {
        anonymous: g.individualGiverAnonymous,
        ownerUserId: g.individualGiverOwnerUserId,
      },
      viewer,
    );
  return false;
}

function giftDonorSublabel(
  g: NonNullable<RecGiftRow>,
  viewer: Viewer,
): string | null {
  if (g.organizationName != null)
    return maskName(
      g.organizationName,
      { anonymous: g.organizationAnonymous, ownerUserId: g.organizationOwnerUserId },
      viewer,
    );
  if (g.individualGiverPersonName != null)
    return maskName(
      g.individualGiverPersonName,
      {
        anonymous: g.individualGiverAnonymous,
        ownerUserId: g.individualGiverOwnerUserId,
      },
      viewer,
    );
  if (g.householdName != null) return g.householdName;
  return null;
}

function giftRowToCandidate(
  g: NonNullable<RecGiftRow>,
  anchorAmount: string | null,
  viewer: Viewer,
  split = false,
): RecCandidate {
  const hidden = giftDonorHidden(g, viewer);
  const donor = donorPickFromStaged(g);
  return candidate({
    nodeType: "gift",
    id: g.id,
    label: hidden ? ANON_LABEL : (g.name ?? "(untitled gift)"),
    sublabel: giftDonorSublabel(g, viewer),
    amount: g.amount ?? null,
    date: g.dateReceived ?? null,
    // Split candidates are fractions of the payment; an amount-confidence score
    // against the full payment is meaningless, so leave it null.
    confidence: split ? null : amountConfidence(anchorAmount, g.amount ?? null),
    source: "amount_date",
    donorKind: donor?.kind ?? null,
    donorId: donor?.id ?? null,
    alreadyLinkedStagedPaymentId: g.alreadyLinkedStagedPaymentId ?? null,
  });
}

// ─── Opportunity candidates ──────────────────────────────────────────────────

const oppCols = {
  id: opportunitiesAndPledges.id,
  name: opportunitiesAndPledges.name,
  organizationId: opportunitiesAndPledges.organizationId,
  individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
  householdId: opportunitiesAndPledges.householdId,
  askAmount: opportunitiesAndPledges.askAmount,
  awardedAmount: opportunitiesAndPledges.awardedAmount,
  writtenPledge: opportunitiesAndPledges.writtenPledge,
  status: opportunitiesAndPledges.status,
};
type OppRow = {
  id: string;
  name: string | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  askAmount: string | null;
  awardedAmount: string | null;
  writtenPledge: boolean | null;
  status: string | null;
};

function oppDonorPair(o: OppRow): { kind: RecDonorKind; id: string } | null {
  return donorPickFromMatch(o as DonorMatch);
}

function oppToCandidate(
  o: OppRow,
  displays: Map<string, DonorDisplay>,
  viewer: Viewer,
  source: RecCandidateSource,
  confidence: number | null = null,
): RecCandidate {
  const pair = oppDonorPair(o);
  const masked = maskDonorDisplay(
    pair ? displays.get(donorKey(pair)) : undefined,
    viewer,
  );
  return candidate({
    nodeType: "opportunity",
    id: o.id,
    label: masked.hidden ? ANON_LABEL : (o.name ?? "(untitled opportunity)"),
    sublabel: masked.name,
    amount: o.awardedAmount ?? o.askAmount ?? null,
    confidence,
    source,
    donorKind: pair?.kind ?? null,
    donorId: pair?.id ?? null,
  });
}

async function loadOpp(id: string): Promise<OppRow | null> {
  return db
    .select(oppCols)
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, id))
    .limit(1)
    .then((r) => (r[0] as OppRow | undefined) ?? null);
}

interface ScoredOpp {
  opp: OppRow;
  /** Amount-fit confidence (50–100) of the incoming payment against this opp, or
   *  null when the evidence amount is unknown. */
  confidence: number | null;
}

// Donor-derived opportunity SUGGESTIONS for the gift's "is this a payment on a
// pledge?" node. Two layers of plausibility keep the list to MATERIALLY LIKELY
// matches instead of every open opp for the donor:
//
//   1. Status filter — only still-COLLECTIBLE opps (exclude fully-paid `cash_in`,
//      `dormant`, `lost`) so closed records are never offered.
//   2. Amount/date discipline (mirrors gift matching) — a payment can't exceed
//      what's still collectible (awarded − paid) beyond the processor-fee
//      tolerance, so over-large payments are dropped. Survivors are ranked by how
//      well the payment fits: a final/full payment (≈ remaining or ≈ awarded)
//      scores highest, a partial installment lower but still plausible; written
//      pledges (the prime payment-on-pledge target) come first, then amount-fit,
//      then nearest expected-payment date, then name. Date is a soft RANKING
//      signal only — installments legitimately span time, so it's never a hard
//      filter. Opps not yet awarded can't be amount-assessed, so they're kept as
//      lower-ranked first-payment candidates.
//
// A reviewer who needs a closed/other opp can still find it via manual search.
async function loadDonorOpps(
  donor: { kind: RecDonorKind; id: string },
  anchorAmount: string | null,
  paymentDate: string | null,
  limit: number,
): Promise<ScoredOpp[]> {
  const rows = (await db
    .select(oppCols)
    .from(opportunitiesAndPledges)
    .where(
      and(
        isNull(opportunitiesAndPledges.archivedAt),
        sql`(${opportunitiesAndPledges.status} IS NULL OR ${opportunitiesAndPledges.status} NOT IN ('cash_in', 'dormant', 'lost'))`,
        donor.kind === "organization"
          ? eq(opportunitiesAndPledges.organizationId, donor.id)
          : donor.kind === "person"
            ? eq(opportunitiesAndPledges.individualGiverPersonId, donor.id)
            : eq(opportunitiesAndPledges.householdId, donor.id),
      ),
    )) as OppRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  // paid-so-far per opp (SUM of linked non-archived gift amounts — mirrors the
  // `paid` rollup that drives cash_in derivation in pledgeStage.ts).
  const paidRows = await db
    .select({
      opportunityId: giftsAndPayments.opportunityId,
      paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
    })
    .from(giftsAndPayments)
    .where(
      and(
        inArray(giftsAndPayments.opportunityId, ids),
        isNull(giftsAndPayments.archivedAt),
      ),
    )
    .groupBy(giftsAndPayments.opportunityId);
  const paidByOpp = new Map<string, number>();
  for (const r of paidRows) {
    if (r.opportunityId) paidByOpp.set(r.opportunityId, Number(r.paid) || 0);
  }

  // nearest expected-payment date per opp — a soft ranking signal only
  // (smaller day-distance = sooner-due installment). Task #788: reads the
  // installment schedule (pledge_expected_payments), not the deprecated
  // per-allocation expected_payment_date.
  const dateDiffByOpp = new Map<string, number>();
  if (paymentDate) {
    const dateRows = await db
      .select({
        opportunityId: pledgeExpectedPayments.pledgeOrOpportunityId,
        diffDays: sql<number>`MIN(ABS(${pledgeExpectedPayments.expectedDate} - ${paymentDate}::date))`,
      })
      .from(pledgeExpectedPayments)
      .where(inArray(pledgeExpectedPayments.pledgeOrOpportunityId, ids))
      .groupBy(pledgeExpectedPayments.pledgeOrOpportunityId);
    for (const r of dateRows) {
      if (r.opportunityId && r.diffDays != null)
        dateDiffByOpp.set(r.opportunityId, Number(r.diffDays));
    }
  }

  const A = anchorAmount != null ? Number(anchorAmount) : null;
  const haveAmount = A != null && Number.isFinite(A) && A > 0;

  const scored: ScoredOpp[] = [];
  for (const opp of rows) {
    const awarded =
      opp.awardedAmount != null ? Number(opp.awardedAmount) : null;
    const ask = opp.askAmount != null ? Number(opp.askAmount) : null;
    const target =
      awarded != null && awarded > 0
        ? awarded
        : ask != null && ask > 0
          ? ask
          : null;
    const paid = paidByOpp.get(opp.id) ?? 0;
    // collectible balance is only knowable once an amount has been awarded.
    const remaining =
      awarded != null && awarded > 0 ? Math.max(0, awarded - paid) : null;

    // Amount plausibility FILTER: a payment can't exceed what's still
    // collectible, beyond the processor-fee tolerance. Enforced only when both
    // the incoming amount and a known remaining balance exist.
    if (haveAmount && remaining != null) {
      if (remaining <= 0 || (A as number) > remaining * 1.1 + 1) continue;
    }

    // Amount-fit confidence: best fit of the payment to the remaining balance
    // (final payment) or the full target (single full payment); a smaller
    // installment that still fits keeps a plausible baseline.
    let confidence: number | null = null;
    if (haveAmount) {
      const fits: number[] = [];
      if (remaining != null && remaining > 0)
        fits.push(amountConfidence(String(remaining), anchorAmount));
      if (target != null) fits.push(amountConfidence(String(target), anchorAmount));
      confidence = fits.length ? Math.max(...fits) : 70;
      const collectible = remaining ?? target ?? null;
      if (collectible != null && (A as number) <= collectible * 1.1 + 1)
        confidence = Math.max(confidence, 65);
    }
    scored.push({ opp, confidence });
  }

  scored.sort((a, b) => {
    const wp =
      Number(b.opp.writtenPledge ?? false) - Number(a.opp.writtenPledge ?? false);
    if (wp !== 0) return wp;
    const ca = a.confidence ?? -1;
    const cb = b.confidence ?? -1;
    if (cb !== ca) return cb - ca;
    const da = dateDiffByOpp.get(a.opp.id);
    const dbb = dateDiffByOpp.get(b.opp.id);
    if (da != null && dbb != null && da !== dbb) return da - dbb;
    if ((da == null) !== (dbb == null)) return da == null ? 1 : -1;
    return (a.opp.name ?? "").localeCompare(b.opp.name ?? "");
  });

  return scored.slice(0, limit);
}

// ─── Build the read-only graph ───────────────────────────────────────────────

const GRAPH_GIFT_WINDOW_DAYS = 60;

export async function buildReconciliationGraph(
  stagedPaymentId: string,
  viewer: Viewer,
): Promise<RecGraph | null> {
  // Full row + the DERIVED status (the EXISTS arms — settlement link, counted
  // ledger row — can't be derived from the row's own columns).
  const staged = await db
    .select({
      ...getTableColumns(stagedPayments),
      status: stagedStatusSql,
      // Ledger-derived resolved gift (the legacy staged gift-link columns are
      // @deprecated and never read): the single counted QB ledger gift, or
      // null (pending / excluded / settlement-only / split).
      ledgerSoleGiftId: qbLedgerSoleGiftIdForPayment(),
    })
    .from(stagedPayments)
    .where(eq(stagedPayments.id, stagedPaymentId))
    .then((r) => r[0]);
  if (!staged) return null;

  // ── Evidence: QB anchor (always) + optional Stripe payout/charge ──
  // The payout tied to this deposit is now resolved through the authoritative
  // settlement_links row (one `deposit_staged_payment_id`, covering proposed /
  // confirmed / conflict), not the legacy pointer columns.
  const stripePayout = await db
    .select({
      id: stripePayouts.id,
      amount: stripePayouts.amount,
      feeTotal: stripePayouts.feeTotal,
      netTotal: stripePayouts.netTotal,
      lifecycle: settlementLinks.lifecycle,
      conflictGiftId: settlementLinks.conflictGiftId,
    })
    .from(settlementLinks)
    .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
    .where(eq(settlementLinks.depositStagedPaymentId, stagedPaymentId))
    .limit(1)
    .then((r) => r[0] ?? null);

  let stripeEvidence: RecEvidence["stripe"] = null;
  let singleStripeCharge: {
    payerName: string | null;
    payerEmail: string | null;
    description: string | null;
    statementDescriptor: string | null;
    grossAmount: string | null;
    dateReceived: string | null;
  } | null = null;

  if (stripePayout) {
    const charges = await db
      .select({
        id: stripeStagedCharges.id,
        grossAmount: stripeStagedCharges.grossAmount,
        feeAmount: stripeStagedCharges.feeAmount,
        netAmount: stripeStagedCharges.netAmount,
        payerName: stripeStagedCharges.payerName,
        payerEmail: stripeStagedCharges.payerEmail,
        description: stripeStagedCharges.description,
        statementDescriptor: stripeStagedCharges.statementDescriptor,
        dateReceived: stripeStagedCharges.dateReceived,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.stripePayoutId, stripePayout.id));
    const single = charges.length === 1 ? charges[0] : null;
    if (single) singleStripeCharge = single;
    stripeEvidence = {
      payoutId: stripePayout.id,
      chargeId: single?.id ?? null,
      grossAmount: single?.grossAmount ?? null,
      feeAmount: single?.feeAmount ?? stripePayout.feeTotal,
      netAmount: single?.netAmount ?? stripePayout.netTotal ?? stripePayout.amount,
      chargeCount: charges.length,
      reconciliationStatus: payoutStatusFromLink(stripePayout),
    };
  }

  // The reconciliation anchor amount: Stripe GROSS takes precedence over the
  // QB net when a single charge backs the same money (matches the stamp rule).
  // (Legacy unit_groups membership is no longer read — retired,
  // docs/adr-linear-money-model.md; a combined match books one counted
  // ledger row per member via multi-match instead.)
  const anchorAmount = stripeEvidence?.grossAmount ?? staged.amount;

  // ── Donor node ──
  const qbScore = await scoreStagedPayment({
    payerName: staged.payerName,
    payerEmail: staged.payerEmail,
    rawReference: staged.rawReference,
    lineDescription: staged.lineDescription,
    amount: staged.amount,
    dateReceived: staged.dateReceived,
  });
  let stripeScore: ScoredMatch | null = null;
  if (singleStripeCharge) {
    stripeScore = await scoreStripeCharge({
      payerName: singleStripeCharge.payerName,
      payerEmail: singleStripeCharge.payerEmail,
      description: singleStripeCharge.description,
      statementDescriptor: singleStripeCharge.statementDescriptor,
      grossAmount: singleStripeCharge.grossAmount,
      dateReceived: singleStripeCharge.dateReceived,
    });
  }

  type DonorPick = {
    kind: RecDonorKind;
    id: string;
    confidence: number;
    source: RecCandidateSource;
  };
  const rawPicks: DonorPick[] = [];
  const saved = donorPickFromStaged(staged);
  if (saved) {
    const conf =
      staged.matchStatus === "matched"
        ? 95
        : staged.matchStatus === "suggested"
          ? 72
          : 60;
    rawPicks.push({ ...saved, confidence: conf, source: "donor_xor" });
  }
  const qbDonor = donorPickFromMatch(qbScore.donor);
  if (qbDonor)
    rawPicks.push({
      ...qbDonor,
      confidence: qbScore.score,
      source: methodToSource(qbScore.method),
    });
  if (stripeScore) {
    const sDonor = donorPickFromMatch(stripeScore.donor);
    if (sDonor)
      rawPicks.push({
        ...sDonor,
        confidence: stripeScore.score,
        source: "stripe",
      });
  }

  const byKey = new Map<string, DonorPick>();
  for (const p of rawPicks) {
    const ex = byKey.get(donorKey(p));
    if (!ex || p.confidence > ex.confidence) byKey.set(donorKey(p), p);
  }
  const distinctPicks = [...byKey.values()].sort(
    (a, b) => b.confidence - a.confidence,
  );

  const donorDisplays = await loadDonorDisplays(distinctPicks);
  const donorCandidates: RecCandidate[] = distinctPicks.map((p) => {
    const masked = maskDonorDisplay(donorDisplays.get(donorKey(p)), viewer);
    return candidate({
      nodeType: "donor",
      id: p.id,
      label: masked.name,
      confidence: Math.round(p.confidence),
      source: p.source,
      donorKind: p.kind,
    });
  });

  const confident = distinctPicks.filter((p) => p.confidence >= HIGH_THRESHOLD);
  let donorState: RecEdgeState;
  let donorSelectedId: string | null = null;
  let donorLocked = false;
  let selectedDonor: { kind: RecDonorKind; id: string } | null = null;
  if (distinctPicks.length === 0) {
    donorState = "none";
  } else if (confident.length === 1) {
    donorState = "determined";
    donorSelectedId = confident[0].id;
    donorLocked = true;
    selectedDonor = { kind: confident[0].kind, id: confident[0].id };
  } else {
    // Either several confident-but-disagreeing donors, or none confident.
    donorState = "ambiguous";
    donorSelectedId = distinctPicks[0].id;
    selectedDonor = { kind: distinctPicks[0].kind, id: distinctPicks[0].id };
  }
  // Only narrow gifts by the donor when the donor is actually locked.
  const giftDonorFilter = donorState === "determined" ? selectedDonor : null;

  // ── Gift node ──
  const resolvedGiftId = staged.ledgerSoleGiftId ?? null;

  let giftRows: NonNullable<RecGiftRow>[] = [];
  let giftCandidates: RecCandidate[] = [];
  let giftState: RecEdgeState;
  let giftSelectedId: string | null = null;
  let giftLocked = false;
  let selectedGiftRow: NonNullable<RecGiftRow> | null = null;

  if (resolvedGiftId) {
    const g = await fetchGiftById(resolvedGiftId, {
      kind: "staged",
      excludeStagedId: stagedPaymentId,
    });
    if (g) {
      giftRows = [g];
      giftCandidates = [giftRowToCandidate(g, anchorAmount, viewer)];
      giftState = "determined";
      giftSelectedId = g.id;
      giftLocked = true;
      selectedGiftRow = g;
    } else {
      giftState = "none";
    }
  } else {
    giftRows = (await fetchGiftCandidates({
      link: { kind: "staged", excludeStagedId: stagedPaymentId },
      donorFilter: giftDonorFilter ? donorEqGift(giftDonorFilter) : undefined,
      amount: anchorAmount,
      date: staged.dateReceived,
      days: GRAPH_GIFT_WINDOW_DAYS,
      limit: 25,
    })) as NonNullable<RecGiftRow>[];
    giftCandidates = giftRows.map((g) =>
      giftRowToCandidate(g, anchorAmount, viewer),
    );
    const selectable = giftRows.filter(
      (g) => g.alreadyLinkedStagedPaymentId == null,
    );
    if (giftDonorFilter && selectable.length === 1) {
      giftState = "determined";
      giftSelectedId = selectable[0].id;
      giftLocked = true;
      selectedGiftRow = selectable[0];
    } else if (selectable.length >= 1) {
      giftState = "ambiguous";
      giftSelectedId = selectable[0].id;
    } else {
      giftState = "none";
    }
  }

  // ── Opportunity node (derive-and-lock from the gift's pledge link, else
  //    the donor's opportunities as optional filter candidates) ──
  let oppState: RecEdgeState = "none";
  let oppSelectedId: string | null = null;
  let oppLocked = false;
  let oppCandidates: RecCandidate[] = [];

  const pledgeId = selectedGiftRow?.opportunityId ?? null;
  if (pledgeId) {
    const opp = await loadOpp(pledgeId);
    if (opp) {
      const displays = await loadDonorDisplays(
        [oppDonorPair(opp)].filter(
          (x): x is { kind: RecDonorKind; id: string } => x != null,
        ),
      );
      oppCandidates = [oppToCandidate(opp, displays, viewer, "payment_on_pledge")];
      oppState = "determined";
      oppSelectedId = opp.id;
      oppLocked = true;
    }
  } else if (selectedDonor) {
    const scored = await loadDonorOpps(
      selectedDonor,
      anchorAmount,
      staged.dateReceived,
      25,
    );
    const displays = await loadDonorDisplays(
      scored
        .map((s) => oppDonorPair(s.opp))
        .filter((x): x is { kind: RecDonorKind; id: string } => x != null),
    );
    oppCandidates = scored.map((s) =>
      oppToCandidate(
        s.opp,
        displays,
        viewer,
        s.opp.writtenPledge ? "payment_on_pledge" : "manual",
        s.confidence,
      ),
    );
    oppState = oppCandidates.length ? "filter_only" : "none";
  }

  // ── Ready + blockers ──
  const blockers: string[] = [];
  if (staged.status !== "pending") {
    const stripeAwaiting =
      stripeEvidence != null &&
      (stripeEvidence.reconciliationStatus === "proposed" ||
        stripeEvidence.reconciliationStatus === "conflict_approved");
    if (staged.status === "match_confirmed" && stripeAwaiting) {
      // The QB→gift side is done; only the Stripe payout still needs a human to
      // confirm tying it in. Say so explicitly instead of a flat "Already
      // matched." so the reviewer knows which track is outstanding.
      blockers.push(
        "QuickBooks is already matched into a gift — only the Stripe payout is still awaiting confirmation.",
      );
    } else if (staged.status === "match_confirmed") {
      blockers.push("Already matched.");
    } else if (staged.status === "excluded") {
      blockers.push("Already excluded.");
    } else {
      // match_proposed: an auto-applied match awaiting human review — the
      // reviewer confirms (or re-targets) it; it is not one-click ready.
      blockers.push("An auto-proposed match is awaiting confirmation.");
    }
  }
  if (donorState === "none")
    blockers.push("No donor identified — choose a donor.");
  else if (donorState !== "determined")
    blockers.push("Donor is ambiguous — confirm which donor.");
  if (giftState === "none")
    blockers.push("No matching gift — create one or pick manually.");
  else if (giftState !== "determined")
    blockers.push("Multiple candidate gifts — choose one.");
  if (
    donorState === "determined" &&
    giftState === "determined" &&
    selectedGiftRow &&
    anchorAmount != null &&
    selectedGiftRow.amount != null &&
    !amountWithinFeeBand(
      anchorAmount,
      selectedGiftRow.amount,
      stripeEvidence?.netAmount ?? null,
    )
  ) {
    blockers.push(
      "Gift amount differs from the evidence beyond the processor fee — enter an override reason to approve.",
    );
  }
  const ready = blockers.length === 0;

  const nodes: RecNode[] = [
    {
      nodeType: "donor",
      state: donorState,
      selectedId: donorSelectedId,
      locked: donorLocked,
      candidates: donorCandidates,
    },
    {
      nodeType: "gift",
      state: giftState,
      selectedId: giftSelectedId,
      locked: giftLocked,
      candidates: giftCandidates,
    },
    {
      nodeType: "opportunity",
      state: oppState,
      selectedId: oppSelectedId,
      locked: oppLocked,
      candidates: oppCandidates,
    },
  ];

  const evidence: RecEvidence = {
    qb: {
      stagedPaymentId: staged.id,
      amount: staged.amount,
      dateReceived: staged.dateReceived,
      payerName: staged.payerName,
      paymentMethod: staged.qbPaymentMethod,
      docNumber: staged.qbDocNumber,
      depositId: staged.qbDepositId,
    },
    stripe: stripeEvidence,
  };

  return { stagedPaymentId: staged.id, nodes, evidence, ready, blockers };
}

// ─── Scoped, cross-filtering search for one node ─────────────────────────────

export async function searchReconciliationNode(
  p: RecSearchParams,
): Promise<RecCandidate[] | null> {
  // A Stripe charge anchor (settlement-bundle charge row with no staged
  // payment). It anchors gift search on its GROSS amount + date (matching the
  // confirm rule "Stripe GROSS wins") and supports only donor/gift — opp/qb
  // genuinely require a staged anchor and are rejected upstream in the route.
  if (p.stripeChargeId) {
    const charge = await db
      .select({
        grossAmount: stripeStagedCharges.grossAmount,
        dateReceived: stripeStagedCharges.dateReceived,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, p.stripeChargeId))
      .then((r) => r[0]);
    if (!charge) return null;
    switch (p.nodeType) {
      case "donor":
        return searchDonors(p);
      case "gift":
        // Stripe-charge anchor: a candidate gift's QB ledger row is EXPECTED
        // (same money, parallel evidence), so the "already linked" flag must
        // reflect ownership by ANOTHER Stripe charge — never the QB ledger.
        return searchGifts(
          {
            amount: charge.grossAmount,
            date: charge.dateReceived,
            link: { kind: "charge", excludeChargeId: p.stripeChargeId },
          },
          p,
        );
      default:
        return [];
    }
  }

  const staged = await db
    .select()
    .from(stagedPayments)
    .where(eq(stagedPayments.id, p.stagedPaymentId))
    .then((r) => r[0]);
  if (!staged) return null;

  switch (p.nodeType) {
    case "donor":
      return searchDonors(p);
    case "gift":
      return searchGifts(
        {
          amount: staged.amount,
          date: staged.dateReceived,
          link: { kind: "staged", excludeStagedId: p.stagedPaymentId },
        },
        p,
      );
    case "opportunity":
      return searchOpps(p);
    case "qb":
      return searchQb(p);
    default:
      return [];
  }
}

/** The resolved money-event anchor for gift search (QB staged OR Stripe charge). */
interface GiftSearchAnchor {
  amount: string | null;
  date: string | null;
  /**
   * Which existing link disqualifies a candidate gift ("already linked"). QB
   * staged anchors exclude by the QB ledger; Stripe-charge anchors exclude by
   * ownership from another charge (a QB ledger row is expected, not a conflict).
   */
  link: GiftLinkAnchor;
}

async function searchDonors(p: RecSearchParams): Promise<RecCandidate[]> {
  const q = (p.q ?? "").trim();
  if (q.length < 2) return [];
  const rows = (
    await db.execute(sql`
      SELECT id, kind, name, sim, anonymous, owner_user_id FROM (
        SELECT id, 'organization' AS kind, name AS name,
               similarity(name, ${q}) AS sim, anonymous, owner_user_id
          FROM organizations WHERE name % ${q}
        UNION ALL
        SELECT id, 'person' AS kind, full_name AS name,
               similarity(full_name, ${q}) AS sim, anonymous, owner_user_id
          FROM people WHERE full_name IS NOT NULL AND full_name % ${q}
        UNION ALL
        SELECT id, 'household' AS kind, name AS name,
               similarity(name, ${q}) AS sim, false AS anonymous, NULL AS owner_user_id
          FROM households WHERE name % ${q}
      ) t
      ORDER BY sim DESC
      LIMIT ${p.limit}
    `)
  ).rows as Array<{
    id: string;
    kind: string;
    name: string | null;
    sim: number;
    anonymous: boolean | null;
    owner_user_id: string | null;
  }>;

  return rows.map((r) => {
    const kind = r.kind as RecDonorKind;
    const label =
      kind === "household"
        ? (r.name ?? "Household")
        : (maskName(
            r.name,
            { anonymous: r.anonymous, ownerUserId: r.owner_user_id },
            p.viewer,
          ) ?? "(unnamed)");
    return candidate({
      nodeType: "donor",
      id: r.id,
      label,
      confidence: Math.round((Number(r.sim) || 0) * 100),
      source: "name",
      donorKind: kind,
    });
  });
}

async function searchGifts(
  anchor: GiftSearchAnchor,
  p: RecSearchParams,
): Promise<RecCandidate[]> {
  const rows =
    anchor.amount == null
      ? []
      : ((await fetchGiftCandidates({
          link: anchor.link,
          donorFilter: p.donorId
            ? sql`(${giftsAndPayments.organizationId} = ${p.donorId} OR ${giftsAndPayments.individualGiverPersonId} = ${p.donorId} OR ${giftsAndPayments.householdId} = ${p.donorId})`
            : undefined,
          amount: anchor.amount,
          date: anchor.date,
          days: p.days,
          limit: p.limit,
          q: p.q,
          split: p.split,
        })) as NonNullable<RecGiftRow>[]);
  // In split mode each candidate is a fraction of the payment, so an
  // amount-confidence score against the FULL payment would be misleadingly low —
  // suppress it (the amount is still shown; the score is not meaningful here).
  const giftCandidates = rows.map((g) =>
    giftRowToCandidate(g, p.split ? null : anchor.amount, p.viewer, p.split),
  );
  // Unified search: the record a fundraiser is hunting for often lives as an
  // OPPORTUNITY/pledge, not a gift (money promised but not yet booked). A
  // free-text query therefore ALWAYS includes matching opportunities as
  // labelled, SELECTABLE candidates after the gifts — the UI books a pick as a
  // payment on that pledge. A manual match always wins; nothing is hidden or
  // disabled just because it isn't a gift yet.
  const q = (p.q ?? "").trim();
  if (q.length >= 2) {
    const opps = await searchOppsForGiftSearch(
      p,
      giftCandidates.length === 0 ? p.limit : OPP_APPEND_LIMIT,
    );
    return [...giftCandidates, ...opps];
  }
  return giftCandidates;
}

// How many opportunity candidates ride along when the gift search itself has
// hits (when it has none, opportunities get the full limit).
const OPP_APPEND_LIMIT = 5;

// Opportunity arm of the unified free-text GIFT search. Matches the same text
// surfaces the gift search does (record name + donor names) so a donor-name
// query like "Melva Legrand" finds the donor's opportunity even when its
// record name doesn't contain the donor. Donor-scoped when the caller pinned a
// donor. Labels are anonymous-masked like every other candidate.
async function searchOppsForGiftSearch(
  p: RecSearchParams,
  limit: number,
): Promise<RecCandidate[]> {
  const q = (p.q ?? "").trim();
  const like = `%${escapeLike(q)}%`;
  const conds: SQL[] = [isNull(opportunitiesAndPledges.archivedAt)];
  if (p.donorId)
    conds.push(
      sql`(${opportunitiesAndPledges.organizationId} = ${p.donorId} OR ${opportunitiesAndPledges.individualGiverPersonId} = ${p.donorId} OR ${opportunitiesAndPledges.householdId} = ${p.donorId})`,
    );
  const textMatch = or(
    ilike(opportunitiesAndPledges.name, like),
    ilike(organizations.name, like),
    ilike(households.name, like),
    ilike(personNameSql, like),
  );
  if (textMatch) conds.push(textMatch);

  const rows = (await db
    .select(oppCols)
    .from(opportunitiesAndPledges)
    .leftJoin(
      organizations,
      eq(organizations.id, opportunitiesAndPledges.organizationId),
    )
    .leftJoin(
      households,
      eq(households.id, opportunitiesAndPledges.householdId),
    )
    .leftJoin(
      people,
      eq(people.id, opportunitiesAndPledges.individualGiverPersonId),
    )
    .where(and(...conds))
    .orderBy(asc(opportunitiesAndPledges.name))
    .limit(limit)) as OppRow[];

  const displays = await loadDonorDisplays(
    rows
      .map(oppDonorPair)
      .filter((x): x is { kind: RecDonorKind; id: string } => x != null),
  );
  return rows.map((o) => oppToCandidate(o, displays, p.viewer, "manual"));
}

async function searchOpps(p: RecSearchParams): Promise<RecCandidate[]> {
  const q = (p.q ?? "").trim();
  const hasText = q.length >= 2;
  if (!p.donorId && !hasText) return [];
  const conds: SQL[] = [isNull(opportunitiesAndPledges.archivedAt)];
  if (p.donorId)
    conds.push(
      sql`(${opportunitiesAndPledges.organizationId} = ${p.donorId} OR ${opportunitiesAndPledges.individualGiverPersonId} = ${p.donorId} OR ${opportunitiesAndPledges.householdId} = ${p.donorId})`,
    );
  if (hasText)
    conds.push(ilike(opportunitiesAndPledges.name, `%${escapeLike(q)}%`));

  const rows = (await db
    .select(oppCols)
    .from(opportunitiesAndPledges)
    .where(and(...conds))
    .orderBy(asc(opportunitiesAndPledges.name))
    .limit(p.limit)) as OppRow[];

  const displays = await loadDonorDisplays(
    rows
      .map(oppDonorPair)
      .filter((x): x is { kind: RecDonorKind; id: string } => x != null),
  );
  return rows.map((o) => oppToCandidate(o, displays, p.viewer, "manual"));
}

async function searchQb(p: RecSearchParams): Promise<RecCandidate[]> {
  const q = (p.q ?? "").trim();
  if (q.length < 2) return [];
  const rows = await db
    .select({
      id: stagedPayments.id,
      payerName: stagedPayments.payerName,
      rawReference: stagedPayments.rawReference,
      amount: stagedPayments.amount,
      dateReceived: stagedPayments.dateReceived,
    })
    .from(stagedPayments)
    .where(
      and(sql`${stagedPayments.id} <> ${p.stagedPaymentId}`, stagedSearchWhere(q)),
    )
    .orderBy(desc(stagedPayments.dateReceived))
    .limit(p.limit);
  return rows.map((r) =>
    candidate({
      nodeType: "qb",
      id: r.id,
      label: r.payerName ?? "(no payer)",
      sublabel: r.rawReference,
      amount: r.amount,
      date: r.dateReceived,
      source: "manual",
    }),
  );
}

// ─── Criteria-based Stripe payout search (reverse of searchQbStaged) ─────────
// Powers the Settlement report's "Missing payout" resolve box: given a standalone
// QuickBooks DEPOSIT anchor, hunt the orphan Stripe payout it should settle
// against. Only ORPHAN payouts (no settlement link at all) are offered — a payout
// already tied (proposed or confirmed) belongs to another deposit's bundle.
// Requires at least one positive criterion so it never dumps the whole table.
export interface RecPayoutCharge {
  id: string;
  payerName: string | null;
  amount: string | null;
  date: string | null;
  status: string | null;
  exclusionReason: string | null;
}

export interface RecPayoutCandidate {
  id: string;
  amount: string | null;
  date: string | null;
  chargeCount: number | null;
  charges: RecPayoutCharge[];
}

export interface RecPayoutSearchParams {
  q: string | null;
  amount: string | null;
  date: string | null;
  days: number;
  limit: number;
}

export async function searchPayouts(
  p: RecPayoutSearchParams,
): Promise<RecPayoutCandidate[]> {
  const q = (p.q ?? "").trim();
  const hasText = q.length >= 2;
  const amt = p.amount != null && p.amount !== "" ? Number(p.amount) : NaN;
  const hasAmount = Number.isFinite(amt) && amt > 0;
  if (!hasText && !hasAmount) return [];

  // Only orphan payouts (no settlement link) are eligible resolve targets.
  const conds: SQL[] = [
    sql`NOT EXISTS (SELECT 1 FROM ${settlementLinks} WHERE ${settlementLinks.payoutId} = ${stripePayouts.id})`,
  ];
  if (hasText) {
    // A payout has no human-readable name of its own — the donor names live on
    // its charges. Match the payout id OR any of its charges' payer fields so a
    // reviewer can find "the payout with Jane Doe's charge in it" by name.
    conds.push(
      sql`(${ilike(stripePayouts.id, `%${escapeLike(q)}%`)} OR EXISTS (
        SELECT 1 FROM ${stripeStagedCharges}
        WHERE ${stripeStagedCharges.stripePayoutId} = ${stripePayouts.id}
          AND (${stripeChargeSearchWhere(q)})
      ))`,
    );
  }
  if (hasAmount && !hasText) {
    // A QB deposit sits near its payout (gross deposit vs net payout differ by
    // processor fees) — band generously against the payout NET: ±20% or ±$50.
    // Same text-overrides-band rule as searchQbStagedRows: the band
    // hard-filters only a criterion-less (no text) search; with text, the
    // amount only RANKS (below).
    const net = sql`COALESCE(${stripePayouts.netTotal}, ${stripePayouts.amount})`;
    const lo = Math.min(amt * 0.8, amt - 50);
    const hi = Math.max(amt * 1.2, amt + 50);
    conds.push(
      sql`${net} IS NOT NULL AND (${net})::numeric BETWEEN ${lo} AND ${hi}`,
    );
  }
  if (p.date) {
    conds.push(
      sql`${stripePayouts.arrivalDate} IS NOT NULL AND ${stripePayouts.arrivalDate} BETWEEN (${p.date}::date - make_interval(days => ${p.days})) AND (${p.date}::date + make_interval(days => ${p.days}))`,
    );
  }

  // Surface the best candidates first: closest NET amount to the target, then
  // (when an anchor date is given) fewest days from the target date. Recency is
  // only the final tiebreak / the sole order for a text-only search.
  const orderBy: SQL[] = [];
  if (hasAmount) {
    orderBy.push(
      sql`ABS((COALESCE(${stripePayouts.netTotal}, ${stripePayouts.amount}))::numeric - ${amt})`,
    );
  }
  if (p.date) {
    orderBy.push(
      sql`ABS((${stripePayouts.arrivalDate})::date - ${p.date}::date)`,
    );
  }
  orderBy.push(desc(stripePayouts.arrivalDate));

  const rows = await db
    .select({
      id: stripePayouts.id,
      amount: sql<string | null>`COALESCE(${stripePayouts.netTotal}, ${stripePayouts.amount})`,
      arrivalDate: stripePayouts.arrivalDate,
      chargeCount: stripePayouts.chargeCount,
      // Per-charge breakdown (payer name + amount) so a reviewer can see who is
      // inside a payout candidate. Capped at 50 (amount desc) to bound the row.
      charges: sql<RecPayoutCharge[]>`COALESCE((
        SELECT json_agg(json_build_object(
            'id', c.id,
            'payerName', COALESCE(c.payer_name, c.description),
            'amount', c.gross_amount::text,
            'date', c.date_received::text,
            'status', c.status,
            'exclusionReason', c.exclusion_reason
          ) ORDER BY c.gross_amount DESC NULLS LAST)
        FROM (
          SELECT cc.id, cc.payer_name, cc.description, cc.gross_amount, cc.date_received,
                 ${sql.raw(chargeStatusCaseText("cc"))} AS status,
                 cc.exclusion_reason
          FROM stripe_staged_charges cc
          WHERE cc.stripe_payout_id = ${stripePayouts.id}
          ORDER BY cc.gross_amount DESC NULLS LAST
          LIMIT 50
        ) c
      ), '[]'::json)`,
    })
    .from(stripePayouts)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(p.limit);

  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    date: r.arrivalDate,
    chargeCount: r.chargeCount,
    charges: r.charges ?? [],
  }));
}

// ─── Criteria-based QB staged search (NO card anchor) ────────────────────────
// Powers the stray-Stripe worklist's "find the matching QuickBooks deposit" box.
// Unlike searchReconciliationNode's qb branch, this is NOT tied to a staged
// payment: callers pass free text and/or a target amount (+ optional date
// window) and get qb candidates back. Requires at least one positive criterion
// so it never dumps the whole table.
export interface RecQbSearchParams {
  q: string | null;
  amount: string | null;
  date: string | null;
  days: number;
  limit: number;
  /**
   * Also search Stripe staged charges (which carry donor names QB deposit
   * lumps often lack) and interleave them with the QB rows by amount/date
   * proximity. Default false so every existing caller stays QB-only.
   */
  includeStripe?: boolean;
}

async function searchQbStagedRows(
  p: RecQbSearchParams,
  q: string,
  hasText: boolean,
  amt: number,
  hasAmount: boolean,
): Promise<RecCandidate[]> {
  // Unpickable rows (excluded / already settled) are NOT filtered out — they
  // return WITH a conflictReason label so the picker can gray them and the
  // user can see (and debug) WHY a row is blocked. A silently-missing row
  // hides mis-derived statuses; the action endpoints still enforce the block
  // server-side with a specific 409.
  const conds: SQL[] = [];
  if (hasText) {
    const w = stagedSearchWhere(q);
    if (w) conds.push(w);
  }
  if (hasAmount && !hasText) {
    // A QB deposit matching a Stripe payout sits near the payout amount (gross
    // vs net differ by processor fees) — band generously: ±20% or ±$50.
    // The band HARD-FILTERS only a criterion-less (no text) search, where it is
    // the sole positive criterion. When the user typed text, the text is the
    // filter and the amount only RANKS (below): a payout booked as several
    // smaller per-donor QB rows has no row anywhere near the payout net, so an
    // ANDed band would hide the very rows an explicit name search asks for.
    const lo = Math.min(amt * 0.8, amt - 50);
    const hi = Math.max(amt * 1.2, amt + 50);
    conds.push(
      sql`${stagedPayments.amount} IS NOT NULL AND (${stagedPayments.amount})::numeric BETWEEN ${lo} AND ${hi}`,
    );
  }
  if (p.date) {
    conds.push(
      sql`${stagedPayments.dateReceived} IS NOT NULL AND ${stagedPayments.dateReceived} BETWEEN (${p.date}::date - make_interval(days => ${p.days})) AND (${p.date}::date + make_interval(days => ${p.days}))`,
    );
  }

  // Surface the best candidates first: closest amount to the target payout, then
  // (when an anchor date is given) fewest days from the target date. Recency is
  // only the final tiebreak / the sole order for a text-only search.
  const orderBy: SQL[] = [];
  if (hasAmount) {
    orderBy.push(sql`ABS((${stagedPayments.amount})::numeric - ${amt})`);
  }
  if (p.date) {
    orderBy.push(
      sql`ABS((${stagedPayments.dateReceived})::date - ${p.date}::date)`,
    );
  }
  orderBy.push(desc(stagedPayments.dateReceived));

  const rows = await db
    .select({
      id: stagedPayments.id,
      payerName: stagedPayments.payerName,
      rawReference: stagedPayments.rawReference,
      amount: stagedPayments.amount,
      dateReceived: stagedPayments.dateReceived,
      // A QB payment already counted against a gift in the ledger can't be
      // re-linked without double-counting — surface the owning gift so the
      // picker can gray the row and offer an unlink. Splits resolve to NULL
      // (same as the legacy gift-link columns, which are no longer written).
      linkedGiftId: qbLedgerSoleGiftIdForPayment(),
      // Blocking facts for the conflictReason label (never used to filter):
      // an exclusion takes the row out of review; a confirmed settlement link
      // means its money is already accounted for against another payout; a
      // confirmed charge-grain tie means an individually-booked payout's
      // charge already claims this exact row.
      exclusionReason: stagedPayments.exclusionReason,
      settledElsewhere: sql<boolean>`${stagedConfirmedSettlementLinkExists}`,
      // RAW linkage on purpose: a tie claims the row (re-linking it elsewhere
      // would conflict) even while the charge's booking is still pending.
      tiedToCharge: sql<boolean>`${stagedChargeTieLinkExists}`,
    })
    .from(stagedPayments)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(p.limit);

  return rows.map((r) =>
    candidate({
      nodeType: "qb",
      id: r.id,
      label: r.payerName ?? "(no payer)",
      sublabel: r.rawReference,
      amount: r.amount,
      date: r.dateReceived,
      source: "manual",
      alreadyLinkedGiftId: r.linkedGiftId ?? null,
      conflictReason: r.exclusionReason
        ? `Excluded from review (${String(r.exclusionReason).replace(/_/g, " ")})`
        : r.settledElsewhere
          ? "Already settled against another Stripe payout"
          : r.tiedToCharge
            ? "Already tied to another Stripe charge"
            : null,
      conflictKind: r.exclusionReason
        ? "excluded"
        : r.settledElsewhere
          ? "settled_elsewhere"
          : r.tiedToCharge
            ? "tied_to_charge"
            : null,
    }),
  );
}

// Stripe leg of the un-anchored payment search (includeStripe=true). Stripe
// charges carry the donor's own name/email, which the coarse QB deposit lumps
// often lack — so the stray-gift picker searches both sources. Rules:
//   - Excluded (e.g. failed), refunded, and disputed charges never appear —
//     they aren't linkable money. Every remaining charge is either derived
//     `pending` (open) or gift-tied (match_proposed / match_confirmed), so a
//     single NOT-excluded predicate covers both arms; a tied charge is
//     surfaced via alreadyLinkedGiftId so the picker can gray it and offer
//     the per-charge revert as an unlink.
//   - Amount uses the shared KNOWN-NET fee band (giftMatchAmountBoundsKnownNet,
//     the same policy helper the one-click stray-gift proposal and the approve
//     gate use): a target anywhere in [min(net,gross), max(net,gross)] is the
//     same money a processor fee apart. Gross must be known for the band to
//     mean anything (LEAST/GREATEST ignore a NULL net — safe collapse).
async function searchStripeChargeRows(
  p: RecQbSearchParams,
  q: string,
  hasText: boolean,
  amt: number,
  hasAmount: boolean,
): Promise<RecCandidate[]> {
  const conds: SQL[] = [
    sql`NOT ${chargeStatusWhere.excluded}`,
    eq(stripeStagedCharges.refunded, false),
    eq(stripeStagedCharges.disputed, false),
  ];
  if (hasText) conds.push(stripeChargeSearchWhere(q));
  if (hasAmount && !hasText) {
    // Same text-overrides-band rule as the QB leg: the fee band hard-filters
    // only when there is no text criterion; with text, amount only ranks.
    conds.push(sql`${stripeStagedCharges.grossAmount} IS NOT NULL`);
    conds.push(
      giftMatchAmountBoundsKnownNet(
        sql`${amt}`,
        sql`(${stripeStagedCharges.grossAmount})::numeric`,
        sql`(${stripeStagedCharges.netAmount})::numeric`,
      ),
    );
  }
  if (p.date) {
    conds.push(
      sql`${stripeStagedCharges.dateReceived} IS NOT NULL AND ${stripeStagedCharges.dateReceived} BETWEEN (${p.date}::date - make_interval(days => ${p.days})) AND (${p.date}::date + make_interval(days => ${p.days}))`,
    );
  }

  const orderBy: SQL[] = [];
  if (hasAmount) {
    orderBy.push(sql`ABS((${stripeStagedCharges.grossAmount})::numeric - ${amt})`);
  }
  if (p.date) {
    orderBy.push(
      sql`ABS((${stripeStagedCharges.dateReceived})::date - ${p.date}::date)`,
    );
  }
  orderBy.push(desc(stripeStagedCharges.dateReceived));

  const rows = await db
    .select({
      id: stripeStagedCharges.id,
      payerName: stripeStagedCharges.payerName,
      payerEmail: stripeStagedCharges.payerEmail,
      description: stripeStagedCharges.description,
      statementDescriptor: stripeStagedCharges.statementDescriptor,
      grossAmount: stripeStagedCharges.grossAmount,
      dateReceived: stripeStagedCharges.dateReceived,
      // Ledger-resolved owning gift (pointer columns are retired, never read).
      ledgerGiftId: stripeLedgerGiftIdForCharge(),
    })
    .from(stripeStagedCharges)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(p.limit);

  return rows.map((r) => {
    const label =
      r.payerName?.trim() || r.description?.trim() || "(no payer)";
    const subParts = [
      r.payerEmail?.trim() || null,
      r.description?.trim() && r.description.trim() !== label
        ? r.description.trim()
        : null,
      r.statementDescriptor?.trim() || null,
    ].filter((s): s is string => !!s);
    return candidate({
      nodeType: "stripe",
      id: r.id,
      label,
      sublabel: subParts.length > 0 ? subParts.join(" · ") : null,
      amount: r.grossAmount,
      date: r.dateReceived,
      source: "stripe",
      // A charge already tied to a gift (matched or created) can't be
      // re-linked without double-counting — surface the owning gift so the
      // picker grays the row and offers the per-charge revert as an unlink.
      alreadyLinkedGiftId: r.ledgerGiftId ?? null,
    });
  });
}

export async function searchQbStaged(
  p: RecQbSearchParams,
): Promise<RecCandidate[]> {
  const q = (p.q ?? "").trim();
  const hasText = q.length >= 2;
  const amt = p.amount != null && p.amount !== "" ? Number(p.amount) : NaN;
  const hasAmount = Number.isFinite(amt) && amt > 0;
  if (!hasText && !hasAmount) return [];

  const [qbCands, stripeCands] = await Promise.all([
    searchQbStagedRows(p, q, hasText, amt, hasAmount),
    p.includeStripe
      ? searchStripeChargeRows(p, q, hasText, amt, hasAmount)
      : Promise.resolve([] as RecCandidate[]),
  ]);
  if (stripeCands.length === 0) return qbCands;

  // Interleave the two sources by the SAME keys each SQL order used: closest
  // amount to the target, then fewest days from the anchor date, then recency.
  // Nulls sort last within each key so criterion-less rows never crowd out
  // scored ones.
  const dateMs = (d: string | null): number | null => {
    if (!d) return null;
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  };
  const anchorMs = p.date ? dateMs(p.date) : null;
  const key = (c: RecCandidate) => {
    const a = c.amount != null ? Number(c.amount) : NaN;
    const cMs = dateMs(c.date);
    return {
      amountDelta:
        hasAmount && Number.isFinite(a) ? Math.abs(a - amt) : null,
      dateDelta:
        anchorMs != null && cMs != null
          ? Math.abs(cMs - anchorMs)
          : null,
      recency: cMs ?? Number.NEGATIVE_INFINITY,
    };
  };
  const cmpNullable = (x: number | null, y: number | null): number => {
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  };
  const merged = [...qbCands, ...stripeCands]
    .map((c) => ({ c, k: key(c) }))
    .sort(
      (l, r) =>
        cmpNullable(l.k.amountDelta, r.k.amountDelta) ||
        cmpNullable(l.k.dateDelta, r.k.dateDelta) ||
        r.k.recency - l.k.recency,
    )
    .map((e) => e.c);
  return merged.slice(0, p.limit);
}
