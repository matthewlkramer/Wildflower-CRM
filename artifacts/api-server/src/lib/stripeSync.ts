import { db } from "@workspace/db";
import {
  stripeSyncState,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getUncachableStripeClient } from "./stripeClient";
import { scoreStripeCharge } from "./stripeMatch";
import { runProposalPass } from "./stripeReconcile";
import { deriveRefundProposal } from "./stripeRefund";
import { ensureBundleDraftsForAnchors } from "./reconciliationBundleSync";

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23505"
  );
}

export interface StripeSyncSummary {
  ran: boolean;
  payouts: number;
  staged: number;
  matched: number;
  autoApplied: number;
  refundProposals: number;
}

// ── Pure helpers (unit-testable without Stripe) ───────────────────────────

/** Stripe minor units (integer cents) → major-unit fixed-2 string. */
export function minorToAmount(
  minor: number | null | undefined,
): string | null {
  if (minor == null || Number.isNaN(minor)) return null;
  return (minor / 100).toFixed(2);
}

const CHICAGO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Stripe epoch-seconds → "YYYY-MM-DD" in America/Chicago (the org's books are
 * kept in central time). en-CA already formats as ISO yyyy-mm-dd.
 */
export function chargeDateReceived(
  epochSeconds: number | null | undefined,
): string | null {
  if (epochSeconds == null) return null;
  return CHICAGO_DATE.format(new Date(epochSeconds * 1000));
}

export interface ChargeFacts {
  payerName: string | null;
  payerEmail: string | null;
  description: string | null;
  statementDescriptor: string | null;
  cardBrand: string | null;
  metadata: Record<string, string> | null;
  refunded: boolean;
  disputed: boolean;
  grossAmount: string | null;
  amountRefunded: string | null;
  currency: string | null;
  stripePaymentIntentId: string | null;
  stripeCustomerId: string | null;
  chargeCreated: Date | null;
  dateReceived: string | null;
}

/**
 * Pull the donor-identifying facts off a (settled) Stripe charge. Donors are
 * credited the captured GROSS amount; the processor fee is taken out at the
 * payout level, not the donor's gift.
 */
export function extractChargeFacts(charge: Stripe.Charge): ChargeFacts {
  const bd = charge.billing_details;
  const card =
    charge.payment_method_details && "card" in charge.payment_method_details
      ? charge.payment_method_details.card
      : null;
  const meta =
    charge.metadata && Object.keys(charge.metadata).length > 0
      ? charge.metadata
      : null;
  return {
    payerName: bd?.name ?? null,
    payerEmail: bd?.email ?? charge.receipt_email ?? null,
    description: charge.description ?? null,
    statementDescriptor:
      charge.statement_descriptor ??
      charge.calculated_statement_descriptor ??
      null,
    cardBrand: card?.brand ?? null,
    metadata: meta,
    refunded: charge.refunded === true,
    disputed: charge.disputed === true,
    grossAmount: minorToAmount(charge.amount_captured ?? charge.amount),
    amountRefunded: minorToAmount(charge.amount_refunded ?? 0),
    currency: charge.currency ?? null,
    stripePaymentIntentId:
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? null),
    stripeCustomerId:
      typeof charge.customer === "string"
        ? charge.customer
        : (charge.customer?.id ?? null),
    chargeCreated: charge.created ? new Date(charge.created * 1000) : null,
    dateReceived: chargeDateReceived(charge.created),
  };
}

export interface PayoutRollup {
  grossTotal: string;
  feeTotal: string;
  refundTotal: string;
  netTotal: string;
  chargeCount: number;
}

/**
 * Roll a payout's balance transactions into payout-level totals:
 *   gross  — Σ charge/payment amounts (what donors gave)
 *   fee    — Σ processor fees on every txn
 *   refund — Σ |refund amounts|
 *   net    — gross − fee − refund  (≈ payout.amount that hit the bank)
 */
