import type { Request } from "express";
import { safeRecordAudit, type AuditAction } from "./audit";

/**
 * Reconciliation-domain audit tagging. Every human queue action on the
 * reconciliation surfaces (exclude / re-include / resolve / reconcile / mint /
 * link / revert / refund decisions) records ONE best-effort audit_log row
 * tagged `metadata.domain = "reconciliation"` — the recent-changes rail on the
 * cluster workbench hydrates from exactly that tag, so a single user action is
 * a single rail entry.
 *
 * `undo` is a pointer to an EXISTING revert-shaped endpoint that safely undoes
 * the action (bound client-side to the matching generated mutation hook). It is
 * recorded at write time — validity is NOT re-checked when the rail renders;
 * the action endpoints keep their own guards and 409 cleanly if state moved on.
 * Actions with no safe single-call undo record `undo: null` and the rail shows
 * a disabled Undo with the reason.
 */
export type ReconUndoKind =
  | "revert_staged_payment"
  | "reinclude_staged_payment"
  | "revert_stripe_charge"
  | "reinclude_stripe_charge";

export interface ReconUndo {
  kind: ReconUndoKind;
  targetId: string;
}

export async function reconAudit(
  req: Request,
  opts: {
    action: AuditAction;
    entityType: "staged_payment" | "stripe_staged_charge" | "gift";
    entityId: string;
    summary: string;
    undo: ReconUndo | null;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await safeRecordAudit(req, {
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    summary: opts.summary,
    metadata: {
      domain: "reconciliation",
      undo: opts.undo,
      ...(opts.extra ?? {}),
    },
  });
}

/** "$1,234.56" for a numeric-string / number amount; "an unknown amount" when null. */
export function fmtMoney(amount: string | number | null | undefined): string {
  if (amount == null) return "an unknown amount";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "an unknown amount";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Payer display for summaries — falls back when the source row has no payer. */
export function payerLabel(payerName: string | null | undefined): string {
  return payerName?.trim() || "an unnamed payer";
}
