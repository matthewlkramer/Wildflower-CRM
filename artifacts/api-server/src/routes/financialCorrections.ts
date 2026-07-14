import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  paymentApplications,
  stagedPayments,
  stripeStagedCharges,
  organizations,
  people,
  households,
  entities,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { asyncHandler, newId, parseOrBadRequest } from "../lib/helpers";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { getAppUser } from "../lib/appRequest";
import { ApplyFinancialCorrectionBody } from "@workspace/api-zod";
import {
  qbLedgerExistsForGift,
  qbLedgerExistsForPayment,
} from "../lib/paymentApplications";
import { stagedStatusWhere } from "../lib/derivedStatus";

// ── Financial-corrections review queue (admin-only) ──────────────────────────
//
// On-demand detection of two reconciliation problems, both proposed (never
// auto-applied) and confirmed by a human (INV-13), mirroring the entity
// potential-duplicates queue:
//
//   • merge_gifts  — mis-split / duplicate gifts: two or more non-archived gifts
//     that share ONE donor and ONE date and are NOT the counted source of any
//     QuickBooks/Stripe evidence. These were almost certainly entered as
//     separate rows when they should be allocations of a single gift (§4.2).
//     Applied through the existing /gifts-and-payments/merge endpoint.
//
//   • link_evidence — a bulk QuickBooks deposit whose amount ties to the SUM of
//     several non-archived gifts spanning MULTIPLE donors. One deposit batches
//     many donors; we propose corroborating each of those gifts with the one
//     deposit (one evidence ↔ many gifts) WITHOUT touching the QB source (§4.8).
//
// Neither detector ever edits the QuickBooks/Stripe source rows. An applied
// link_evidence correction writes a corroborating-only payment_applications
// ledger row (link_role='corroborating', amount NULL); book-once is preserved
// because the counted source of every gift stays its existing single pointer.
// (Phase-5 read-flip: the legacy gift_evidence_links table is no longer read
// or written by this route — the corroborating ledger is its sole home.)

const router: IRouter = Router();
router.use(requireAuth);

type CorrectionKind = "merge_gifts" | "link_evidence";
type EvidenceKind = "qb_staged" | "stripe_charge";

const DEFAULT_LIMIT = 100;
// Fee tolerance: a deposit/charge net can run a little under the gross gift sum
// (processor fees). Accept when the evidence amount sits within ~10% below the
// gross sum, plus a few cents of rounding either way.
const FEE_FLOOR_RATIO = 0.9;
const ABS_TOLERANCE = 0.5;

