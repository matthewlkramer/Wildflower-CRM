import type { Response } from "express";
import { db } from "@workspace/db";
import { giftsAndPayments, opportunitiesAndPledges } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  getGiftGoverningFiscalYear,
  getPledgeGoverningFiscalYear,
  isFiscalYearAuditClosed,
  type GoverningFiscalYear,
} from "./governingFiscalYear";

/**
 * FISCAL-YEAR FREEZE GUARD.
 *
 * Once a fiscal year's external audit is CLOSED (`fiscal_years.audit_closed_at`
 * is set), every gift/pledge whose GOVERNING fiscal year is that year becomes
 * immutable: the audited books for that year must never change. Corrections are
 * instead booked as a NEW record in the current open fiscal year (an offsetting
 * write-off pledge for a shortfall, or a fresh gift for an overpayment — see the
 * amount-mismatch resolution flows).
 *
 * A mutation is frozen when EITHER side is closed:
 *   - CURRENT side  — the record's stored recognition date already lands in a
 *     closed FY (you can't touch an audited record); or
 *   - TARGET side   — the edit would MOVE the record's recognition date into a
 *     different, already-closed FY (you can't back-date money into a closed year).
 *
 * The recognition date is `date_received` for a gift and `actual_completion_date`
 * (the made/won date) for a pledge — see `governingFiscalYear.ts`. A record with
 * no recognition date (or a date outside every FY window) has no governing FY and
 * is therefore always mutable.
 *
 * This module is the SINGLE choke-point for freeze. Every human-edit route that
 * mutates an audited fact must call the matching `resolve*Freeze` helper and, when
 * `frozen`, `respondFrozen(res, decision)`. Coverage is enforced by
 * `freeze-guard-inventory.test.ts`, which fails when a new write surface on these
 * tables is not classified as guarded or exempt.
 */

export type FreezeSide = "current" | "target";

export type FreezeDecision =
  | { frozen: false }
  | {
      frozen: true;
      side: FreezeSide;
      fiscalYearId: string;
      fiscalYearLabel: string;
    };

const MUTABLE: FreezeDecision = { frozen: false };

/** Normalize a `date`/`timestamp` column value (string or Date) to a YYYY-MM-DD
 * key the governing-FY window comparison expects, or null when unset. */
function dateKey(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function closed(side: FreezeSide, fy: GoverningFiscalYear): FreezeDecision {
  return {
    frozen: true,
    side,
    fiscalYearId: fy.id,
    fiscalYearLabel: fy.label,
  };
}

/**
 * Freeze state for a GIFT mutation.
 * @param currentDateReceived the gift's stored `date_received` (undefined/null
 *   for a brand-new gift — only the target side is then checked).
 * @param nextDateReceived the post-update `date_received` (pass the merged value
 *   on a PATCH, or the body value on create). Omit for edits that don't touch the
 *   date (archive, allocation edits) so only the current side is checked.
 */
export async function resolveGiftFreeze(
  currentDateReceived: string | Date | null | undefined,
  nextDateReceived?: string | Date | null,
): Promise<FreezeDecision> {
  const current = dateKey(currentDateReceived);
  const currentFy = await getGiftGoverningFiscalYear(current);
  if (isFiscalYearAuditClosed(currentFy)) return closed("current", currentFy!);

  if (nextDateReceived !== undefined) {
    const next = dateKey(nextDateReceived);
    if (next !== current) {
      const targetFy = await getGiftGoverningFiscalYear(next);
      if (isFiscalYearAuditClosed(targetFy)) return closed("target", targetFy!);
    }
  }
  return MUTABLE;
}

/**
 * Freeze state for a PLEDGE / opportunity mutation, keyed to the FY containing
 * the made/won date (`actual_completion_date`).
 */
export async function resolvePledgeFreeze(
  currentActualCompletionDate: string | Date | null | undefined,
  nextActualCompletionDate?: string | Date | null,
): Promise<FreezeDecision> {
  const current = dateKey(currentActualCompletionDate);
  const currentFy = await getPledgeGoverningFiscalYear(current);
  if (isFiscalYearAuditClosed(currentFy)) return closed("current", currentFy!);

  if (nextActualCompletionDate !== undefined) {
    const next = dateKey(nextActualCompletionDate);
    if (next !== current) {
      const targetFy = await getPledgeGoverningFiscalYear(next);
      if (isFiscalYearAuditClosed(targetFy)) return closed("target", targetFy!);
    }
  }
  return MUTABLE;
}

/**
 * Freeze state for a GIFT identified by id — loads its stored recognition date
 * and checks the CURRENT side only. Used both to gate a gift ALLOCATION write
 * (gated by the parent gift's governing FY — allocations never carry their own
 * recognition date) and to gate a whole-gift mutation routed through a generic
 * helper that only has the id (archive / bulk). A missing/absent record is
 * treated as mutable (the caller will 404 or is inserting a fresh row).
 */
export async function resolveGiftFreezeById(
  giftId: string | null | undefined,
): Promise<FreezeDecision> {
  if (!giftId) return MUTABLE;
  const [gift] = await db
    .select({ dateReceived: giftsAndPayments.dateReceived })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, giftId));
  if (!gift) return MUTABLE;
  return resolveGiftFreeze(gift.dateReceived);
}

/** @see resolveGiftFreezeById — allocation writes are gated by the parent gift. */
export const resolveGiftAllocationFreeze = resolveGiftFreezeById;

/**
 * Freeze state for a PLEDGE / opportunity identified by id — loads its stored
 * made/won date and checks the CURRENT side only. Gates both a pledge ALLOCATION
 * write (by the parent's governing FY) and a whole-pledge mutation via a generic
 * helper (archive / bulk).
 */
export async function resolvePledgeFreezeById(
  pledgeOrOpportunityId: string | null | undefined,
): Promise<FreezeDecision> {
  if (!pledgeOrOpportunityId) return MUTABLE;
  const [pledge] = await db
    .select({ actualCompletionDate: opportunitiesAndPledges.actualCompletionDate })
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, pledgeOrOpportunityId));
  if (!pledge) return MUTABLE;
  return resolvePledgeFreeze(pledge.actualCompletionDate);
}

/** @see resolvePledgeFreezeById — allocation writes are gated by the parent pledge. */
export const resolvePledgeAllocationFreeze = resolvePledgeFreezeById;

/**
 * Human-readable explanation for a frozen decision. Shared by the single-record
 * 409 response (`respondFrozen`) and the per-row `failed[]` message that generic
 * bulk helpers (bulk-update / bulk-archive) record for a skipped frozen row.
 */
export function freezeMessage(
  decision: Extract<FreezeDecision, { frozen: true }>,
): string {
  const because =
    decision.side === "current"
      ? `its fiscal year (${decision.fiscalYearLabel}) has been closed for audit`
      : `it would move into an audit-closed fiscal year (${decision.fiscalYearLabel})`;
  return `This record can't be changed because ${because}. Book the correction in the current open fiscal year instead.`;
}

/**
 * Write the standard 409 "fiscal year frozen" response. Idiom mirrors
 * `notFound` / `respondInvariantFailure`: call it and `return` from the handler.
 * Only call with the `frozen: true` variant.
 */
export function respondFrozen(
  res: Response,
  decision: Extract<FreezeDecision, { frozen: true }>,
): void {
  res.status(409).json({
    error: "fiscal_year_frozen",
    message: freezeMessage(decision),
    details: {
      side: decision.side,
      fiscalYearId: decision.fiscalYearId,
      fiscalYearLabel: decision.fiscalYearLabel,
    },
  });
}
