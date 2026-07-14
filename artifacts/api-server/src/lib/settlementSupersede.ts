import type { db } from "@workspace/db";
import {
  paymentApplications,
  settlementLinks,
  stripeStagedCharges,
} from "@workspace/db/schema";
import {
  and,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { amountWithinFeeBand } from "./reconciliationGate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

export interface SettlementSupersedeResult {
  demotedApplicationIds: string[];
  promotedApplicationIds: string[];
  deletedDuplicateApplicationIds: string[];
  affectedGiftIds: string[];
  evaluatedDepositPaymentIds: string[];
}

export class SettlementSupersedeCollisionError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly giftId: string,
    public readonly applicationIds: string[],
  ) {
    super(
      `settlement supersede collision for payment ${paymentId}, gift ${giftId}: ${applicationIds.join(", ")}`,
    );
    this.name = "SettlementSupersedeCollisionError";
  }
}

/**
 * The settlement boundary is gross-vs-net, so use the exact same fee band as
 * the reconciliation gate and gift-tie derivation. `qbAmount` is the deposit/net
 * evidence; `stripeGross` is the donor-paid gross represented by charge rows.
 */
export function stripeGrossCoversQbApplication(
  qbAmount: string | null,
  stripeGross: string | null,
): boolean {
  if (qbAmount == null || stripeGross == null) return false;
  return amountWithinFeeBand(qbAmount, stripeGross);
}

interface QbApplicationRow {
  id: string;
  paymentId: string;
  giftId: string;
  amountApplied: string | null;
  linkRole: "counted" | "corroborating";
  supersededBySettlementLinkId: string | null;
}

interface ConfirmedLinkRow {
  id: string;
  payoutId: string;
  depositPaymentId: string;
}

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => !!value))];

/**
 * Recompute settlement supersession for specific QBO deposit anchors.
 *
 * A confirmed settlement means all linked payouts and the QBO deposit represent
 * the same bank dollars. For each deposit+gift pair:
 *
 * - when confirmed counted Stripe applications from the linked payout(s) cover
 *   the QBO amount within the shared processor fee band, demote the coarse QBO
 *   application to corroborating;
 * - when that coverage disappears, promote only applications previously demoted
 *   by this mechanism back to counted;
 * - unrelated corroborating rows are never promoted or overwritten.
 *
 * The operation is idempotent and safe for repeated invocation after every
 * settlement, Stripe-application, QBO-application, revert, refund, or gift-merge
 * mutation. Caller should hold the surrounding transaction when invoked from a
 * write path.
 */