export function rollupPayout(
  bts: Stripe.BalanceTransaction[],
): PayoutRollup {
  let grossMinor = 0;
  let feeMinor = 0;
  let refundMinor = 0;
  let chargeCount = 0;
  for (const bt of bts) {
    feeMinor += bt.fee ?? 0;
    if (bt.type === "charge" || bt.type === "payment") {
      grossMinor += bt.amount;
      chargeCount += 1;
    } else if (bt.type === "refund" || bt.type === "payment_refund") {
      refundMinor += Math.abs(bt.amount);
    }
  }
  const netMinor = grossMinor - feeMinor - refundMinor;
  return {
    grossTotal: (grossMinor / 100).toFixed(2),
    feeTotal: (feeMinor / 100).toFixed(2),
    refundTotal: (refundMinor / 100).toFixed(2),
    netTotal: (netMinor / 100).toFixed(2),
    chargeCount,
  };
}

/** Narrow an expanded balance-transaction source to a Charge. */
function chargeFromSource(
  source: Stripe.BalanceTransaction["source"],
): Stripe.Charge | null {
  if (source && typeof source !== "string" && source.object === "charge") {
    return source;
  }
  return null;
}

/**
 * Resolve the charge id behind a refund- or dispute-type balance transaction
 * (the original charge is not re-listed when a refund/dispute settles later, so
 * we key off the refund/dispute source's `charge` pointer). Returns null for
 * any other balance-transaction type.
 */
function refundOrDisputeChargeId(
  bt: Stripe.BalanceTransaction,
): string | null {
  const src = bt.source;
  if (!src || typeof src === "string") return null;
  if (src.object === "refund" || src.object === "dispute") {
    const ch = (src as Stripe.Refund | Stripe.Dispute).charge;
    return typeof ch === "string" ? ch : (ch?.id ?? null);
  }
  return null;
}

/**
 * Detect Stripe refunds / chargebacks that landed on charges already booked
 * into CRM gifts and RAISE a propose-then-confirm proposal on the staged row
 * (INV-13). Never mutates the gift — a human confirms/dismisses in the queue.
 *
 * The original charge is not in this payout's balance transactions, so we
 * resolve the charge id from each refund/dispute source, re-retrieve the charge
 * for authoritative `refunded` / `disputed` / `amount_refunded` facts, refresh
 * those live facts on the staged row (bypassing the upsert status guard that
 * skips reconciled rows), and raise/escalate a proposal when one is warranted.
 * Idempotent: `deriveRefundProposal` won't re-raise an already-handled refund.
 */
