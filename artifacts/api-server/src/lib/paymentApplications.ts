// `db` is used only to derive the transaction type. Every function takes the
// caller's transaction; this module never touches the db singleton at runtime.
import type { db } from "@workspace/db";
import {
  paymentApplications,
  stagedPayments,
  stripeStagedCharges,
  donorboxDonations,
} from "@workspace/db/schema";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { newId } from "./helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PaymentApplicationEvidenceSource =
  | "quickbooks"
  | "stripe"
  | "donorbox";
export type PaymentApplicationMatchMethod =
  | "system"
  | "system_confirmed"
  | "human";
export type PaymentApplicationLinkRole = "counted" | "corroborating";
export type PaymentApplicationLifecycle = "proposed" | "confirmed" | "exempt";

/** Only confirmed, counted rows enter settled totals and book-once math. */
export function applicationCountsTowardMoney(args: {
  linkRole: PaymentApplicationLinkRole;
  lifecycle: PaymentApplicationLifecycle;
}): boolean {
  return args.linkRole === "counted" && args.lifecycle === "confirmed";
}

const BOOK_ONCE_EPSILON = 0.005;

export interface BookOnceCheckArgs {
  paymentAmount: string | null;
  otherAppliedSum: string | number | null;
  newAmount: string | number | null;
  tolerance?: number;
}

export interface BookOnceResult {
  ok: boolean;
  total: number;
  cap: number | null;
  overage: number;
}

const toNum = (value: string | number | null | undefined): number => {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export function checkBookOnce(args: BookOnceCheckArgs): BookOnceResult {
  const tolerance = args.tolerance ?? BOOK_ONCE_EPSILON;
  const total = toNum(args.otherAppliedSum) + toNum(args.newAmount);
  if (args.paymentAmount == null || args.paymentAmount === "") {
    return { ok: true, total, cap: null, overage: 0 };
  }
  const base = Number(args.paymentAmount);
  if (Number.isNaN(base)) return { ok: true, total, cap: null, overage: 0 };
  const cap = base + tolerance;
  const overage = total - cap;
  return { ok: overage <= 0, total, cap, overage: overage > 0 ? overage : 0 };
}

export class PaymentOverApplicationError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly result: BookOnceResult,
  ) {
    super(
      `payment ${paymentId} over-applied: total ${result.total.toFixed(
        2,
      )} exceeds cap ${result.cap?.toFixed(2) ?? "unknown"}`,
    );
    this.name = "PaymentOverApplicationError";
  }
}

export interface ApplyPaymentApplicationArgs {
  paymentId?: string | null;
  giftId: string;
  giftAllocationId?: string | null;
  amountApplied: string;
  evidenceSource: PaymentApplicationEvidenceSource;
  stripeChargeId?: string | null;
  donorboxDonationId?: string | null;
  matchMethod?: PaymentApplicationMatchMethod;
  linkRole?: PaymentApplicationLinkRole;
  lifecycle?: PaymentApplicationLifecycle;
  confirmedByUserId?: string | null;
  confirmedAt?: Date | null;
  note?: string | null;
  createdTheGift?: boolean;
  tolerance?: number;
}

type SQLColumn =
  | typeof paymentApplications.paymentId
  | typeof paymentApplications.stripeChargeId
  | typeof paymentApplications.donorboxDonationId;

interface ResolvedAnchor {
  kind: PaymentApplicationEvidenceSource;
  id: string;
  cap: string | null;
  ledgerColumn: SQLColumn;
  conflictTarget: [SQLColumn, typeof paymentApplications.giftId];
}