export async function applySettlementSupersedeForDeposits(
  dbi: DbLike,
  depositPaymentIds: string[],
): Promise<SettlementSupersedeResult> {
  const deposits = unique(depositPaymentIds);
  const result: SettlementSupersedeResult = {
    demotedApplicationIds: [],
    promotedApplicationIds: [],
    deletedDuplicateApplicationIds: [],
    affectedGiftIds: [],
    evaluatedDepositPaymentIds: deposits,
  };
  if (deposits.length === 0) return result;

  const links = (await dbi
    .select({
      id: settlementLinks.id,
      payoutId: settlementLinks.payoutId,
      depositPaymentId: settlementLinks.depositStagedPaymentId,
    })
    .from(settlementLinks)
    .where(
      and(
        eq(settlementLinks.lifecycle, "confirmed"),
        inArray(settlementLinks.depositStagedPaymentId, deposits),
        isNotNull(settlementLinks.depositStagedPaymentId),
      ),
    )) as Array<{
    id: string;
    payoutId: string;
    depositPaymentId: string | null;
  }>;

  const confirmedLinks: ConfirmedLinkRow[] = links
    .filter(
      (link): link is ConfirmedLinkRow => link.depositPaymentId != null,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const payoutIds = unique(confirmedLinks.map((link) => link.payoutId));
  const stripeRows =
    payoutIds.length === 0
      ? []
      : await dbi
          .select({
            payoutId: stripeStagedCharges.stripePayoutId,
            giftId: paymentApplications.giftId,
            amount: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)::text`,
          })
          .from(paymentApplications)
          .innerJoin(
            stripeStagedCharges,
            eq(
              stripeStagedCharges.id,
              paymentApplications.stripeChargeId,
            ),
          )
          .where(
            and(
              inArray(stripeStagedCharges.stripePayoutId, payoutIds),
              eq(paymentApplications.evidenceSource, "stripe"),
              eq(paymentApplications.linkRole, "counted"),
              eq(paymentApplications.lifecycle, "confirmed"),
            ),
          )
          .groupBy(
            stripeStagedCharges.stripePayoutId,
            paymentApplications.giftId,
          );

  const stripeByPayoutGift = new Map<string, number>();
  for (const row of stripeRows) {
    if (!row.payoutId) continue;
    const key = `${row.payoutId}\u0000${row.giftId}`;
    stripeByPayoutGift.set(key, Number(row.amount ?? 0));
  }

  const linksByDeposit = new Map<string, ConfirmedLinkRow[]>();
  for (const link of confirmedLinks) {
    const current = linksByDeposit.get(link.depositPaymentId) ?? [];
    current.push(link);
    linksByDeposit.set(link.depositPaymentId, current);
  }

  const qboRows = (await dbi
    .select({
      id: paymentApplications.id,
      paymentId: paymentApplications.paymentId,
      giftId: paymentApplications.giftId,
      amountApplied: paymentApplications.amountApplied,
      linkRole: paymentApplications.linkRole,
      supersededBySettlementLinkId:
        paymentApplications.supersededBySettlementLinkId,
    })
    .from(paymentApplications)
    .where(
      and(
        inArray(paymentApplications.paymentId, deposits),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.lifecycle, "confirmed"),
        or(
          eq(paymentApplications.linkRole, "counted"),
          isNotNull(paymentApplications.supersededBySettlementLinkId),
        ),
      ),
    )) as Array<{
    id: string;
    paymentId: string | null;
    giftId: string;
    amountApplied: string | null;
    linkRole: "counted" | "corroborating";
    supersededBySettlementLinkId: string | null;
  }>;

  const groups = new Map<string, QbApplicationRow[]>();
  for (const row of qboRows) {
    if (!row.paymentId) continue;
    const key = `${row.paymentId}\u0000${row.giftId}`;
    const current = groups.get(key) ?? [];
    current.push({ ...row, paymentId: row.paymentId });
    groups.set(key, current);
  }

  for (const rows of groups.values()) {
    const sample = rows[0];
    const depositLinks = linksByDeposit.get(sample.paymentId) ?? [];
    let stripeGross = 0;
    for (const link of depositLinks) {
      stripeGross +=
        stripeByPayoutGift.get(`${link.payoutId}\u0000${sample.giftId}`) ?? 0;
    }
    const ownerLinkId = depositLinks[0]?.id ?? null;
    const covered = stripeGrossCoversQbApplication(
      sample.amountApplied,
      stripeGross > 0 ? stripeGross.toFixed(2) : null,
    );

    const counted = rows.filter((row) => row.linkRole === "counted");
    const ownedCorroborating = rows.filter(
      (row) =>
        row.linkRole === "corroborating" &&
        row.supersededBySettlementLinkId != null,
    );
    const unrelatedCorroborating = rows.filter(
      (row) =>
        row.linkRole === "corroborating" &&
        row.supersededBySettlementLinkId == null,
    );

    if (counted.length > 1 || ownedCorroborating.length > 1) {
      throw new SettlementSupersedeCollisionError(
        sample.paymentId,
        sample.giftId,
        rows.map((row) => row.id),
      );
    }

    if (covered && ownerLinkId) {
      if (ownedCorroborating.length === 1) {
        if (counted.length === 1) {
          await dbi
            .delete(paymentApplications)
            .where(eq(paymentApplications.id, ownedCorroborating[0].id));
          result.deletedDuplicateApplicationIds.push(
            ownedCorroborating[0].id,
          );
        } else if (
          ownedCorroborating[0].supersededBySettlementLinkId !== ownerLinkId
        ) {
          await dbi
            .update(paymentApplications)
            .set({
              supersededBySettlementLinkId: ownerLinkId,
              updatedAt: new Date(),
            })
            .where(eq(paymentApplications.id, ownedCorroborating[0].id));
        }
      }

      if (counted.length === 1) {
        if (unrelatedCorroborating.length > 0) {
          throw new SettlementSupersedeCollisionError(
            sample.paymentId,
            sample.giftId,
            rows.map((row) => row.id),
          );
        }
        await dbi
          .update(paymentApplications)
          .set({
            linkRole: "corroborating",
            supersededBySettlementLinkId: ownerLinkId,
            updatedAt: new Date(),
          })
          .where(eq(paymentApplications.id, counted[0].id));
        result.demotedApplicationIds.push(counted[0].id);
        result.affectedGiftIds.push(sample.giftId);
      }
      continue;
    }

    if (ownedCorroborating.length === 1) {
      if (counted.length === 1) {
        await dbi
          .delete(paymentApplications)
          .where(eq(paymentApplications.id, ownedCorroborating[0].id));
        result.deletedDuplicateApplicationIds.push(ownedCorroborating[0].id);
      } else {
        await dbi
          .update(paymentApplications)
          .set({
            linkRole: "counted",
            supersededBySettlementLinkId: null,
            updatedAt: new Date(),
          })
          .where(eq(paymentApplications.id, ownedCorroborating[0].id));
        result.promotedApplicationIds.push(ownedCorroborating[0].id);
        result.affectedGiftIds.push(sample.giftId);
      }
    }
  }

  result.affectedGiftIds = unique(result.affectedGiftIds);
  return result;
}

/** Resolve the deposit anchors touched by payout changes, then recompute them. */
export async function applySettlementSupersedeForPayouts(
  dbi: DbLike,
  payoutIds: string[],
): Promise<SettlementSupersedeResult> {
  const payouts = unique(payoutIds);
  if (payouts.length === 0) {
    return applySettlementSupersedeForDeposits(dbi, []);
  }
  const rows = await dbi
    .select({ depositPaymentId: settlementLinks.depositStagedPaymentId })
    .from(settlementLinks)
    .where(inArray(settlementLinks.payoutId, payouts));
  return applySettlementSupersedeForDeposits(
    dbi,
    unique(rows.map((row) => row.depositPaymentId)),
  );
}