function amountTies(evidenceAmount: number, giftSum: number): boolean {
  return (
    evidenceAmount <= giftSum + ABS_TOLERANCE &&
    evidenceAmount >= giftSum * FEE_FLOOR_RATIO - ABS_TOLERANCE
  );
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Canonical, order-independent proposal keys (stable client-side identifiers).
const mergeKey = (giftIds: string[]) =>
  `merge_gifts:${[...giftIds].sort().join(",")}`;
const linkKey = (kind: EvidenceKind, id: string, giftIds: string[]) =>
  `link_evidence:${kind}:${id}:${[...giftIds].sort().join(",")}`;

interface GiftRow {
  id: string;
  donorKey: string | null;
  donorName: string | null;
  amount: number | null;
  date: string | null;
  pledgeId: string | null;
  allocationCount: number;
  countedLinked: boolean;
}

// All non-archived gifts with their donor identity, allocation count, and a
// "counted-linked" flag (true when the gift is already the book-once source of
// some QB/Stripe evidence — those are excluded from merge proposals so a
// correction never severs a reconciliation pointer).
async function loadActiveGifts(): Promise<GiftRow[]> {
  const g = giftsAndPayments;
  const donorKey = sql<string | null>`CASE
    WHEN ${g.organizationId} IS NOT NULL THEN 'o:' || ${g.organizationId}
    WHEN ${g.individualGiverPersonId} IS NOT NULL THEN 'p:' || ${g.individualGiverPersonId}
    WHEN ${g.householdId} IS NOT NULL THEN 'h:' || ${g.householdId}
    ELSE NULL END`;
  const donorName = sql<
    string | null
  >`COALESCE(${organizations.name}, ${people.fullName}, ${households.name})`;
  const allocationCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${giftAllocations} ga WHERE ga.gift_id = ${g.id}
  )`;
  // QB cash-application is now sourced from the authoritative ledger
  // (replaces the legacy final_amount_qb pointer + staged matched/created/
  // group_reconciled + split arms, all of which read scattered columns and
  // — via the drizzle bare-column footgun — under-correlated). The Stripe arms
  // are preserved, with their correlation written explicitly-qualified to the
  // outer gift so they actually match (the parity:reconciliation-guards gate
  // proves the full predicate is unchanged vs the corrected legacy semantics).
  const countedLinked = sql<boolean>`(
    ${qbLedgerExistsForGift()}
    OR ${g.finalAmountStripeChargeId} IS NOT NULL
    OR EXISTS (SELECT 1 FROM payment_applications pa
      WHERE pa.gift_id = "gifts_and_payments"."id"
        AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted')
  )`;
  const rows = await db
    .select({
      id: g.id,
      donorKey,
      donorName,
      amount: g.amount,
      date: g.dateReceived,
      pledgeId: g.opportunityId,
      allocationCount,
      countedLinked,
    })
    .from(g)
    .leftJoin(organizations, eq(organizations.id, g.organizationId))
    .leftJoin(people, eq(people.id, g.individualGiverPersonId))
    .leftJoin(households, eq(households.id, g.householdId))
    .where(isNull(g.archivedAt));
  return rows.map((r) => ({
    id: r.id,
    donorKey: r.donorKey,
    donorName: r.donorName,
    amount: num(r.amount),
    date: r.date,
    pledgeId: r.pledgeId,
    allocationCount: Number(r.allocationCount ?? 0),
    countedLinked: Boolean(r.countedLinked),
  }));
}

interface EvidenceRow {
  kind: EvidenceKind;
  id: string;
  amount: number | null;
  date: string | null;
  payerName: string | null;
  entityName: string | null;
}

// Unlinked QuickBooks staged rows (not the counted source of any gift, not
// excluded). These are the candidate bulk deposits for link_evidence and the
// optional tying evidence for a merge proposal.
async function loadUnlinkedQbStaged(): Promise<EvidenceRow[]> {
  const sp = stagedPayments;
  const rows = await db
    .select({
      id: sp.id,
      amount: sp.amount,
      date: sp.dateReceived,
      payerName: sp.payerName,
      entityName: entities.name,
    })
    .from(sp)
    .leftJoin(entities, eq(entities.id, sp.entityId))
    .where(
      and(
        // Derived-status excluded check (no stored status column): a row is
        // excluded iff its exclusion_reason is set.
        sql`NOT ${stagedStatusWhere.excluded}`,
        // QB cash-application reads come from the authoritative ledger: a staged
        // payment is "unlinked" iff it anchors NO payment_applications row
        // (subsumes the legacy matched/created/group-null + no-split check).
        sql`NOT ${qbLedgerExistsForPayment()}`,
      ),
    );
  return rows.map((r) => ({
    kind: "qb_staged" as const,
    id: r.id,
    amount: num(r.amount),
    date: r.date,
    payerName: r.payerName,
    entityName: r.entityName,
  }));
}

interface Correction {
  kind: CorrectionKind;
  key: string;
  score: number;
  reason: string;
  gifts: {
    id: string;
    donorName: string | null;
    amount: string | null;
    date: string | null;
    allocationCount: number;
    pledgeId: string | null;
  }[];
  evidence?: {
    kind: EvidenceKind;
    id: string;
    amount: string | null;
    date: string | null;
    payerName: string | null;
    entityName: string | null;
  };
  mergeSuggestion?: { primaryId: string; mergeIds: string[] };
  safeApply: boolean;
}

const giftView = (g: GiftRow) => ({
  id: g.id,
  donorName: g.donorName,
  amount: g.amount == null ? null : String(g.amount),
  date: g.date,
  allocationCount: g.allocationCount,
  pledgeId: g.pledgeId,
});

const evidenceView = (e: EvidenceRow) => ({
  kind: e.kind,
  id: e.id,
  amount: e.amount == null ? null : String(e.amount),
  date: e.date,
  payerName: e.payerName,
  entityName: e.entityName,
});

export async function detectFinancialCorrections(
  limit: number,
): Promise<Correction[]> {
  const [gifts, qbStaged] = await Promise.all([
    loadActiveGifts(),
    loadUnlinkedQbStaged(),
  ]);

  // Index unlinked QB evidence by date for quick lookups.
  const qbByDate = new Map<string, EvidenceRow[]>();
  for (const e of qbStaged) {
    if (!e.date) continue;
    const list = qbByDate.get(e.date) ?? [];
    list.push(e);
    qbByDate.set(e.date, list);
  }

  const out: Correction[] = [];

  // ── Detector A: merge_gifts (same donor + same date, not counted-linked) ──
  const byDonorDate = new Map<string, GiftRow[]>();
  for (const g of gifts) {
    if (!g.donorKey || !g.date || g.countedLinked) continue;
    const k = `${g.donorKey}|${g.date}`;
    const list = byDonorDate.get(k) ?? [];
    list.push(g);
    byDonorDate.set(k, list);
  }
  for (const group of byDonorDate.values()) {
    if (group.length < 2) continue;
    // Don't merge gifts paying different pledges.
    const pledges = new Set(group.map((g) => g.pledgeId ?? ""));
    if (pledges.size > 1) continue;
    const giftIds = group.map((g) => g.id);
    const key = mergeKey(giftIds);

    const sum = group.reduce((s, g) => s + (g.amount ?? 0), 0);
    // Optional tying evidence: a single unlinked QB row on the same date whose
    // amount matches the group's summed gross (a strong mis-split signal).
    const date = group[0].date!;
    const tie =
      qbByDate
        .get(date)
        ?.find((e) => e.amount != null && amountTies(e.amount, sum)) ?? null;

    // Survivor = the gift with the most allocations, then the lowest id (stable).
    const primary = [...group].sort(
      (a, b) => b.allocationCount - a.allocationCount || (a.id < b.id ? -1 : 1),
    )[0];
    const mergeIds = giftIds.filter((id) => id !== primary.id);

    out.push({
      kind: "merge_gifts",
      key,
      score: tie ? 0.92 : 0.7,
      reason: tie
        ? `${group.length} gifts share one donor and date and together match a single ${tie.kind === "qb_staged" ? "QuickBooks" : "Stripe"} amount of ${tie.amount} — likely one gift split into separate rows.`
        : `${group.length} gifts share the same donor and date — likely duplicates or one gift entered as separate rows.`,
      gifts: group.map(giftView),
      ...(tie ? { evidence: evidenceView(tie) } : {}),
      mergeSuggestion: { primaryId: primary.id, mergeIds },
      safeApply: true,
    });
    if (out.length >= limit) return out;
  }

  // ── Detector B: link_evidence (one bulk deposit ↔ many donors' gifts) ─────
  // For each unlinked QB deposit, the non-archived gifts on the same date whose
  // gross sum ties to the deposit and that span >= 2 distinct donors.
  const giftsByDate = new Map<string, GiftRow[]>();
  for (const g of gifts) {
    if (!g.date) continue;
    const list = giftsByDate.get(g.date) ?? [];
    list.push(g);
    giftsByDate.set(g.date, list);
  }
  // Existing corroborating ledger rows so an already-corroborated tie isn't
  // re-proposed. Phase-5 read-flip: read the authoritative payment_applications
  // ledger (link_role='corroborating') instead of the frozen gift_evidence_links
  // table. A corroborating row anchors on paymentId (quickbooks) or
  // stripeChargeId (stripe); map each back to the detector's
  // (evidenceKind, evidenceId, giftId) dedupe key.
  const existingLinks = await db
    .select({
      evidenceSource: paymentApplications.evidenceSource,
      paymentId: paymentApplications.paymentId,
      stripeChargeId: paymentApplications.stripeChargeId,
      giftId: paymentApplications.giftId,
    })
    .from(paymentApplications)
    .where(eq(paymentApplications.linkRole, "corroborating"));
  const linkedSet = new Set(
    existingLinks
      .map((l) => {
        const kind: EvidenceKind | null =
          l.evidenceSource === "quickbooks"
            ? "qb_staged"
            : l.evidenceSource === "stripe"
              ? "stripe_charge"
              : null;
        const evId =
          l.evidenceSource === "quickbooks"
            ? l.paymentId
            : l.evidenceSource === "stripe"
              ? l.stripeChargeId
              : null;
        return kind && evId ? `${kind}:${evId}:${l.giftId}` : null;
      })
      .filter((k): k is string => k !== null),
  );

  for (const e of qbStaged) {
    if (out.length >= limit) break;
    if (e.amount == null || !e.date) continue;
    const dayGifts = giftsByDate.get(e.date) ?? [];
    if (dayGifts.length < 2) continue;
    const sum = dayGifts.reduce((s, g) => s + (g.amount ?? 0), 0);
    if (!amountTies(e.amount, sum)) continue;
    const donors = new Set(dayGifts.map((g) => g.donorKey ?? g.id));
    if (donors.size < 2) continue;
    // Skip gifts already linked to this evidence.
    const toLink = dayGifts.filter(
      (g) => !linkedSet.has(`${e.kind}:${e.id}:${g.id}`),
    );
    if (toLink.length < 2) continue;
    const giftIds = toLink.map((g) => g.id);
    const key = linkKey(e.kind, e.id, giftIds);

    out.push({
      kind: "link_evidence",
      key,
      score: 0.8,
      reason: `One ${e.kind === "qb_staged" ? "QuickBooks deposit" : "Stripe charge"} of ${e.amount} on ${e.date} matches the combined total of ${toLink.length} gifts from ${donors.size} donors — likely a bulk deposit batching several donors.`,
      gifts: toLink.map(giftView),
      evidence: evidenceView(e),
      safeApply: true,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// GET /financial-corrections — run the detectors.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : DEFAULT_LIMIT;
    const corrections = await detectFinancialCorrections(limit);
    res.json({ corrections });
  }),
);

// POST /financial-corrections/apply — apply a link_evidence correction:
// corroborate each gift with the evidence row. Idempotent; never edits the
// QB/Stripe source. (merge_gifts is applied via /gifts-and-payments/merge.)
router.post(
  "/apply",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(
      ApplyFinancialCorrectionBody,
      req.body ?? {},
      res,
    );
    if (!body) return;
    const appUser = await getAppUser(req);

    // Validate the evidence row exists.
    if (body.evidenceKind === "qb_staged") {
      const [row] = await db
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, body.evidenceId))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "Evidence row not found" });
        return;
      }
    } else {
      const [row] = await db
        .select({ id: stripeStagedCharges.id })
        .from(stripeStagedCharges)
        .where(eq(stripeStagedCharges.id, body.evidenceId))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "Evidence row not found" });
        return;
      }
    }

    // Validate the gifts exist and are active.
    const found = await db
      .select({ id: giftsAndPayments.id })
      .from(giftsAndPayments)
      .where(
        and(
          inArray(giftsAndPayments.id, body.giftIds),
          isNull(giftsAndPayments.archivedAt),
        ),
      );
    const foundIds = new Set(found.map((g) => g.id));
    const missing = body.giftIds.filter((id) => !foundIds.has(id));
    if (missing.length) {
      res
        .status(400)
        .json({ error: `Unknown or archived gift(s): ${missing.join(", ")}` });
      return;
    }

    // Phase-5 read-flip: write ONLY the corroborating payment_applications row.
    // The legacy gift_evidence_links table has been dropped (Phase-5 §7,
    // deprecate-then-drop); the corroborating ledger is its sole home. Each
    // corroborating link folds into the unit↔gift ledger as
    // a `link_role='corroborating'` row — audit-only, never in the counted SUM;
    // amount_applied stays NULL (this flow carries no sub_amount). It dedupes on
    // the corroborating per-anchor partial UNIQUE, so re-applying the same
    // evidence↔gift is a no-op. NEVER writes a counted row here.
    const now = new Date();
    const evidenceSource: "quickbooks" | "stripe" =
      body.evidenceKind === "qb_staged" ? "quickbooks" : "stripe";
    await db
      .insert(paymentApplications)
      .values(
        body.giftIds.map((giftId) => ({
          id: newId(),
          giftId,
          evidenceSource,
          paymentId: body.evidenceKind === "qb_staged" ? body.evidenceId : null,
          stripeChargeId:
            body.evidenceKind === "stripe_charge" ? body.evidenceId : null,
          amountApplied: null,
          matchMethod: "human" as const,
          linkRole: "corroborating" as const,
          lifecycle: "confirmed" as const,
          confirmedByUserId: appUser?.id ?? null,
          confirmedAt: now,
          createdTheGift: false,
        })),
      )
      .onConflictDoNothing({
        target:
          body.evidenceKind === "qb_staged"
            ? [paymentApplications.paymentId, paymentApplications.giftId]
            : [paymentApplications.stripeChargeId, paymentApplications.giftId],
        where:
          body.evidenceKind === "qb_staged"
            ? sql`${paymentApplications.paymentId} IS NOT NULL AND ${paymentApplications.linkRole} = 'corroborating'`
            : sql`${paymentApplications.stripeChargeId} IS NOT NULL AND ${paymentApplications.linkRole} = 'corroborating'`,
      });

    res.json({
      evidenceKind: body.evidenceKind,
      evidenceId: body.evidenceId,
      linkedGiftIds: body.giftIds,
    });
  }),
);

export default router;