async function resolveAndLockAnchor(
  tx: Tx,
  args: ApplyPaymentApplicationArgs,
): Promise<ResolvedAnchor> {
  switch (args.evidenceSource) {
    case "quickbooks": {
      if (!args.paymentId) {
        throw new Error(
          "applyPaymentApplication: quickbooks evidence requires paymentId",
        );
      }
      const row = await tx
        .select({ amount: stagedPayments.amount })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, args.paymentId))
        .for("update")
        .then((rows) => rows[0]);
      if (!row) {
        throw new Error(
          `applyPaymentApplication: staged payment ${args.paymentId} not found`,
        );
      }
      return {
        kind: "quickbooks",
        id: args.paymentId,
        cap: row.amount,
        ledgerColumn: paymentApplications.paymentId,
        conflictTarget: [
          paymentApplications.paymentId,
          paymentApplications.giftId,
        ],
      };
    }
    case "stripe": {
      if (!args.stripeChargeId) {
        throw new Error(
          "applyPaymentApplication: stripe evidence requires stripeChargeId",
        );
      }
      const row = await tx
        .select({ amount: stripeStagedCharges.grossAmount })
        .from(stripeStagedCharges)
        .where(eq(stripeStagedCharges.id, args.stripeChargeId))
        .for("update")
        .then((rows) => rows[0]);
      if (!row) {
        throw new Error(
          `applyPaymentApplication: stripe charge ${args.stripeChargeId} not found`,
        );
      }
      return {
        kind: "stripe",
        id: args.stripeChargeId,
        cap: row.amount,
        ledgerColumn: paymentApplications.stripeChargeId,
        conflictTarget: [
          paymentApplications.stripeChargeId,
          paymentApplications.giftId,
        ],
      };
    }
    case "donorbox": {
      if (!args.donorboxDonationId) {
        throw new Error(
          "applyPaymentApplication: donorbox evidence requires donorboxDonationId",
        );
      }
      const row = await tx
        .select({ amount: donorboxDonations.amount })
        .from(donorboxDonations)
        .where(eq(donorboxDonations.id, args.donorboxDonationId))
        .for("update")
        .then((rows) => rows[0]);
      if (!row) {
        throw new Error(
          `applyPaymentApplication: donorbox donation ${args.donorboxDonationId} not found`,
        );
      }
      return {
        kind: "donorbox",
        id: args.donorboxDonationId,
        cap: row.amount,
        ledgerColumn: paymentApplications.donorboxDonationId,
        conflictTarget: [
          paymentApplications.donorboxDonationId,
          paymentApplications.giftId,
        ],
      };
    }
  }
}

function conflictTargetWhere(
  anchor: ResolvedAnchor,
  linkRole: PaymentApplicationLinkRole,
): SQL {
  if (linkRole === "corroborating" && anchor.kind === "donorbox") {
    throw new Error(
      "applyPaymentApplication: donorbox corroborating applications are not supported by the current schema",
    );
  }

  if (anchor.kind === "quickbooks") {
    return linkRole === "counted"
      ? sql`${paymentApplications.linkRole} = 'counted'`
      : sql`${paymentApplications.paymentId} IS NOT NULL AND ${paymentApplications.linkRole} = 'corroborating'`;
  }
  if (anchor.kind === "stripe") {
    return linkRole === "counted"
      ? sql`${paymentApplications.stripeChargeId} IS NOT NULL AND ${paymentApplications.linkRole} = 'counted'`
      : sql`${paymentApplications.stripeChargeId} IS NOT NULL AND ${paymentApplications.linkRole} = 'corroborating'`;
  }
  return sql`${paymentApplications.donorboxDonationId} IS NOT NULL AND ${paymentApplications.linkRole} = 'counted'`;
}

/**
 * Idempotently writes one unit↔gift application.
 * Proposed and exempt rows do not consume book-once capacity.
 */
