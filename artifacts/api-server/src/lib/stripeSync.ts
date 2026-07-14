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
import { chargeStatusIn, chargeStatusWhere } from "./derivedStatus";
import { getUncachableStripeClient } from "./stripeClient";
import { scoreStripeCharge } from "./stripeMatch";
import { runProposalPass } from "./stripeReconcile";
import { deriveRefundProposal, isFullyRefunded } from "./stripeRefund";
import { sweepRefundedQbStagedPayments } from "./refundedChargeSweep";
import { ensureBundleDraftsForAnchors } from "./reconciliationBundleSync";
import { getStripeChargeGiftRelationship } from "./stripeChargeLedger";
import { proposeStripeAutoApplyInTx } from "./stripeAutoApply";
import { removePaymentApplicationsForStripeCharge } from "./paymentApplications";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
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

export function extractChargeFacts(charge: Stripe.Charge): ChargeFacts {
  const billing = charge.billing_details;
  const card =
    charge.payment_method_details && "card" in charge.payment_method_details
      ? charge.payment_method_details.card
      : null;
  const metadata =
    charge.metadata && Object.keys(charge.metadata).length > 0
      ? charge.metadata
      : null;

  return {
    payerName: billing?.name ?? null,
    payerEmail: billing?.email ?? charge.receipt_email ?? null,
    description: charge.description ?? null,
    statementDescriptor:
      charge.statement_descriptor ??
      charge.calculated_statement_descriptor ??
      null,
    cardBrand: card?.brand ?? null,
    metadata,
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

export function rollupPayout(
  balanceTransactions: Stripe.BalanceTransaction[],
): PayoutRollup {
  let grossMinor = 0;
  let feeMinor = 0;
  let refundMinor = 0;
  let chargeCount = 0;

  for (const transaction of balanceTransactions) {
    feeMinor += transaction.fee ?? 0;
    if (transaction.type === "charge" || transaction.type === "payment") {
      grossMinor += transaction.amount;
      chargeCount += 1;
    } else if (
      transaction.type === "refund" ||
      transaction.type === "payment_refund"
    ) {
      refundMinor += Math.abs(transaction.amount);
    }
  }

  return {
    grossTotal: (grossMinor / 100).toFixed(2),
    feeTotal: (feeMinor / 100).toFixed(2),
    refundTotal: (refundMinor / 100).toFixed(2),
    netTotal: ((grossMinor - feeMinor - refundMinor) / 100).toFixed(2),
    chargeCount,
  };
}

function chargeFromSource(
  source: Stripe.BalanceTransaction["source"],
): Stripe.Charge | null {
  if (source && typeof source !== "string" && source.object === "charge") {
    return source;
  }
  return null;
}

function refundOrDisputeChargeId(
  transaction: Stripe.BalanceTransaction,
): string | null {
  const source = transaction.source;
  if (!source || typeof source === "string") return null;
  if (source.object === "refund" || source.object === "dispute") {
    const charge = (source as Stripe.Refund | Stripe.Dispute).charge;
    return typeof charge === "string" ? charge : (charge?.id ?? null);
  }
  return null;
}

/**
 * Refresh refund facts and raise proposals only for gifts owned by a confirmed,
 * counted Stripe payment application. Legacy charge gift pointers are ignored.
 */
async function propagateRefundsForPayout(
  stripe: Stripe,
  balanceTransactions: Stripe.BalanceTransaction[],
): Promise<number> {
  const chargeIds = new Set<string>();
  for (const transaction of balanceTransactions) {
    const chargeId = refundOrDisputeChargeId(transaction);
    if (chargeId) chargeIds.add(chargeId);
  }
  if (chargeIds.size === 0) return 0;

  let proposed = 0;
  for (const chargeId of chargeIds) {
    const row = await db
      .select({
        id: stripeStagedCharges.id,
        refundPropagationStatus: stripeStagedCharges.refundPropagationStatus,
        refundPropagationKind: stripeStagedCharges.refundPropagationKind,
        refundProposedAmount: stripeStagedCharges.refundProposedAmount,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, chargeId))
      .then((rows) => rows[0]);
    if (!row) continue;

    let charge: Stripe.Charge;
    try {
      charge = await stripe.charges.retrieve(chargeId);
    } catch (error) {
      logger.warn(
        { err: error, chargeId },
        "Stripe refund sync: charge retrieve failed; skipping",
      );
      continue;
    }

    const facts = extractChargeFacts(charge);
    const relationship = await getStripeChargeGiftRelationship(db, chargeId);
    const giftId = relationship?.giftId ?? null;
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

    // A fully refunded charge that never reached a confirmed gift is not money.
    // Remove any system proposal and classify it terminally instead of leaving a
    // proposed application stranded in the queue.
    if (giftId == null && isFullyRefunded(facts)) {
      await db.transaction(async (tx) => {
        await removePaymentApplicationsForStripeCharge(tx, chargeId);
        await tx
          .update(stripeStagedCharges)
          .set({
            exclusionReason: "refunded_charge",
            autoApplied: false,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stripeStagedCharges.id, chargeId),
              chargeStatusWhere.pending,
              eq(stripeStagedCharges.classificationSource, "auto"),
            ),
          );
      });
    }

    if (proposal) proposed += 1;
  }
  return proposed;
}

/** Preserve review state while refreshing read-only Stripe facts. */
export function buildStagedChargeUpsert(
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
    refunded: sql`excluded.refunded`,
    disputed: sql`excluded.disputed`,
    rawCharge: sql`coalesce(excluded.raw_charge, ${stripeStagedCharges.rawCharge})`,
    exclusionReason: sql`CASE
      WHEN ${chargeStatusWhere.pending}
        AND ${stripeStagedCharges.classificationSource} = 'auto'
        AND excluded.raw_charge->>'status' = 'failed'
        THEN 'failed_charge'::staged_payment_exclusion_reason
      WHEN ${chargeStatusWhere.pending}
        AND ${stripeStagedCharges.classificationSource} = 'auto'
        AND excluded.refunded = true
        AND excluded.disputed IS NOT TRUE
        AND excluded.gross_amount IS NOT NULL
        AND excluded.gross_amount > 0
        AND coalesce(excluded.amount_refunded, excluded.gross_amount) >= excluded.gross_amount - 0.005
        THEN 'refunded_charge'::staged_payment_exclusion_reason
      ELSE ${stripeStagedCharges.exclusionReason}
    END`,
    updatedAt: new Date(),
  };

  return db
    .insert(stripeStagedCharges)
    .values(values)
    .onConflictDoUpdate({
      target: stripeStagedCharges.id,
      set,
      ...(opts.enrichAllStatuses
        ? {}
        : { setWhere: chargeStatusIn(["pending", "excluded"]) }),
    });
}

