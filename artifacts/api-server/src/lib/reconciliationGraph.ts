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

// CRM gross gift is at or just above the QB net (a processor fee makes it
// slightly larger). Used both as a candidate filter and a mismatch check.
function withinFeeBand(anchor: string | null, gift: string | null): boolean {
  if (anchor == null || gift == null) return true;
  const a = Number(anchor);
  const g = Number(gift);
  if (!Number.isFinite(a) || !Number.isFinite(g)) return true;
  return g >= a - 0.01 && g <= a * 1.1 + 1;
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
  return candidate({
    nodeType: "gift",
    id: g.id,
    label: hidden ? ANON_LABEL : (g.name ?? "(untitled gift)"),
    sublabel: giftDonorSublabel(g, viewer),
    amount: g.amount ?? null,
    date: g.dateReceived ?? null,
    confidence: amountConfidence(anchorAmount, g.amount ?? null),
    source: "amount_date",
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
};
type OppRow = {
  id: string;
  name: string | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  askAmount: string | null;
  awardedAmount: string | null;
};

function oppDonorPair(o: OppRow): { kind: RecDonorKind; id: string } | null {
  return donorPickFromMatch(o as DonorMatch);
}

function oppToCandidate(
  o: OppRow,
  displays: Map<string, DonorDisplay>,
  viewer: Viewer,
  source: RecCandidateSource,
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
    source,
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

async function loadDonorOpps(
  donor: { kind: RecDonorKind; id: string },
  limit: number,
): Promise<OppRow[]> {
  return db
    .select(oppCols)
    .from(opportunitiesAndPledges)
    .where(
      and(
        isNull(opportunitiesAndPledges.archivedAt),
        donor.kind === "organization"
          ? eq(opportunitiesAndPledges.organizationId, donor.id)
          : donor.kind === "person"
            ? eq(opportunitiesAndPledges.individualGiverPersonId, donor.id)
            : eq(opportunitiesAndPledges.householdId, donor.id),
      ),
    )
    .orderBy(asc(opportunitiesAndPledges.name))
    .limit(limit) as Promise<OppRow[]>;
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
    };
  }

  // The reconciliation anchor amount: Stripe GROSS takes precedence over the
  // QB net when a single charge backs the same money (matches the stamp rule).
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

  const pledgeId = selectedGiftRow?.paymentOnPledgeId ?? null;
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
    const opps = await loadDonorOpps(selectedDonor, 25);
    const displays = await loadDonorDisplays(
      opps
        .map(oppDonorPair)
        .filter((x): x is { kind: RecDonorKind; id: string } => x != null),
    );
    oppCandidates = opps.map((o) =>
      oppToCandidate(o, displays, viewer, "manual"),
    );
    oppState = oppCandidates.length ? "filter_only" : "none";
  }

  // ── Ready + blockers ──
  const blockers: string[] = [];
  if (staged.status !== "pending") {
    blockers.push(
      staged.status === "reconciled"
        ? "Already reconciled."
        : `Already ${staged.status}.`,
    );
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
    !withinFeeBand(anchorAmount, selectedGiftRow.amount ?? null)
  ) {
    blockers.push("Gift amount differs from the evidence — confirm or override.");
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
