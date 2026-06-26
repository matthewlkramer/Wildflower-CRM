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
} from "@workspace/db/schema";
import {
  and,
  asc,
  desc,
  eq,
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
  giftCandidateJoins,
  giftCandidateSelect,
  stagedSearchWhere,
  escapeLike,
} from "../routes/quickbooks/shared";
import {
  ANON_LABEL,
  canSeeIdentity,
  maskName,
  type Viewer,
} from "./identityVisibility";

// ─── Contract-shaped local types (camelCase, mirror openapi schemas) ─────────

export type RecNodeType = "qb" | "donor" | "gift" | "opportunity";
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
  conflictReason: string | null;
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
  stagedPaymentId: string;
  q: string | null;
  donorId: string | null;
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
    conflictReason: null,
    ...init,
  };
}

// COALESCE(full_name, "first last") — nicer person display than raw full_name.
const personNameSql = sql<string | null>`
  COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )`;

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

function recGiftSelect(excludeStagedId: string) {
  return {
    ...giftCandidateSelect(excludeStagedId),
    // Override raw full_name with the COALESCE display name.
    individualGiverPersonName: personNameSql,
    organizationAnonymous: organizations.anonymous,
    organizationOwnerUserId: organizations.ownerUserId,
    individualGiverAnonymous: people.anonymous,
    individualGiverOwnerUserId: people.ownerUserId,
  };
}

type RecGiftRow = Awaited<ReturnType<typeof fetchGiftById>>;

async function fetchGiftCandidates(opts: {
  excludeStagedId: string;
  donorFilter?: SQL;
  amount: string | null;
  date: string | null;
  days: number;
  limit: number;
  q?: string | null;
}) {
  if (opts.amount == null) return [];
  const conds: SQL[] = [
    sql`${giftsAndPayments.amount} >= ${opts.amount}::numeric - 0.01`,
    sql`${giftsAndPayments.amount} <= ${opts.amount}::numeric * 1.10 + 1`,
    isNull(giftsAndPayments.archivedAt),
  ];
  if (opts.donorFilter) conds.push(opts.donorFilter);
  if (opts.date)
    conds.push(
      sql`(${giftsAndPayments.dateReceived} IS NULL OR ABS(${giftsAndPayments.dateReceived} - ${opts.date}::date) <= ${opts.days})`,
    );
  const q = (opts.q ?? "").trim();
  if (q.length >= 2)
    conds.push(ilike(giftsAndPayments.name, `%${escapeLike(q)}%`));

  const orderBy: SQL[] = [
    sql`ABS(${giftsAndPayments.amount} - ${opts.amount}::numeric) ASC`,
  ];
  if (opts.date)
    orderBy.push(
      sql`ABS(${giftsAndPayments.dateReceived} - ${opts.date}::date) ASC NULLS LAST`,
    );

  return giftCandidateJoins(
    db.select(recGiftSelect(opts.excludeStagedId)).from(giftsAndPayments).$dynamic(),
  )
    .where(and(...conds))
    .orderBy(...orderBy, desc(giftsAndPayments.dateReceived))
    .limit(opts.limit);
}