/** Write a high-confidence system match as a proposed ledger application. */
async function stripeAutoApply(
  chargeId: string,
  giftId: string,
): Promise<boolean> {
  try {
    return await db.transaction((tx) =>
      proposeStripeAutoApplyInTx(tx, { chargeId, giftId }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

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

  const balanceTransactions: Stripe.BalanceTransaction[] = [];
  for await (const transaction of stripe.balanceTransactions.list({
    payout: payout.id,
    limit: 100,
    expand: ["data.source"],
  })) {
    balanceTransactions.push(transaction);
  }
  const rollup = rollupPayout(balanceTransactions);

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

  for (const transaction of balanceTransactions) {
    if (transaction.type !== "charge" && transaction.type !== "payment") continue;
    const charge = chargeFromSource(transaction.source);
    if (!charge) continue;

    const facts = extractChargeFacts(charge);
    const chargeFailed = charge.status === "failed";
    const chargeFullyRefunded = !chargeFailed && isFullyRefunded(facts);
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
        stripeBalanceTransactionId: transaction.id,
        stripePaymentIntentId: facts.stripePaymentIntentId,
        stripeCustomerId: facts.stripeCustomerId,
        grossAmount: facts.grossAmount,
        feeAmount: minorToAmount(transaction.fee),
        netAmount: minorToAmount(transaction.net),
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
        exclusionReason: chargeFailed
          ? "failed_charge"
          : chargeFullyRefunded
            ? "refunded_charge"
            : null,
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

    if (
      !chargeFailed &&
      !chargeFullyRefunded &&
      scored.tier === "high" &&
      scored.matchedGiftId
    ) {
      const didApply = await stripeAutoApply(charge.id, scored.matchedGiftId);
      if (didApply) autoApplied += 1;
    }
  }

  const refundProposals = await propagateRefundsForPayout(
    stripe,
    balanceTransactions,
  );
  return { staged, matched, autoApplied, refundProposals };
}

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
    } catch (error) {
      stripeFullResyncState = {
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: null,
        error:
          error instanceof Error ? error.message : "Stripe full re-pull failed",
      };
      logger.error({ err: error }, "Stripe full re-pull (background) failed");
    }
  })();

  return stripeFullResyncState;
}

