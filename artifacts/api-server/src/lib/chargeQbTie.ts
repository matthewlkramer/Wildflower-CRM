import { db } from "@workspace/db";
import {
  stripePayouts,
  stagedPayments,
  settlementLinks,
  stripeStagedCharges,
  sourceLinks,
  sourceLinkId,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getUncachableStripeClient } from "./stripeClient";
import { chargeStatusWhere } from "./derivedStatus";
import { sweepRefundedQbStagedPayments } from "./refundedChargeSweep";
import {
  upsertProposedChargeTie,
  clearProposedChargeTie,
} from "./sourceLinkWrites";

/**
 * Charge-grain Stripe ↔ QuickBooks tie proposals ("individually-booked
 * payouts").
 *
 * The payout↔deposit proposer (stripeReconcile.ts) only finds a match when the
 * bookkeeper recorded the payout as ONE net deposit lump. For many payouts —
 * especially single-donation ones — each donation was instead booked as its own
 * QB row under the donor's name, so there is no lump to tie and the payout sits
 * in "Missing deposit" forever. This module PROPOSES per-charge ties: for each
 * Stripe charge inside a no-settlement-link payout, the QB staged_payments row
 * that records the SAME money (exact amount — the charge GROSS or, because
 * bookkeepers sometimes record the post-fee bank deposit instead, the charge
 * NET, both to the cent — close date, and — when several same-amount
 * candidates compete — payer-name similarity).
 *
 * PURELY a proposer: it only ever writes PROPOSED `charge_qb_tie` rows in the
 * `source_links` ledger. It NEVER stamps a CONFIRMED tie (a human approve does
 * that), never touches settlement_links, gifts, or any QB row, and never
 * overwrites a confirmed tie. Idempotent: re-running recomputes the same
 * proposals and clears stale ones.
 */

// ── Pure matching (unit-testable, no DB) ──────────────────────────────────

/** How far the QB row's date may sit from the charge date. Deliberately
 * tighter than the payout-lump window (45d): a per-donation QB row is usually
 * booked near the donation date, and exact-amount matching over a wide window
 * would drag in unrelated same-amount donations. */
export const CHARGE_TIE_WINDOW_DAYS = 20;

/** Minimum payer-name similarity required to disambiguate when MULTIPLE
 * same-amount candidates compete (never assign on amount alone in that case). */
export const NAME_SIM_THRESHOLD = 0.5;

/** Wrong-donor guard for the 1×1 amount-group shortcut: when BOTH payer names
 * are present (tokenizable) and their similarity is below this, the pair flatly
 * contradicts itself — a coincidental same-amount row from a different donor.
 * Never propose it, even though amount + window alone would otherwise suffice.
 * A missing name on either side keeps the shortcut (no contradiction exists). */
export const WRONG_DONOR_NAME_SIM = 0.1;

/** Normalize a payer name into a token set: lowercase, strip punctuation, drop
 * empty tokens. "Beard, Hilary" → {beard, hilary}. */
export function nameTokens(name: string | null | undefined): Set<string> {
  if (!name) return new Set();
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/** Token-set Jaccard similarity between two payer names (0..1). Word-order and
 * punctuation insensitive so "Beard, Hilary" ≈ "Hilary Beard". */
export function nameSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export interface ChargeForTie {
  id: string;
  /** Charge gross amount, major units (donors are credited GROSS). */
  grossAmount: string | null;
  /** Charge net amount after the processor fee, major units. Bookkeepers
   * sometimes book the NET bank deposit instead of the gross donation, so a
   * QB row matching either amount exactly is an eligible tie. */
  netAmount: string | null;
  /** "YYYY-MM-DD" */
  dateReceived: string | null;
  payerName: string | null;
  /** charge.description — often carries the real donor name. */
  description: string | null;
}

export interface QbRowForTie {
  id: string;
  amount: string | null;
  /** "YYYY-MM-DD" */
  dateReceived: string | null;
  payerName: string | null;
}

function toCents(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(dbb)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(da - dbb) / 86_400_000);
}