async function fetchGiftById(id: string, excludeStagedId: string) {
  return giftCandidateJoins(
    db.select(recGiftSelect(excludeStagedId)).from(giftsAndPayments).$dynamic(),
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
    confidence: amountConfidence(anchorAmount, g.amount ?? null),
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

  // nearest expected-payment date per opp (pledge-allocation level) — a soft
  // ranking signal only (smaller day-distance = sooner-due installment).
  const dateDiffByOpp = new Map<string, number>();
  if (paymentDate) {
    const dateRows = await db
      .select({
        opportunityId: pledgeAllocations.pledgeOrOpportunityId,
        diffDays: sql<number>`MIN(ABS(${pledgeAllocations.expectedPaymentDate} - ${paymentDate}::date))`,
      })
      .from(pledgeAllocations)
      .where(
        and(
          inArray(pledgeAllocations.pledgeOrOpportunityId, ids),
          sql`${pledgeAllocations.expectedPaymentDate} IS NOT NULL`,
        ),
      )
      .groupBy(pledgeAllocations.pledgeOrOpportunityId);
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
  const staged = await db
    .select()
    .from(stagedPayments)
    .where(eq(stagedPayments.id, stagedPaymentId))
    .then((r) => r[0]);
  if (!staged) return null;

  // ── Evidence: QB anchor (always) + optional Stripe payout/charge ──
  const stripePayout = await db
    .select({
      id: stripePayouts.id,
      amount: stripePayouts.amount,
      feeTotal: stripePayouts.feeTotal,
      netTotal: stripePayouts.netTotal,
      qbReconciliationStatus: stripePayouts.qbReconciliationStatus,
    })
    .from(stripePayouts)
    .where(
      or(
        eq(stripePayouts.matchedQbStagedPaymentId, stagedPaymentId),
        eq(stripePayouts.proposedQbStagedPaymentId, stagedPaymentId),
      ),
    )
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
      reconciliationStatus: stripePayout.qbReconciliationStatus,
    };
  }

  // When this QB anchor is part of a human-stamped source group ("these
  // separately-entered records are really ONE physical gift"), the unit that
  // reconciles to a gift is the GROUP, not the lone representative row. So the
  // amount the gift is compared against — both the candidate search and the
  // amount-band blocker below — must be the group's COMBINED total, not this
  // member's slice; otherwise a group whose members correctly SUM to the gift
  // (e.g. $65k + $15k → $80k) is wrongly flagged as an amount mismatch. Mirrors
  // the mint path (approve.ts) and the group-reconcile gate (matching.ts).
  let sourceGroupTotal: string | null = null;
  if (staged.sourceGroupId != null) {
    const agg = await db
      .select({
        total: sql<string>`COALESCE(SUM(${stagedPayments.amount}), 0)::text`,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.sourceGroupId, staged.sourceGroupId))
      .then((r) => r[0]);
    sourceGroupTotal = agg?.total ?? null;
  }

  // The reconciliation anchor amount: Stripe GROSS takes precedence over the
  // QB net when a single charge backs the same money (matches the stamp rule);
  // for a source group, the combined member total stands in for the lone row.
  const anchorAmount =
    stripeEvidence?.grossAmount ?? sourceGroupTotal ?? staged.amount;

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
  const resolvedGiftId =
    staged.matchedGiftId ??
    staged.createdGiftId ??
    staged.groupReconciledGiftId ??
    null;

  let giftRows: NonNullable<RecGiftRow>[] = [];
  let giftCandidates: RecCandidate[] = [];
  let giftState: RecEdgeState;
  let giftSelectedId: string | null = null;
  let giftLocked = false;
  let selectedGiftRow: NonNullable<RecGiftRow> | null = null;

  if (resolvedGiftId) {
    const g = await fetchGiftById(resolvedGiftId, stagedPaymentId);
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
      excludeStagedId: stagedPaymentId,
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
    if (staged.status === "reconciled") {
      blockers.push("Already reconciled.");
    } else if (staged.status === "approved" && stripeAwaiting) {
      // The QB→gift side is done; only the Stripe payout still needs a human to
      // confirm tying it in. Say so explicitly instead of a flat "Already
      // approved." so the reviewer knows which track is outstanding.
      blockers.push(
        "QuickBooks is already approved into a gift — only the Stripe payout is still awaiting confirmation.",
      );
    } else {
      blockers.push(`Already ${staged.status}.`);
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
      return searchGifts(staged, p);
    case "opportunity":
      return searchOpps(p);
    case "qb":
      return searchQb(p);
    default:
      return [];
  }
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
  staged: typeof stagedPayments.$inferSelect,
  p: RecSearchParams,
): Promise<RecCandidate[]> {
  if (staged.amount == null) return [];
  const donorFilter = p.donorId
    ? sql`(${giftsAndPayments.organizationId} = ${p.donorId} OR ${giftsAndPayments.individualGiverPersonId} = ${p.donorId} OR ${giftsAndPayments.householdId} = ${p.donorId})`
    : undefined;
  const rows = (await fetchGiftCandidates({
    excludeStagedId: p.stagedPaymentId,
    donorFilter,
    amount: staged.amount,
    date: staged.dateReceived,
    days: p.days,
    limit: p.limit,
    q: p.q,
  })) as NonNullable<RecGiftRow>[];
  return rows.map((g) => giftRowToCandidate(g, staged.amount, p.viewer));
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
}

export async function searchQbStaged(
  p: RecQbSearchParams,
): Promise<RecCandidate[]> {
  const q = (p.q ?? "").trim();
  const hasText = q.length >= 2;
  const amt = p.amount != null && p.amount !== "" ? Number(p.amount) : NaN;
  const hasAmount = Number.isFinite(amt) && amt > 0;
  if (!hasText && !hasAmount) return [];

  const conds: SQL[] = [];
  if (hasText) {
    const w = stagedSearchWhere(q);
    if (w) conds.push(w);
  }
  if (hasAmount) {
    // A QB deposit matching a Stripe payout sits near the payout amount (gross
    // vs net differ by processor fees) — band generously: ±20% or ±$50.
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

  const rows = await db
    .select({
      id: stagedPayments.id,
      payerName: stagedPayments.payerName,
      rawReference: stagedPayments.rawReference,
      amount: stagedPayments.amount,
      dateReceived: stagedPayments.dateReceived,
    })
    .from(stagedPayments)
    .where(and(...conds))
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