export async function applyPaymentApplication(
  tx: Tx,
  args: ApplyPaymentApplicationArgs,
): Promise<void> {
  const anchor = await resolveAndLockAnchor(tx, args);
  const linkRole = args.linkRole ?? "counted";
  const lifecycle = args.lifecycle ?? "confirmed";

  if (applicationCountsTowardMoney({ linkRole, lifecycle })) {
    const sumRows = await tx
      .select({
        sum: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)`,
      })
      .from(paymentApplications)
      .where(
        and(
          eq(anchor.ledgerColumn, anchor.id),
          ne(paymentApplications.giftId, args.giftId),
          eq(paymentApplications.linkRole, "counted"),
          eq(paymentApplications.lifecycle, "confirmed"),
        ),
      );
    const result = checkBookOnce({
      paymentAmount: anchor.cap,
      otherAppliedSum: sumRows[0]?.sum ?? "0",
      newAmount: args.amountApplied,
      tolerance: args.tolerance,
    });
    if (!result.ok) throw new PaymentOverApplicationError(anchor.id, result);
  }

  const lifecycleConfirmed = lifecycle === "confirmed";
  const values = {
    paymentId: args.paymentId ?? null,
    giftId: args.giftId,
    giftAllocationId: args.giftAllocationId ?? null,
    amountApplied: args.amountApplied,
    evidenceSource: args.evidenceSource,
    stripeChargeId: args.stripeChargeId ?? null,
    donorboxDonationId: args.donorboxDonationId ?? null,
    matchMethod: args.matchMethod ?? ("system" as const),
    linkRole,
    lifecycle,
    confirmedByUserId: lifecycleConfirmed
      ? (args.confirmedByUserId ?? null)
      : null,
    confirmedAt: lifecycleConfirmed ? (args.confirmedAt ?? null) : null,
    note: args.note ?? null,
    createdTheGift: args.createdTheGift ?? false,
    updatedAt: new Date(),
  };

  await tx
    .insert(paymentApplications)
    .values({ id: newId(), ...values })
    .onConflictDoUpdate({
      target: anchor.conflictTarget,
      targetWhere: conflictTargetWhere(anchor, linkRole),
      set: values,
    });
}

export async function removePaymentApplicationsForGift(
  tx: Tx,
  giftId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.giftId, giftId))
    .returning({ paymentId: paymentApplications.paymentId });
  return removed
    .map((row) => row.paymentId)
    .filter((paymentId): paymentId is string => paymentId !== null);
}

export async function removePaymentApplicationsForPayment(
  tx: Tx,
  paymentId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.paymentId, paymentId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((row) => row.giftId);
}

export async function removePaymentApplicationsForStripeCharge(
  tx: Tx,
  stripeChargeId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.stripeChargeId, stripeChargeId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((row) => row.giftId);
}

export async function removePaymentApplicationsForDonorboxDonation(
  tx: Tx,
  donorboxDonationId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.donorboxDonationId, donorboxDonationId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((row) => row.giftId);
}

export async function bookStripeChargeApplication(
  tx: Tx,
  args: {
    stripeChargeId: string;
    grossAmount: string | null;
    giftId: string;
    matchMethod: PaymentApplicationMatchMethod;
    lifecycle?: PaymentApplicationLifecycle;
    confirmedByUserId?: string | null;
    confirmedAt?: Date | null;
    createdTheGift: boolean;
  },
): Promise<void> {
  await removePaymentApplicationsForStripeCharge(tx, args.stripeChargeId);
  if (!args.grossAmount || Number(args.grossAmount) <= 0) return;
  await applyPaymentApplication(tx, {
    evidenceSource: "stripe",
    stripeChargeId: args.stripeChargeId,
    giftId: args.giftId,
    amountApplied: args.grossAmount,
    matchMethod: args.matchMethod,
    lifecycle: args.lifecycle ?? "confirmed",
    confirmedByUserId: args.confirmedByUserId ?? null,
    confirmedAt: args.confirmedAt ?? null,
    createdTheGift: args.createdTheGift,
  });
}

/** Replace any prior system proposal, but never displace a confirmed charge tie. */
export async function proposeStripeChargeApplication(
  tx: Tx,
  args: {
    stripeChargeId: string;
    grossAmount: string | null;
    giftId: string;
  },
): Promise<void> {
  await tx
    .select({ id: stripeStagedCharges.id })
    .from(stripeStagedCharges)
    .where(eq(stripeStagedCharges.id, args.stripeChargeId))
    .for("update");

  const existingConfirmed = await tx
    .select({ giftId: paymentApplications.giftId })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.stripeChargeId, args.stripeChargeId),
        eq(paymentApplications.linkRole, "counted"),
        eq(paymentApplications.lifecycle, "confirmed"),
      ),
    )
    .limit(1);
  if (existingConfirmed.length > 0) {
    throw new Error(
      `proposeStripeChargeApplication: charge ${args.stripeChargeId} is already confirmed to gift ${existingConfirmed[0].giftId}`,
    );
  }

  await tx
    .delete(paymentApplications)
    .where(
      and(
        eq(paymentApplications.stripeChargeId, args.stripeChargeId),
        eq(paymentApplications.lifecycle, "proposed"),
        eq(paymentApplications.matchMethod, "system"),
      ),
    );

  if (!args.grossAmount || Number(args.grossAmount) <= 0) return;
  await applyPaymentApplication(tx, {
    evidenceSource: "stripe",
    stripeChargeId: args.stripeChargeId,
    giftId: args.giftId,
    amountApplied: args.grossAmount,
    matchMethod: "system",
    lifecycle: "proposed",
    confirmedByUserId: null,
    confirmedAt: null,
    createdTheGift: false,
  });
}

export async function bookDonorboxDonationApplication(
  tx: Tx,
  args: {
    donorboxDonationId: string;
    amount: string | null;
    giftId: string;
    confirmedByUserId?: string | null;
    confirmedAt?: Date | null;
    createdTheGift: boolean;
  },
): Promise<void> {
  await removePaymentApplicationsForDonorboxDonation(
    tx,
    args.donorboxDonationId,
  );
  if (!args.amount || Number(args.amount) <= 0) return;
  await applyPaymentApplication(tx, {
    evidenceSource: "donorbox",
    donorboxDonationId: args.donorboxDonationId,
    giftId: args.giftId,
    amountApplied: args.amount,
    matchMethod: "human",
    lifecycle: "confirmed",
    confirmedByUserId: args.confirmedByUserId ?? null,
    confirmedAt: args.confirmedAt ?? null,
    createdTheGift: args.createdTheGift,
  });
}

/** Promote system proposals for one QuickBooks payment after a live capacity check. */
export async function confirmPaymentApplicationsForPayment(
  tx: Tx,
  paymentId: string,
  confirmedByUserId: string | null,
  confirmedAt: Date,
): Promise<string[]> {
  const staged = await tx
    .select({ amount: stagedPayments.amount })
    .from(stagedPayments)
    .where(eq(stagedPayments.id, paymentId))
    .for("update")
    .then((rows) => rows[0]);
  if (!staged) {
    throw new Error(
      `confirmPaymentApplicationsForPayment: staged payment ${paymentId} not found`,
    );
  }

  const [sums] = await tx
    .select({
      confirmed: sql<string>`coalesce(sum(${paymentApplications.amountApplied}) filter (where ${paymentApplications.linkRole} = 'counted' and ${paymentApplications.lifecycle} = 'confirmed'), 0)`,
      proposed: sql<string>`coalesce(sum(${paymentApplications.amountApplied}) filter (where ${paymentApplications.linkRole} = 'counted' and ${paymentApplications.lifecycle} = 'proposed' and ${paymentApplications.matchMethod} = 'system'), 0)`,
    })
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, paymentId));

  const result = checkBookOnce({
    paymentAmount: staged.amount,
    otherAppliedSum: sums?.confirmed ?? "0",
    newAmount: sums?.proposed ?? "0",
  });
  if (!result.ok) throw new PaymentOverApplicationError(paymentId, result);

  const updated = await tx
    .update(paymentApplications)
    .set({
      lifecycle: "confirmed",
      matchMethod: "system_confirmed",
      confirmedByUserId: confirmedByUserId ?? null,
      confirmedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentApplications.paymentId, paymentId),
        eq(paymentApplications.matchMethod, "system"),
      ),
    )
    .returning({ giftId: paymentApplications.giftId });
  return [...new Set(updated.map((row) => row.giftId))];
}

// ─── Ledger readers ──────────────────────────────────────────────────────────
// Every operational reader below counts only confirmed, counted applications.

export const DEFAULT_GIFT_ID_SQL: SQL = sql.raw('"gifts_and_payments"."id"');

export function qbLedgerExistsForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}

export function qbLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}

export function stripeLedgerExistsForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}

export function stripeLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}

export function donorboxLedgerExistsForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'donorbox'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}

export function donorboxLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'donorbox'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}

export function qbLedgerPaymentIdForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.payment_id FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
    LIMIT 1
  )`;
}

export function qbLedgerExistsForGiftExcludingPayment(
  giftIdSql: SQL,
  excludePaymentIdSql: SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
      AND pa.payment_id <> ${excludePaymentIdSql}
  )`;
}

export function qbLedgerPaymentIdForGiftExcludingPayment(
  giftIdSql: SQL,
  excludePaymentIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.payment_id FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
      AND pa.payment_id <> ${excludePaymentIdSql}
    LIMIT 1
  )`;
}

/** Ledger-authoritative owner lookup for exact charge routing. */
export function chargeIdOwningGiftExcludingCharge(
  giftIdSql: SQL,
  excludeChargeIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.stripe_charge_id FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
      AND pa.stripe_charge_id <> ${excludeChargeIdSql}
    LIMIT 1
  )`;
}

export const DEFAULT_PAYMENT_ID_SQL: SQL = sql.raw('"staged_payments"."id"');

export function qbLedgerGiftIdForPaymentExcludingGift(
  paymentIdSql: SQL,
  excludeGiftIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
      AND pa.gift_id <> ${excludeGiftIdSql}
    LIMIT 1
  )`;
}

export function qbLedgerExistsForPayment(
  paymentIdSql: SQL = DEFAULT_PAYMENT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )`;
}