function chargeName(c: ChargeForTie): string | null {
  return c.payerName ?? c.description ?? null;
}

type TieKind = "gross" | "net";

/** The exact cents a QB row may record for this charge: the GROSS donation
 * and, when it differs (fee > 0), the post-fee NET the bank actually
 * received. Each entry is tagged so gross ties win when both would fit. */
function acceptableCents(c: ChargeForTie): { cents: number; kind: TieKind }[] {
  const out: { cents: number; kind: TieKind }[] = [];
  const gross = toCents(c.grossAmount);
  if (gross != null) out.push({ cents: gross, kind: "gross" });
  const net = toCents(c.netAmount);
  if (net != null && net !== gross) out.push({ cents: net, kind: "net" });
  return out;
}

/**
 * Assign QB rows to charges (both from ONE payout's scope). Pure and
 * deterministic:
 *   • a pair is eligible when the QB amount EXACTLY (to the cent) equals the
 *     charge's GROSS or NET amount and the dates sit within
 *     {@link CHARGE_TIE_WINDOW_DAYS};
 *   • ambiguity is judged per CANDIDATE-amount group (every charge and
 *     candidate eligible at that exact cents value): a 1×1 group assigns on
 *     amount + window alone;
 *   • when SEVERAL charges/candidates compete at one amount, payer-name
 *     similarity ≥ {@link NAME_SIM_THRESHOLD} is REQUIRED — never assign on
 *     amount alone;
 *   • pairs are taken greedily gross-before-net (a row equal to one charge's
 *     gross and another's net is the gross booking first), then
 *     best-similarity, smaller date gap, stable ids — a total order, so the
 *     result never depends on input iteration order;
 *   • one QB row is assigned to at most one charge, one charge gets at most
 *     one QB row.
 * Returns chargeId → qbRowId for every assignment made.
 */
export function assignChargeQbTies(
  charges: ChargeForTie[],
  candidates: QbRowForTie[],
): Map<string, string> {
  interface Pair {
    chargeId: string;
    qbId: string;
    cents: number;
    kind: TieKind;
    sim: number;
    dd: number;
    /** BOTH payer names tokenizable — the similarity is a real comparison. */
    bothNamed: boolean;
  }
  const candsByAmount = new Map<number, QbRowForTie[]>();
  for (const q of candidates) {
    const cents = toCents(q.amount);
    if (cents == null || !q.dateReceived) continue;
    const list = candsByAmount.get(cents) ?? [];
    list.push(q);
    candsByAmount.set(cents, list);
  }

  // ONE global pair list; per-cents membership feeds the ambiguity test.
  const pairs: Pair[] = [];
  const groupChargeIds = new Map<number, Set<string>>();
  const groupQbIds = new Map<number, Set<string>>();
  for (const c of charges) {
    if (!c.dateReceived) continue;
    for (const { cents, kind } of acceptableCents(c)) {
      for (const q of candsByAmount.get(cents) ?? []) {
        const dd = dayDiff(c.dateReceived, q.dateReceived!);
        if (dd > CHARGE_TIE_WINDOW_DAYS) continue;
        pairs.push({
          chargeId: c.id,
          qbId: q.id,
          cents,
          kind,
          sim: nameSimilarity(chargeName(c), q.payerName),
          dd,
          bothNamed:
            nameTokens(chargeName(c)).size > 0 &&
            nameTokens(q.payerName).size > 0,
        });
        (groupChargeIds.get(cents) ??
          groupChargeIds.set(cents, new Set()).get(cents)!).add(c.id);
        (groupQbIds.get(cents) ??
          groupQbIds.set(cents, new Set()).get(cents)!).add(q.id);
      }
    }
  }
  if (pairs.length === 0) return new Map();

  // Unambiguous 1×1 amount group: amount + window is enough evidence alone.
  const unambiguousCents = new Set<number>();
  for (const [cents, chargeIds] of groupChargeIds) {
    if (chargeIds.size === 1 && groupQbIds.get(cents)!.size === 1) {
      unambiguousCents.add(cents);
    }
  }

  pairs.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "gross" ? -1 : 1) ||
      b.sim - a.sim ||
      a.dd - b.dd ||
      (a.qbId < b.qbId ? -1 : a.qbId > b.qbId ? 1 : 0) ||
      (a.chargeId < b.chargeId ? -1 : a.chargeId > b.chargeId ? 1 : 0),
  );

  const assigned = new Map<string, string>();
  const usedQb = new Set<string>();
  for (const p of pairs) {
    if (assigned.has(p.chargeId) || usedQb.has(p.qbId)) continue;
    if (!unambiguousCents.has(p.cents) && p.sim < NAME_SIM_THRESHOLD) continue;
    // Wrong-donor guard: even an unambiguous 1×1 amount group is NOT proposed
    // when both payer names are present and flatly contradict each other —
    // a coincidental same-amount row from a different donor.
    if (
      unambiguousCents.has(p.cents) &&
      p.bothNamed &&
      p.sim < WRONG_DONOR_NAME_SIM
    ) {
      continue;
    }
    assigned.set(p.chargeId, p.qbId);
    usedQb.add(p.qbId);
  }
  return assigned;
}