async function propagateRefundsForPayout(
  stripe: Stripe,
  bts: Stripe.BalanceTransaction[],
): Promise<number> {
  const chargeIds = new Set<string>();
  for (const bt of bts) {
    const cid = refundOrDisputeChargeId(bt);
    if (cid) chargeIds.add(cid);
  }
  if (chargeIds.size === 0) return 0;

  let proposed = 0;
  for (const chargeId of chargeIds) {
    // Only charges we've already staged are relevant; an unstaged charge has no
    // gift to propagate to and will be handled when it is first staged.
    const row = await db
      .select({
        id: stripeStagedCharges.id,
        matchedGiftId: stripeStagedCharges.matchedGiftId,
        createdGiftId: stripeStagedCharges.createdGiftId,
        refundPropagationGiftId: stripeStagedCharges.refundPropagationGiftId,
        refundPropagationStatus: stripeStagedCharges.refundPropagationStatus,
        refundPropagationKind: stripeStagedCharges.refundPropagationKind,
        refundProposedAmount: stripeStagedCharges.refundProposedAmount,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, chargeId))
      .then((r) => r[0]);
    if (!row) continue;

    let charge: Stripe.Charge;
    try {
      charge = await stripe.charges.retrieve(chargeId);
    } catch (e) {
      logger.warn(
        { err: e, chargeId },
        "Stripe refund sync: charge retrieve failed; skipping",
      );
      continue;
    }
    const facts = extractChargeFacts(charge);

    const giftId =
      row.matchedGiftId ??
      row.createdGiftId ??
      row.refundPropagationGiftId ??
      null;

    const proposal = deriveRefundProposal(
      {
        refunded: facts.refunded,
        disputed: facts.disputed,
        amountRefunded: facts.amountRefunded,
        grossAmount: facts.grossAmount,
      },
      {
        refundPropagationStatus: row.refundPropagationStatus,
        refundPropagationKind: row.refundPropagationKind,
        refundProposedAmount: row.refundProposedAmount,
      },
      giftId != null,
    );

    await db
      .update(stripeStagedCharges)
      .set({
        // Always refresh the live refund facts (the upsert guard skips
        // reconciled rows, so reconciled-then-refunded would otherwise stay
        // stale).
        refunded: facts.refunded,
        disputed: facts.disputed,
        amountRefunded: facts.amountRefunded,
        ...(facts.grossAmount != null ? { grossAmount: facts.grossAmount } : {}),
        rawCharge: charge as unknown as Record<string, unknown>,
        ...(proposal
          ? {
              refundPropagationStatus: "proposed" as const,
              refundPropagationKind: proposal.kind,
              refundPropagationGiftId: giftId,
              refundProposedAmount: proposal.reversedAmount,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(stripeStagedCharges.id, chargeId));

    if (proposal) proposed += 1;
  }
  return proposed;
}

// ── Idempotent staged-charge upsert (preserve review state) ───────────────

/**
 * Upsert one staged charge keyed on its Stripe charge id (the PK). On conflict
 * we only refresh read-only Stripe facts (amounts, payer, refund/dispute flags,
 * payout link) and NEVER touch review state (status / donor match / gift
 * linkage). `enrichAllStatuses` lifts the status guard for a full backfill.
 */
function buildStagedChargeUpsert(
  values: typeof stripeStagedCharges.$inferInsert,
  opts: { enrichAllStatuses?: boolean } = {},
) {
  const set = {
    stripePayoutId: sql`coalesce(excluded.stripe_payout_id, ${stripeStagedCharges.stripePayoutId})`,
    stripeBalanceTransactionId: sql`coalesce(excluded.stripe_balance_transaction_id, ${stripeStagedCharges.stripeBalanceTransactionId})`,
    stripePaymentIntentId: sql`coalesce(excluded.stripe_payment_intent_id, ${stripeStagedCharges.stripePaymentIntentId})`,
    stripeCustomerId: sql`coalesce(excluded.stripe_customer_id, ${stripeStagedCharges.stripeCustomerId})`,
    grossAmount: sql`coalesce(excluded.gross_amount, ${stripeStagedCharges.grossAmount})`,
    feeAmount: sql`coalesce(excluded.fee_amount, ${stripeStagedCharges.feeAmount})`,
    netAmount: sql`coalesce(excluded.net_amount, ${stripeStagedCharges.netAmount})`,
    amountRefunded: sql`coalesce(excluded.amount_refunded, ${stripeStagedCharges.amountRefunded})`,
    currency: sql`coalesce(excluded.currency, ${stripeStagedCharges.currency})`,
    chargeCreated: sql`coalesce(excluded.charge_created, ${stripeStagedCharges.chargeCreated})`,
    dateReceived: sql`coalesce(excluded.date_received, ${stripeStagedCharges.dateReceived})`,
    payerName: sql`coalesce(excluded.payer_name, ${stripeStagedCharges.payerName})`,
    payerEmail: sql`coalesce(excluded.payer_email, ${stripeStagedCharges.payerEmail})`,
    description: sql`coalesce(excluded.description, ${stripeStagedCharges.description})`,
    statementDescriptor: sql`coalesce(excluded.statement_descriptor, ${stripeStagedCharges.statementDescriptor})`,
    cardBrand: sql`coalesce(excluded.card_brand, ${stripeStagedCharges.cardBrand})`,
    metadata: sql`coalesce(excluded.metadata, ${stripeStagedCharges.metadata})`,
    // Live facts that can flip after staging — always refresh.
    refunded: sql`excluded.refunded`,
    disputed: sql`excluded.disputed`,
    rawCharge: sql`coalesce(excluded.raw_charge, ${stripeStagedCharges.rawCharge})`,
    updatedAt: new Date(),
  };
  const base = db
    .insert(stripeStagedCharges)
    .values(values)
    .onConflictDoUpdate({
      target: stripeStagedCharges.id,
      set,
      ...(opts.enrichAllStatuses
        ? {}
        : {
            setWhere: sql`${stripeStagedCharges.status} in ('pending','excluded')`,
          }),
    });
  return base;
}

/**
 * Auto-RECONCILE a high-confidence charge to the single existing gift it
 * matched (never mints). Guards that no other staged_payments OR
 * stripe_staged_charges row already claims the gift; the partial-unique index
 * backstops a true race. Leaves the row pending on contention.
 */
async function stripeAutoApply(
  chargeId: string,
  giftId: string,
): Promise<boolean> {
  try {
    const upd = await db
      .update(stripeStagedCharges)
      .set({
        status: "approved",
        matchStatus: "matched",
        matchedGiftId: giftId,
        autoApplied: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, chargeId),
          eq(stripeStagedCharges.status, "pending"),
          sql`NOT EXISTS (
            SELECT 1 FROM staged_payments sp
            WHERE sp.matched_gift_id = ${giftId} OR sp.created_gift_id = ${giftId}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM stripe_staged_charges sc2
            WHERE (sc2.matched_gift_id = ${giftId} OR sc2.created_gift_id = ${giftId})
              AND sc2.id <> ${chargeId}
          )`,
        ),
      )
      .returning({ id: stripeStagedCharges.id });
    return upd.length > 0;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/**
 * Stage one payout: record its rollup (idempotent) and stage one review-queue
 * row per settled charge (idempotent by charge id, preserving review state),
 * reconcile-only auto-applying high-confidence matches. Shared by the ongoing
 * sync and the historical backfill. `enrichAllStatuses` lifts the upsert status
 * guard so a full re-pull refreshes read-only Stripe facts on already-resolved
 * rows non-destructively (never touches review/reconciliation state).
 */
async function stagePayoutAndCharges(
  stripe: Stripe,
  accountId: string,
  payout: Stripe.Payout,
  opts: { enrichAllStatuses?: boolean } = {},
): Promise<{
  staged: number;
  matched: number;
  autoApplied: number;
  refundProposals: number;
}> {
  let staged = 0;
  let matched = 0;
  let autoApplied = 0;

  // All balance transactions that settled in this payout, charge sources
  // expanded so we can read donor facts in one pass.
  const bts: Stripe.BalanceTransaction[] = [];
  for await (const bt of stripe.balanceTransactions.list({
    payout: payout.id,
    limit: 100,
    expand: ["data.source"],
  })) {
    bts.push(bt);
  }
  const rollup = rollupPayout(bts);

  await db
    .insert(stripePayouts)
    .values({
      id: payout.id,
      stripeAccountId: accountId,
      amount: minorToAmount(payout.amount),
      currency: payout.currency ?? null,
      status: payout.status ?? null,
      automatic: payout.automatic ?? null,
      arrivalDate: payout.arrival_date
        ? chargeDateReceived(payout.arrival_date)
        : null,
      payoutCreated: payout.created ? new Date(payout.created * 1000) : null,
      grossTotal: rollup.grossTotal,
      feeTotal: rollup.feeTotal,
      refundTotal: rollup.refundTotal,
      netTotal: rollup.netTotal,
      chargeCount: rollup.chargeCount,
      rawPayout: payout as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: stripePayouts.id,
      set: {
        amount: minorToAmount(payout.amount),
        currency: payout.currency ?? null,
        status: payout.status ?? null,
        automatic: payout.automatic ?? null,
        arrivalDate: payout.arrival_date
          ? chargeDateReceived(payout.arrival_date)
          : null,
        grossTotal: rollup.grossTotal,
        feeTotal: rollup.feeTotal,
        refundTotal: rollup.refundTotal,
        netTotal: rollup.netTotal,
        chargeCount: rollup.chargeCount,
        rawPayout: payout as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });

  for (const bt of bts) {
    if (bt.type !== "charge" && bt.type !== "payment") continue;
    const charge = chargeFromSource(bt.source);
    if (!charge) continue;

    const facts = extractChargeFacts(charge);
    const scored = await scoreStripeCharge({
      payerName: facts.payerName,
      payerEmail: facts.payerEmail,
      description: facts.description,
      statementDescriptor: facts.statementDescriptor,
      grossAmount: facts.grossAmount,
      dateReceived: facts.dateReceived,
    });

    const matchStatus =
      scored.tier === "high"
        ? "matched"
        : scored.tier === "suggested"
          ? "suggested"
          : "unmatched";
    const donor =
      scored.tier !== "none"
        ? scored.donor
        : {
            organizationId: null,
            individualGiverPersonId: null,
            householdId: null,
          };

    const inserted = await buildStagedChargeUpsert(
      {
        id: charge.id,
        stripeAccountId: accountId,
        stripePayoutId: payout.id,
        stripeBalanceTransactionId: bt.id,
        stripePaymentIntentId: facts.stripePaymentIntentId,
        stripeCustomerId: facts.stripeCustomerId,
        grossAmount: facts.grossAmount,
        feeAmount: minorToAmount(bt.fee),
        netAmount: minorToAmount(bt.net),
        amountRefunded: facts.amountRefunded,
        currency: facts.currency,
        chargeCreated: facts.chargeCreated,
        dateReceived: facts.dateReceived,
        payerName: facts.payerName,
        payerEmail: facts.payerEmail,
        description: facts.description,
        statementDescriptor: facts.statementDescriptor,
        cardBrand: facts.cardBrand,
        metadata: facts.metadata ?? undefined,
        refunded: facts.refunded,
        disputed: facts.disputed,
        rawCharge: charge as unknown as Record<string, unknown>,
        status: "pending",
        classificationSource: "auto",
        matchStatus,
        matchScore: scored.method ? scored.score : null,
        matchMethod: scored.method,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        matchedPaymentIntermediaryId: scored.intermediaryId,
      },
      { enrichAllStatuses: opts.enrichAllStatuses },
    ).returning({
      id: stripeStagedCharges.id,
      isInsert: sql<boolean>`(xmax = 0)`,
    });

    const newRow = inserted[0];
    if (!newRow?.isInsert) continue;
    staged += 1;
    if (scored.method && scored.tier !== "none") matched += 1;

    // Reconcile-only auto-apply (mirrors QuickBooks): link to the single
    // existing gift when confident; never mint here.
    if (scored.tier === "high" && scored.matchedGiftId) {
      const did = await stripeAutoApply(charge.id, scored.matchedGiftId);
      if (did) autoApplied += 1;
    }
  }

  // Propose any refunds/chargebacks that landed on this payout against the
  // already-booked gifts behind the original charges (propose-then-confirm).
  const refundProposals = await propagateRefundsForPayout(stripe, bts);

  return { staged, matched, autoApplied, refundProposals };
}

// ── Background full re-pull ("backfill all payouts") ──────────────────────
//
// The ongoing syncStripe() only pulls payouts created at/after the per-account
// watermark, and the first-ever run seeds that watermark to "now" — so the
// historical back-catalogue (e.g. 2019–2021 payouts that predate when the sync
// was first switched on) was never pulled. A full re-pull lifts the watermark
// floor and re-walks every payout from the account's beginning, backfilling the
// missing payout + charge records non-destructively (review state preserved). It
// can take several minutes, so it runs in the background and the UI polls the
// status below — mirrors the QuickBooks full re-pull pattern.

export type StripeFullResyncStatus = "idle" | "running" | "done" | "error";

export interface StripeFullResyncState {
  status: StripeFullResyncStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: StripeSyncSummary | null;
  error: string | null;
}

let stripeFullResyncState: StripeFullResyncState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
};

export function getStripeFullResyncState(): StripeFullResyncState {
  return stripeFullResyncState;
}

/**
 * Start a full Stripe re-pull in the background and return the current state
 * immediately. If one is already running this is a no-op that returns the
 * in-progress state (the per-account advisory lock is the real guard against
 * concurrent Stripe pulls; this only keeps the UI from launching a second
 * poller).
 */
export function startStripeFullResync(): StripeFullResyncState {
  if (stripeFullResyncState.status === "running") return stripeFullResyncState;

  const startedAt = new Date().toISOString();
  stripeFullResyncState = {
    status: "running",
    startedAt,
    finishedAt: null,
    summary: null,
    error: null,
  };

  void (async () => {
    try {
      const summary = await syncStripe({ fullResync: true });
      stripeFullResyncState = {
        status: "done",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary,
        error: null,
      };
      logger.info(
        { payouts: summary.payouts, staged: summary.staged },
        "Stripe full re-pull (background) complete",
      );
    } catch (e) {
      stripeFullResyncState = {
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: null,
        error: e instanceof Error ? e.message : "Stripe full re-pull failed",
      };
      logger.error({ err: e }, "Stripe full re-pull (background) failed");
    }
  })();

  return stripeFullResyncState;
}

// ── Sync worker ───────────────────────────────────────────────────────────

/**
 * Ongoing Stripe → CRM payout sync. Pulls payouts created at/after the per-
 * account watermark, lists each payout's balance transactions (charges +
 * refunds + fees), stages one review-queue row per charge (idempotent by charge
 * id, preserving review state), and records payout-level rollups. Advisory-
 * locked per Stripe account under the "stripe" source tag.
 *
 * First-ever run seeds the watermark to "now" and stages nothing — the
 * historical back-catalogue (already booked in QuickBooks as net lumps) is
 * intentionally not reprocessed (ongoing-only first cut).
 *
 * `fullResync` lifts the created-watermark floor and the upsert status guard so
 * an admin can backfill Stripe facts onto already-resolved rows non-
 * destructively.
 */
export async function syncStripe(
  opts: { fullResync?: boolean } = {},
): Promise<StripeSyncSummary> {
  const fullResync = opts.fullResync === true;

  let client: { stripe: Stripe; accountId: string | null };
  try {
    client = await getUncachableStripeClient();
  } catch (e) {
    logger.debug({ err: e }, "Stripe sync: connector unavailable, skipping");
    return { ran: false, payouts: 0, staged: 0, matched: 0, autoApplied: 0, refundProposals: 0 };
  }
  const { stripe, accountId } = client;
  if (!accountId) {
    logger.warn("Stripe sync: no account id from connector, skipping");
    return { ran: false, payouts: 0, staged: 0, matched: 0, autoApplied: 0, refundProposals: 0 };
  }

  const outcome = await withSyncLock(accountId, "stripe", async () => {
    // Load or seed the per-account cursor.
    const state = await db
      .select()
      .from(stripeSyncState)
      .where(eq(stripeSyncState.stripeAccountId, accountId))
      .then((r) => r[0]);

    if (!state) {
      // First-ever run for this account: seed the cursor.
      await db
        .insert(stripeSyncState)
        .values({
          stripeAccountId: accountId,
          payoutCreatedWatermark: new Date(),
          lastRunAt: new Date(),
          lastRunStatus: "ok",
          consecutiveErrors: 0,
        })
        .onConflictDoNothing();
      // The ongoing (incremental) path stops here and stages nothing — the
      // historical back-catalogue is intentionally not reprocessed on first cut.
      // A fullResync, however, exists PRECISELY to backfill that history, so it
      // must NOT short-circuit: it falls through to walk every payout below
      // (watermark lifted). The cursor just inserted is overwritten at the end of
      // the walk with the newest payout seen, so subsequent incremental syncs
      // continue correctly from there.
      if (!fullResync) {
        logger.info(
          { accountId },
          "Stripe sync: seeded watermark to now (ongoing-only); first run stages nothing",
        );
        return { payouts: 0, staged: 0, matched: 0, autoApplied: 0, refundProposals: 0 };
      }
      logger.info(
        { accountId },
        "Stripe full re-pull: no prior cursor; seeded one and walking the full payout history",
      );
    }

    const watermark = fullResync ? null : (state?.payoutCreatedWatermark ?? null);
    let maxCreated: number | null = state?.payoutCreatedWatermark
      ? Math.floor(state.payoutCreatedWatermark.getTime() / 1000)
      : null;

    let payoutsSeen = 0;
    let staged = 0;
    let matched = 0;
    let autoApplied = 0;
    let refundProposals = 0;
    const seenPayoutIds: string[] = [];

    try {
      const params: Stripe.PayoutListParams = { limit: 100 };
      if (watermark) {
        // gte (not gt) + idempotent upsert tolerates the boundary payout being
        // re-pulled rather than risk skipping one created in the watermark sec.
        params.created = { gte: Math.floor(watermark.getTime() / 1000) };
      }

      for await (const payout of stripe.payouts.list(params)) {
        payoutsSeen += 1;
        seenPayoutIds.push(payout.id);
        if (
          payout.created &&
          (maxCreated === null || payout.created > maxCreated)
        ) {
          maxCreated = payout.created;
        }

        const r = await stagePayoutAndCharges(stripe, accountId, payout, {
          enrichAllStatuses: fullResync,
        });
        staged += r.staged;
        matched += r.matched;
        autoApplied += r.autoApplied;
        refundProposals += r.refundProposals;
      }

      const newWatermark =
        maxCreated !== null ? new Date(maxCreated * 1000) : (watermark ?? new Date());
      await db
        .update(stripeSyncState)
        .set({
          payoutCreatedWatermark: newWatermark,
          lastRunAt: new Date(),
          lastRunStatus: "ok",
          lastError: null,
          consecutiveErrors: 0,
          updatedAt: new Date(),
        })
        .where(eq(stripeSyncState.stripeAccountId, accountId));

      // Generate/refresh settlement-bundle drafts for the payouts we touched
      // (best-effort: never throws, never clobbers human overrides).
      await ensureBundleDraftsForAnchors(
        seenPayoutIds.map((id) => ({
          anchorType: "stripe_payout" as const,
          anchorId: id,
        })),
      );

      return { payouts: payoutsSeen, staged, matched, autoApplied, refundProposals };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .update(stripeSyncState)
        .set({
          lastRunAt: new Date(),
          lastRunStatus: "error",
          lastError: msg,
          consecutiveErrors: sql`${stripeSyncState.consecutiveErrors} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(stripeSyncState.stripeAccountId, accountId));
      throw e;
    }
  });

  if (!outcome.ran) {
    return {
      ran: false,
      payouts: 0,
      staged: 0,
      matched: 0,
      autoApplied: 0,
      refundProposals: 0,
    };
  }
  return { ran: true, ...outcome.result! };
}

export interface StripeBackfillSummary {
  ran: boolean;
  payouts: number;
  staged: number;
  matched: number;
  autoApplied: number;
  proposed: number;
  conflicts: number;
  cleared: number;
}

/**
 * Historical backfill. Pulls payouts CREATED within [from, to] (open-ended end
 * when `to` is omitted), stages their charges + payout rollups with
 * `enrichAllStatuses` (refresh read-only Stripe facts on already-staged rows
 * without disturbing review state), then runs the payout↔QB-deposit proposal
 * pass over exactly the payouts it touched.
 *
 * UNLIKE syncStripe this NEVER moves the ongoing watermark and never seeds sync
 * state: it is a bounded, repeatable admin pull of the back-catalogue that the
 * first-run watermark intentionally skipped, leaving the ongoing cursor exactly
 * where it is. Advisory-locked per account under the "stripe" tag so it
 * serializes with the ongoing sync (no nested lock around the proposal pass).
 */
export async function syncStripeBackfill(opts: {
  from: Date;
  to?: Date;
}): Promise<StripeBackfillSummary> {
  const empty: StripeBackfillSummary = {
    ran: false,
    payouts: 0,
    staged: 0,
    matched: 0,
    autoApplied: 0,
    proposed: 0,
    conflicts: 0,
    cleared: 0,
  };

  let client: { stripe: Stripe; accountId: string | null };
  try {
    client = await getUncachableStripeClient();
  } catch (e) {
    logger.debug({ err: e }, "Stripe backfill: connector unavailable, skipping");
    return empty;
  }
  const { stripe, accountId } = client;
  if (!accountId) {
    logger.warn("Stripe backfill: no account id from connector, skipping");
    return empty;
  }

  const fromSec = Math.floor(opts.from.getTime() / 1000);
  const toSec = opts.to ? Math.floor(opts.to.getTime() / 1000) : null;

  const outcome = await withSyncLock(accountId, "stripe", async () => {
    let payoutsSeen = 0;
    let staged = 0;
    let matched = 0;
    let autoApplied = 0;
    const seenIds: string[] = [];

    const params: Stripe.PayoutListParams = {
      limit: 100,
      created: toSec != null ? { gte: fromSec, lte: toSec } : { gte: fromSec },
    };
    for await (const payout of stripe.payouts.list(params)) {
      payoutsSeen += 1;
      seenIds.push(payout.id);
      const r = await stagePayoutAndCharges(stripe, accountId, payout, {
        enrichAllStatuses: true,
      });
      staged += r.staged;
      matched += r.matched;
      autoApplied += r.autoApplied;
    }

    const prop = seenIds.length
      ? await runProposalPass(seenIds)
      : { evaluated: 0, proposed: 0, conflicts: 0, cleared: 0 };

    logger.info(
      {
        accountId,
        payouts: payoutsSeen,
        staged,
        proposed: prop.proposed,
        conflicts: prop.conflicts,
      },
      "Stripe backfill complete",
    );

    return {
      payouts: payoutsSeen,
      staged,
      matched,
      autoApplied,
      proposed: prop.proposed,
      conflicts: prop.conflicts,
      cleared: prop.cleared,
    };
  });

  if (!outcome.ran) return empty;
  return { ran: true, ...outcome.result! };
}

export interface StripeRematchSummary {
  ran: boolean;
  scanned: number;
  matched: number;
}

const STRIPE_REMATCH_CONCURRENCY = 8;

/**
 * On-demand donor backfill: re-score still-`pending` + `unmatched` + donor-less
 * Stripe charges with the latest matching logic and record any donor hint found.
 * DONOR-ONLY by design — never mints or reconciles a gift (that auto-apply only
 * happens on fresh ingestion), so the manual "rematch" button can never bulk-
 * write the ledger by surprise. Each write is a guarded conditional UPDATE
 * (still pending + unmatched + donor-less) so a concurrent human resolve is
 * never clobbered. Advisory-locked under the same per-account "stripe" key so it
 * serializes against the sync worker.
 */
export async function rematchStripeCharges(): Promise<StripeRematchSummary> {
  let client: { stripe: Stripe; accountId: string | null };
  try {
    client = await getUncachableStripeClient();
  } catch (e) {
    logger.debug({ err: e }, "Stripe rematch: connector unavailable, skipping");
    return { ran: false, scanned: 0, matched: 0 };
  }
  const { accountId } = client;
  if (!accountId) return { ran: false, scanned: 0, matched: 0 };

  const outcome = await withSyncLock(accountId, "stripe", async () => {
    const candidates = await db
      .select({
        id: stripeStagedCharges.id,
        payerName: stripeStagedCharges.payerName,
        payerEmail: stripeStagedCharges.payerEmail,
        description: stripeStagedCharges.description,
        statementDescriptor: stripeStagedCharges.statementDescriptor,
        grossAmount: stripeStagedCharges.grossAmount,
        dateReceived: stripeStagedCharges.dateReceived,
      })
      .from(stripeStagedCharges)
      .where(
        and(
          eq(stripeStagedCharges.status, "pending"),
          eq(stripeStagedCharges.matchStatus, "unmatched"),
          isNull(stripeStagedCharges.organizationId),
          isNull(stripeStagedCharges.individualGiverPersonId),
          isNull(stripeStagedCharges.householdId),
        ),
      );

    let matched = 0;
    for (let i = 0; i < candidates.length; i += STRIPE_REMATCH_CONCURRENCY) {
      const chunk = candidates.slice(i, i + STRIPE_REMATCH_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (row) => {
          const scored = await scoreStripeCharge({
            payerName: row.payerName,
            payerEmail: row.payerEmail,
            description: row.description,
            statementDescriptor: row.statementDescriptor,
            grossAmount: row.grossAmount,
            dateReceived: row.dateReceived,
          });
          if (scored.tier === "none" || !scored.method) return false;
          const newMatchStatus =
            scored.tier === "high" ? "matched" : "suggested";
          const upd = await db
            .update(stripeStagedCharges)
            .set({
              matchStatus: newMatchStatus,
              matchScore: scored.score,
              matchMethod: scored.method,
              organizationId: scored.donor.organizationId,
              individualGiverPersonId: scored.donor.individualGiverPersonId,
              householdId: scored.donor.householdId,
              matchedPaymentIntermediaryId: scored.intermediaryId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(stripeStagedCharges.id, row.id),
                eq(stripeStagedCharges.status, "pending"),
                eq(stripeStagedCharges.matchStatus, "unmatched"),
                isNull(stripeStagedCharges.organizationId),
                isNull(stripeStagedCharges.individualGiverPersonId),
                isNull(stripeStagedCharges.householdId),
              ),
            )
            .returning({ id: stripeStagedCharges.id });
          return upd.length > 0;
        }),
      );
      matched += results.filter(Boolean).length;
    }

    return { scanned: candidates.length, matched };
  });

  if (!outcome.ran) return { ran: false, scanned: 0, matched: 0 };
  return { ran: true, ...outcome.result! };
}