export async function syncStripe(
  opts: { fullResync?: boolean } = {},
): Promise<StripeSyncSummary> {
  const fullResync = opts.fullResync === true;
  let client: { stripe: Stripe; accountId: string | null };

  try {
    client = await getUncachableStripeClient();
  } catch (error) {
    logger.debug({ err: error }, "Stripe sync: connector unavailable, skipping");
    return {
      ran: false,
      payouts: 0,
      staged: 0,
      matched: 0,
      autoApplied: 0,
      refundProposals: 0,
    };
  }

  const { stripe, accountId } = client;
  if (!accountId) {
    logger.warn("Stripe sync: no account id from connector, skipping");
    return {
      ran: false,
      payouts: 0,
      staged: 0,
      matched: 0,
      autoApplied: 0,
      refundProposals: 0,
    };
  }

  const outcome = await withSyncLock(accountId, "stripe", async () => {
    const state = await db
      .select()
      .from(stripeSyncState)
      .where(eq(stripeSyncState.stripeAccountId, accountId))
      .then((rows) => rows[0]);

    if (!state) {
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
      if (!fullResync) {
        logger.info(
          { accountId },
          "Stripe sync: seeded watermark to now; first run stages nothing",
        );
        return {
          payouts: 0,
          staged: 0,
          matched: 0,
          autoApplied: 0,
          refundProposals: 0,
        };
      }
    }

    const watermark = fullResync
      ? null
      : (state?.payoutCreatedWatermark ?? null);
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
        const result = await stagePayoutAndCharges(stripe, accountId, payout, {
          enrichAllStatuses: fullResync,
        });
        staged += result.staged;
        matched += result.matched;
        autoApplied += result.autoApplied;
        refundProposals += result.refundProposals;
      }

      const newWatermark =
        maxCreated !== null
          ? new Date(maxCreated * 1000)
          : (watermark ?? new Date());
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

      await ensureBundleDraftsForAnchors(
        seenPayoutIds.map((id) => ({
          anchorType: "stripe_payout" as const,
          anchorId: id,
        })),
      );
      await sweepRefundedQbStagedPayments();
      return { payouts: payoutsSeen, staged, matched, autoApplied, refundProposals };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(stripeSyncState)
        .set({
          lastRunAt: new Date(),
          lastRunStatus: "error",
          lastError: message,
          consecutiveErrors: sql`${stripeSyncState.consecutiveErrors} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(stripeSyncState.stripeAccountId, accountId));
      throw error;
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
  } catch (error) {
    logger.debug(
      { err: error },
      "Stripe backfill: connector unavailable, skipping",
    );
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
      const result = await stagePayoutAndCharges(stripe, accountId, payout, {
        enrichAllStatuses: true,
      });
      staged += result.staged;
      matched += result.matched;
      autoApplied += result.autoApplied;
    }

    const proposal = seenIds.length
      ? await runProposalPass(seenIds)
      : { evaluated: 0, proposed: 0, conflicts: 0, cleared: 0 };
    await sweepRefundedQbStagedPayments();

    logger.info(
      {
        accountId,
        payouts: payoutsSeen,
        staged,
        proposed: proposal.proposed,
        conflicts: proposal.conflicts,
      },
      "Stripe backfill complete",
    );

    return {
      payouts: payoutsSeen,
      staged,
      matched,
      autoApplied,
      proposed: proposal.proposed,
      conflicts: proposal.conflicts,
      cleared: proposal.cleared,
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

export async function rematchStripeCharges(): Promise<StripeRematchSummary> {
  let client: { stripe: Stripe; accountId: string | null };
  try {
    client = await getUncachableStripeClient();
  } catch (error) {
    logger.debug(
      { err: error },
      "Stripe rematch: connector unavailable, skipping",
    );
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
          chargeStatusWhere.pending,
          eq(stripeStagedCharges.matchStatus, "unmatched"),
          isNull(stripeStagedCharges.organizationId),
          isNull(stripeStagedCharges.individualGiverPersonId),
          isNull(stripeStagedCharges.householdId),
        ),
      );

    let matched = 0;
    for (let index = 0; index < candidates.length; index += STRIPE_REMATCH_CONCURRENCY) {
      const chunk = candidates.slice(index, index + STRIPE_REMATCH_CONCURRENCY);
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
          const updated = await db
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
                chargeStatusWhere.pending,
                eq(stripeStagedCharges.matchStatus, "unmatched"),
                isNull(stripeStagedCharges.organizationId),
                isNull(stripeStagedCharges.individualGiverPersonId),
                isNull(stripeStagedCharges.householdId),
              ),
            )
            .returning({ id: stripeStagedCharges.id });
          return updated.length > 0;
        }),
      );
      matched += results.filter(Boolean).length;
    }

    return { scanned: candidates.length, matched };
  });

  if (!outcome.ran) return { ran: false, scanned: 0, matched: 0 };
  return { ran: true, ...outcome.result! };
}