export interface ManualTieResult {
  /** chargeId → qbRowId for every provided row that was placed. */
  assigned: Map<string, string>;
  /** Per-row problems (row could not be placed). Empty = full success. */
  issues: { qbStagedPaymentId: string; reason: string }[];
}

/**
 * Manual "Tie selected": place EVERY provided QB row onto a distinct untied
 * charge of one payout. The human asserted these rows ARE this payout's money,
 * so the only hard requirement is an exact-amount fit — the row's amount must
 * equal a charge's GROSS or NET amount to the cent (a bijection within each
 * amount group); name similarity and date proximity merely ORDER the
 * assignment when several same-amount charges compete — they never block it.
 * Gross fits are placed before net fits so a row equal to one charge's gross
 * and another's net lands on the gross booking first.
 * Rows that cannot be placed (no untied charge of that amount left) come back
 * as issues; the caller treats any issue as all-or-nothing.
 */
export function assignManualChargeQbTies(
  charges: ChargeForTie[],
  rows: QbRowForTie[],
): ManualTieResult {
  const assigned = new Map<string, string>();
  const issues: ManualTieResult["issues"] = [];
  // cents → charges accepting that exact amount (a charge registers under its
  // gross AND its net, tagged so gross placements order first).
  const freeCharges = new Map<number, { c: ChargeForTie; kind: TieKind }[]>();
  for (const c of charges) {
    for (const { cents, kind } of acceptableCents(c)) {
      const list = freeCharges.get(cents) ?? [];
      list.push({ c, kind });
      freeCharges.set(cents, list);
    }
  }

  // Best-evidence-first: order every (row, charge) pair gross-before-net,
  // then by name similarity, then date gap, so when the amounts are ambiguous
  // the most plausible pairing wins — but any amount-fitting placement is
  // acceptable.
  interface Pair {
    rowId: string;
    chargeId: string;
    cents: number;
    kind: TieKind;
    sim: number;
    dd: number;
  }
  const pairs: Pair[] = [];
  const rowCents = new Map<string, number | null>();
  for (const q of rows) {
    const cents = toCents(q.amount);
    rowCents.set(q.id, cents);
    if (cents == null) continue;
    for (const { c, kind } of freeCharges.get(cents) ?? []) {
      pairs.push({
        rowId: q.id,
        chargeId: c.id,
        cents,
        kind,
        sim: nameSimilarity(chargeName(c), q.payerName),
        dd:
          c.dateReceived && q.dateReceived
            ? dayDiff(c.dateReceived, q.dateReceived)
            : Number.POSITIVE_INFINITY,
      });
    }
  }
  pairs.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "gross" ? -1 : 1) ||
      b.sim - a.sim ||
      a.dd - b.dd ||
      (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0) ||
      (a.chargeId < b.chargeId ? -1 : a.chargeId > b.chargeId ? 1 : 0),
  );
  const usedRows = new Set<string>();
  const usedCharges = new Set<string>();
  for (const p of pairs) {
    if (usedRows.has(p.rowId) || usedCharges.has(p.chargeId)) continue;
    assigned.set(p.chargeId, p.rowId);
    usedRows.add(p.rowId);
    usedCharges.add(p.chargeId);
  }
  for (const q of rows) {
    if (usedRows.has(q.id)) continue;
    const cents = rowCents.get(q.id);
    issues.push({
      qbStagedPaymentId: q.id,
      reason:
        cents == null
          ? "QB row has no amount to match on."
          : "No untied charge of this payout matches this row's exact amount (gross or net).",
    });
  }
  return { assigned, issues };
}

// ── DB proposal pass ──────────────────────────────────────────────────────

export interface ChargeTieSummary {
  /** No-settlement-link payouts examined. */
  payoutsEvaluated: number;
  /** Charges that ended the pass with a proposed QB tie. */
  proposed: number;
  /** Stale proposals cleared (candidate gone / payout left scope). */
  cleared: number;
}

const DAY_MS = 86_400_000;
function shiftDate(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Recompute charge↔QB tie proposals over every payout with NO settlement link
 * (optionally restricted to `payoutIds`). Idempotent. Writes ONLY proposed
 * charge_qb_tie rows in source_links, always guarded on no confirmed tie
 * existing for the charge, so a concurrent human approve is never clobbered.
 *
 * Lock-free like runProposalPass: callers already holding the per-account
 * "stripe" advisory lock call this directly; {@link proposeChargeQbTies} takes
 * the lock for standalone (route-triggered) runs.
 */
export async function runChargeTiePass(
  payoutIds?: string[],
): Promise<ChargeTieSummary> {
  let cleared = 0;

  // Scope exit: a charge whose payout HAS a settlement link (the lump path owns
  // it) must not keep a stale charge-grain proposal around. Confirmed ties are
  // untouched — only PROPOSED claims clear. The ledger is the sole authority.
  const scopeExitLedger = await db.execute<{ charge_id: string }>(sql`
    DELETE FROM source_links srcl
    USING stripe_staged_charges c
    WHERE srcl.link_type = 'charge_qb_tie'
      AND srcl.lifecycle = 'proposed'
      AND srcl.stripe_charge_id = c.id
      AND EXISTS (
        SELECT 1 FROM settlement_links sl
        WHERE sl.payout_id = c.stripe_payout_id
      )
    RETURNING c.id AS charge_id
  `);
  cleared += new Set(scopeExitLedger.rows.map((r) => r.charge_id)).size;

  // Payouts with NO settlement link at all (the "Missing deposit" pool).
  const noLink = sql`NOT EXISTS (
    SELECT 1 FROM settlement_links sl WHERE sl.payout_id = ${stripePayouts.id}
  )`;
  const payouts = await db
    .select({ id: stripePayouts.id })
    .from(stripePayouts)
    .where(
      payoutIds && payoutIds.length
        ? and(noLink, inArray(stripePayouts.id, payoutIds))
        : noLink,
    );

  let proposed = 0;

  for (const p of payouts) {
    // The payout's open charges: no confirmed tie, not terminal. Terminal
    // (excluded) charges never get a QB tie — they are already "settled" for
    // this report's purposes. (Status is DERIVED — lib/derivedStatus.ts.)
    const charges = await db
      .select({
        id: stripeStagedCharges.id,
        grossAmount: stripeStagedCharges.grossAmount,
        netAmount: stripeStagedCharges.netAmount,
        dateReceived: stripeStagedCharges.dateReceived,
        payerName: stripeStagedCharges.payerName,
        description: stripeStagedCharges.description,
        // Current PROPOSED tie from the source_links ledger (the authority).
        proposedQbStagedPaymentId: sql<string | null>`(
          SELECT srcl.qb_staged_payment_id FROM source_links srcl
          WHERE srcl.link_type = 'charge_qb_tie'
            AND srcl.lifecycle = 'proposed'
            AND srcl.stripe_charge_id = "stripe_staged_charges"."id"
        )`,
      })
      .from(stripeStagedCharges)
      .where(
        and(
          eq(stripeStagedCharges.stripePayoutId, p.id),
          sql`NOT EXISTS (
            SELECT 1 FROM source_links srcl
            WHERE srcl.link_type = 'charge_qb_tie'
              AND srcl.lifecycle = 'confirmed'
              AND srcl.stripe_charge_id = "stripe_staged_charges"."id"
          )`,
          sql`NOT ${chargeStatusWhere.excluded}`,
        ),
      );
    if (charges.length === 0) continue;

    const matchable = charges.filter(
      (c) => c.grossAmount != null && c.dateReceived != null,
    );

    let assignment = new Map<string, string>();
    if (matchable.length > 0) {
      // A QB row may record the charge GROSS (donation amount) or its NET
      // (post-fee bank deposit) — candidate on the union of both.
      const amounts = [
        ...new Set(
          matchable.flatMap((c) =>
            [c.grossAmount as string, c.netAmount].filter(
              (a): a is string => a != null,
            ),
          ),
        ),
      ];
      const dates = matchable
        .map((c) => c.dateReceived as string)
        .sort();
      const fromStr = shiftDate(dates[0]!, -CHARGE_TIE_WINDOW_DAYS);
      const toStr = shiftDate(
        dates[dates.length - 1]!,
        CHARGE_TIE_WINDOW_DAYS,
      );

      // Candidate QB rows: exact one-of-the-charge-amounts, inside the widest
      // per-payout window (the pure assigner re-checks per charge), an active
      // status, and NOT already spoken for — not a settlement-link deposit
      // (any lifecycle), not confirmed-tied to any charge, and not proposed to
      // a charge of ANOTHER payout (this pass re-derives its own payout's
      // proposals).
      const cands = await db
        .select({
          id: stagedPayments.id,
          amount: stagedPayments.amount,
          dateReceived: stagedPayments.dateReceived,
          payerName: stagedPayments.payerName,
        })
        .from(stagedPayments)
        .where(
          and(
            inArray(stagedPayments.amount, amounts),
            // EXCLUDED rows stay eligible (task-774 ratified decision): an
            // exclusion classifies the row out of the DONATION review queue,
            // but it can still be the QB booking of this charge's money —
            // exclusion must not block matching. Refund-swept rows are safe:
            // a swept row's tie already exists (confirmed → filtered below).
            sql`${stagedPayments.dateReceived} >= ${fromStr}`,
            sql`${stagedPayments.dateReceived} <= ${toStr}`,
            sql`NOT EXISTS (
              SELECT 1 FROM settlement_links sl
              WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM source_links srcl
              WHERE srcl.link_type = 'charge_qb_tie'
                AND srcl.lifecycle = 'confirmed'
                AND srcl.qb_staged_payment_id = "staged_payments"."id"
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM source_links srcl
              JOIN stripe_staged_charges cc ON cc.id = srcl.stripe_charge_id
              WHERE srcl.link_type = 'charge_qb_tie'
                AND srcl.lifecycle = 'proposed'
                AND srcl.qb_staged_payment_id = "staged_payments"."id"
                AND cc.stripe_payout_id IS DISTINCT FROM ${p.id}
            )`,
          ),
        );

      assignment = assignChargeQbTies(matchable, cands);
    }

    // Persist this payout's proposals in ONE transaction: clear stale ones,
    // then stamp the fresh assignment. Ledger writes are guarded on the tie
    // row not being CONFIRMED (a racing human approve wins).
    await db.transaction(async (tx) => {
      for (const c of charges) {
        const want = assignment.get(c.id) ?? null;
        if (c.proposedQbStagedPaymentId === want) continue;
        if (want == null) {
          await clearProposedChargeTie(tx, c.id);
          cleared += 1;
        } else {
          await upsertProposedChargeTie(tx, c.id, want);
        }
      }
    });
    proposed += assignment.size;
  }

  // Fresh tie proposals can complete a pending QB row's Stripe trace as
  // all-refunded money — sweep so it auto-excludes without waiting for the
  // next scheduled sync (idempotent, one guarded UPDATE).
  await sweepRefundedQbStagedPayments();

  return { payoutsEvaluated: payouts.length, proposed, cleared };
}

// ── Sibling "Stripe fee" row auto-claim (confirm-time only) ───────────────
//
// When a bookkeeper records a charge's GROSS donation as its own QB deposit
// line, the same deposit usually carries a sibling NEGATIVE "Stripe fee" line
// (gross + fee = the net that hit the bank). Once the donor line is tie-
// confirmed, that fee line is fully explained too — claim it onto the charge
// (`linked_fee_qb_staged_payment_id`) so it stops looking like unreconciled
// money. Plane-1 settlement EVIDENCE only: fee rows NEVER enter
// payment_applications and are never summed into any money trail.

/** One just-confirmed charge tie, as input to the fee-row pairing. */
export interface FeeChargeInput {
  chargeId: string;
  /** Deposit identity of the tied donor QB row (realm + entity type + id). */
  depositKey: string;
  /** The charge's processor fee in cents (gross − net), > 0. */
  feeCents: number;
}

/** One candidate negative QB fee row. */
export interface FeeRowInput {
  id: string;
  depositKey: string;
  /** ABSOLUTE fee cents (the row's negated amount), > 0. */
  feeCents: number;
  qbLineId: string;
}

/**
 * Pair fee rows to charges, pure and deterministic. Within each
 * (deposit, fee-amount) group — e.g. two $500.00 donations in one deposit,
 * each with a −$13.11 fee line — charges (ordered by id) and fee rows
 * (ordered by qb_line_id, id) pair rank-to-rank, so each row is claimed at
 * most once and reruns reproduce the same pairing. Mirrors the 0127 backfill
 * exactly. (Nit: TS sorts by code point while the SQL backfill uses the DB
 * collation — mixed-case ids in an equal-fee twin group could pair in a
 * different order. All fees in a group are identical, so any pairing is
 * equally valid evidence.)
 */
export function pairChargeFeeRows(
  charges: FeeChargeInput[],
  rows: FeeRowInput[],
): Map<string, string> {
  const groupKey = (depositKey: string, feeCents: number) =>
    `${depositKey}\u0000${feeCents}`;
  const rowsByGroup = new Map<string, FeeRowInput[]>();
  for (const r of rows) {
    const k = groupKey(r.depositKey, r.feeCents);
    const list = rowsByGroup.get(k) ?? [];
    list.push(r);
    rowsByGroup.set(k, list);
  }
  for (const list of rowsByGroup.values()) {
    list.sort(
      (a, b) =>
        (a.qbLineId < b.qbLineId ? -1 : a.qbLineId > b.qbLineId ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  const chargesByGroup = new Map<string, FeeChargeInput[]>();
  for (const c of charges) {
    const k = groupKey(c.depositKey, c.feeCents);
    const list = chargesByGroup.get(k) ?? [];
    list.push(c);
    chargesByGroup.set(k, list);
  }
  const assigned = new Map<string, string>();
  for (const [k, cs] of chargesByGroup) {
    cs.sort((a, b) =>
      a.chargeId < b.chargeId ? -1 : a.chargeId > b.chargeId ? 1 : 0,
    );
    const rs = rowsByGroup.get(k) ?? [];
    const n = Math.min(cs.length, rs.length);
    for (let i = 0; i < n; i++) {
      assigned.set(cs[i]!.chargeId, rs[i]!.id);
    }
  }
  return assigned;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Detect and claim the sibling negative "Stripe fee" QB rows for a set of
 * JUST-CONFIRMED charge ties, inside the same transaction. For each tied
 * charge with a real fee (gross > net), a candidate is a NEGATIVE row of the
 * SAME QB deposit as the tied donor row whose amount is exactly
 * −(gross − net) to the cent, with a fee-ish payer/description, not spoken
 * for anywhere (not fee-claimed, not donor-tied/proposed, not a
 * settlement-link deposit). Candidates are locked FOR UPDATE, paired via
 * {@link pairChargeFeeRows}, and stamped guarded — a best-effort enrichment
 * that claims what it can and never aborts the confirm.
 * Returns the number of fee rows claimed.
 */
export async function claimSiblingFeeRows(
  tx: Tx,
  ties: { chargeId: string; qbId: string }[],
  chargeAmounts: Map<
    string,
    { grossAmount: string | null; netAmount: string | null }
  >,
): Promise<number> {
  // Charges with a real fee to look for.
  const withFee: { chargeId: string; qbId: string; feeCents: number }[] = [];
  for (const t of ties) {
    const a = chargeAmounts.get(t.chargeId);
    if (!a) continue;
    const gross = toCents(a.grossAmount);
    const net = toCents(a.netAmount);
    if (gross == null || net == null || gross <= net) continue;
    withFee.push({ ...t, feeCents: gross - net });
  }
  if (withFee.length === 0) return 0;

  // Deposit identity of each tied donor row.
  const donorRows = await tx
    .select({
      id: stagedPayments.id,
      realmId: stagedPayments.realmId,
      qbEntityType: stagedPayments.qbEntityType,
      qbEntityId: stagedPayments.qbEntityId,
    })
    .from(stagedPayments)
    .where(
      inArray(
        stagedPayments.id,
        withFee.map((t) => t.qbId),
      ),
    );
  const depositKeyById = new Map(
    donorRows.map((r) => [
      r.id,
      `${r.realmId}\u0000${r.qbEntityType}\u0000${r.qbEntityId}`,
    ]),
  );

  const feeCharges: FeeChargeInput[] = [];
  const deposits = new Map<string, (typeof donorRows)[number]>();
  for (const t of withFee) {
    const key = depositKeyById.get(t.qbId);
    if (!key) continue;
    feeCharges.push({
      chargeId: t.chargeId,
      depositKey: key,
      feeCents: t.feeCents,
    });
    deposits.set(key, donorRows.find((d) => d.id === t.qbId)!);
  }
  if (feeCharges.length === 0) return 0;

  // Candidate fee rows across the tied deposits, locked so a concurrent
  // confirm can't claim the same row. (Negative rows are auto-excluded from
  // review, so NO status filter here — excluded IS the fee row's status.)
  const depositPredicates = [...deposits.values()].map((d) =>
    and(
      eq(stagedPayments.realmId, d.realmId),
      eq(stagedPayments.qbEntityType, d.qbEntityType),
      eq(stagedPayments.qbEntityId, d.qbEntityId),
    ),
  );
  const candidates = await tx
    .select({
      id: stagedPayments.id,
      realmId: stagedPayments.realmId,
      qbEntityType: stagedPayments.qbEntityType,
      qbEntityId: stagedPayments.qbEntityId,
      amount: stagedPayments.amount,
      qbLineId: stagedPayments.qbLineId,
    })
    .from(stagedPayments)
    .where(
      and(
        or(...depositPredicates),
        sql`${stagedPayments.amount}::numeric < 0`,
        sql`(${stagedPayments.payerName} ILIKE '%stripe%'
          OR ${stagedPayments.lineDescription} ILIKE '%stripe%'
          OR ${stagedPayments.lineDescription} ILIKE '%fee%')`,
        sql`NOT EXISTS (
          SELECT 1 FROM source_links srcl
          WHERE srcl.link_type = 'charge_fee_row'
            AND srcl.qb_staged_payment_id = "staged_payments"."id"
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM source_links srcl
          WHERE srcl.link_type = 'charge_qb_tie'
            AND srcl.qb_staged_payment_id = "staged_payments"."id"
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM settlement_links sl
          WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
        )`,
      ),
    )
    .for("update");

  const feeRows: FeeRowInput[] = [];
  for (const r of candidates) {
    const cents = toCents(r.amount);
    if (cents == null || cents >= 0) continue;
    feeRows.push({
      id: r.id,
      depositKey: `${r.realmId}\u0000${r.qbEntityType}\u0000${r.qbEntityId}`,
      feeCents: -cents,
      qbLineId: r.qbLineId,
    });
  }

  const pairing = pairChargeFeeRows(feeCharges, feeRows);
  let claimed = 0;
  const now = new Date();
  for (const [chargeId, feeRowId] of pairing) {
    // Stamp under a savepoint: a cross-payout race on a SHARED deposit can
    // still hit the partial unique index (the loser's snapshot may not see
    // the winner's claim). Roll back just this stamp and move on — the fee
    // link is best-effort evidence and must never abort the confirm.
    await tx.execute(sql`SAVEPOINT fee_claim_stamp`);
    try {
      // Ledger first (the authority): claim only if no fee link exists yet
      // for this charge — deterministic id makes the insert the guard.
      const inserted = await tx
        .insert(sourceLinks)
        .values({
          id: sourceLinkId("charge_fee_row", chargeId),
          linkType: "charge_fee_row",
          stripeChargeId: chargeId,
          qbStagedPaymentId: feeRowId,
          lifecycle: "confirmed",
          provenance: "system_confirmed",
          confirmedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: sourceLinks.id });
      if (inserted.length) {
        claimed += inserted.length;
      }
      await tx.execute(sql`RELEASE SAVEPOINT fee_claim_stamp`);
    } catch (err) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT fee_claim_stamp`);
      logger.warn(
        { chargeId, feeRowId, err },
        "Skipped sibling fee-row claim (likely claimed concurrently)",
      );
    }
  }
  return claimed;
}

export interface ProposeChargeTiesResult extends ChargeTieSummary {
  ran: boolean;
}

/**
 * Standalone (route-triggered) charge-tie proposal pass. Takes the per-account
 * "stripe" advisory lock so it serializes against the sync / backfill workers,
 * then runs {@link runChargeTiePass}. A no-op (ran:false) when the Stripe
 * connector is unavailable.
 */
export async function proposeChargeQbTies(
  opts: { payoutIds?: string[] } = {},
): Promise<ProposeChargeTiesResult> {
  let accountId: string | null;
  try {
    ({ accountId } = await getUncachableStripeClient());
  } catch (e) {
    logger.debug(
      { err: e },
      "Charge-tie pass: Stripe connector unavailable, skipping",
    );
    return { ran: false, payoutsEvaluated: 0, proposed: 0, cleared: 0 };
  }
  if (!accountId) {
    return { ran: false, payoutsEvaluated: 0, proposed: 0, cleared: 0 };
  }

  const outcome = await withSyncLock(accountId, "stripe", () =>
    runChargeTiePass(opts.payoutIds),
  );
  if (!outcome.ran) {
    return { ran: false, payoutsEvaluated: 0, proposed: 0, cleared: 0 };
  }
  return { ran: true, ...outcome.result! };
}
