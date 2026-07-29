import { CircleAlert, Landmark, MoreHorizontal } from "lucide-react";
import type {
  WorkbenchDeposit,
  WorkbenchDepositAccountingCheck,
  WorkbenchDepositQbRecord,
  WorkbenchDepositNodeQbRecord,
  WorkbenchDepositCharge,
  WorkbenchDepositCompositionComponentsItem,
  WorkbenchDepositLens,
  DepositExclusionReason,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  ClusterActions,
  AnchorRef,
  CreateGiftPrefill,
} from "@/components/reconciliation-clusters/actions";
import type { EvidencePreview } from "@/components/reconciliation-clusters/dialogs";
import {
  accountingCorrectionPresentation,
  accountingRecordIdentity,
  dedupeAccountingGroups,
  needsGiftPlaceholderPresentation,
  preferStagedAccountingRecords,
  singleAllocationPresentation,
  type DepositAccountingRecord,
} from "./presentation";

export type DepositActions = Omit<
  ClusterActions,
  "openMarkLoss" | "openMatchEvidence" | "unmatchPledge"
> & {
  openAccountingDisposition?: (
    checkId: string,
    disposition: "corrected" | "accepted_historical",
  ) => void;
  openAddKnownPayment?: (bankDepositId: string, remainder: string) => void;
  openFlagRemainder?: (bankDepositId: string, remainder: string) => void;
  removeManualComponent?: (componentId: string, label: string) => void;
  openChargeQbSearch?: (charge: WorkbenchDepositCharge) => void;
  openComponentQbSearch?: (
    component: WorkbenchDepositCompositionComponentsItem,
  ) => void;
  clearComponentQbSource?: (componentId: string) => void;
  openSinglePaymentDeposit?: (bankDepositId: string, amount: string) => void;
  /** Unified gift/opportunity/pledge search for a specific payment anchor. */
  openLinkEvidence?: (anchor: AnchorRef, mode: "all" | "pledges") => void;
  /** Column-level gift search must choose among every open payment on the row. */
  openColumnGiftSearch?: (deposit: WorkbenchDeposit) => void;
  openDepositQbEvidenceSearch?: (deposit: WorkbenchDeposit) => void;
  unlinkAccountingRecord?: (
    bankDepositId: string,
    record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord,
  ) => void;
  openFlagAccountingError?: (deposit: WorkbenchDeposit) => void;
  applyBankDepositExclusion?: (
    bankDepositId: string,
    reason: DepositExclusionReason,
  ) => void;
  /** Undo for a CONFIRMED charge↔QB tie (proposed ties go through rejectChargeQbTie). */
  openRevertChargeQbTie?: (chargeId: string, label: string) => void;
};

const BANK_EXCLUSION_MENU: Array<{
  label: string;
  reason: DepositExclusionReason;
}> = [
  { label: "Mark as non-WF money", reason: "non_wf" },
  { label: "Mark as returned payment", reason: "returned_wire" },
  { label: "Mark as expense refund", reason: "expense_refund" },
  { label: "Mark as COBRA / insurance", reason: "insurance" },
  { label: "Mark as membership fee", reason: "membership" },
  { label: "Mark as service agreement revenue", reason: "earned_income" },
  { label: "Mark as payroll / tax refund", reason: "tax_refund" },
  { label: "Mark as loan repayment", reason: "loan_repayment" },
  { label: "Mark as intercompany transfer", reason: "intercompany_transfer" },
];

function componentTitle(
  component: WorkbenchDepositCompositionComponentsItem,
): string {
  if (component.label) return component.label;
  return component.kind === "other"
    ? "Other non-Stripe payment"
    : component.kind.replaceAll("_", " ");
}

function componentKindLabel(kind: string): string {
  return kind === "other"
    ? "other non-Stripe payment"
    : kind.replaceAll("_", " ");
}

export const DEPOSIT_GRID =
  "grid grid-cols-[26px_minmax(150px,1fr)_minmax(220px,1.35fr)_minmax(220px,1.35fr)_minmax(190px,1fr)] gap-3 px-4 items-start";

export const DEPOSIT_LENSES: { id: WorkbenchDepositLens; label: string }[] = [
  { id: "all_open", label: "All open" },
  { id: "unresolved_composition", label: "Unresolved composition" },
  { id: "ambiguous_pairing", label: "Ambiguous pairing" },
  { id: "needs_gift", label: "Needs gift" },
  { id: "accounting_corrections", label: "Accounting corrections" },
  { id: "refunds", label: "Refunds" },
  { id: "completed", label: "Completed" },
  { id: "not_fundraising", label: "Not fundraising" },
];

function money(value: string | null | undefined): string {
  return value == null ? "—" : formatCurrency(value);
}

function amountNumber(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function checkTone(
  disposition: WorkbenchDepositAccountingCheck["disposition"],
) {
  return disposition === "correction_needed"
    ? "destructive"
    : disposition === "consistent" || disposition === "corrected"
      ? "secondary"
      : "outline";
}

function CardActionsMenu({
  items,
}: {
  items: Array<{
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    /** Shown as a muted second line when the item is disabled (label-not-hide). */
    disabledReason?: string;
  }>;
}) {
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Card actions"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            onSelect={item.onSelect}
          >
            {item.disabled && item.disabledReason ? (
              <span className="flex max-w-[260px] flex-col">
                <span>{item.label}</span>
                <span className="whitespace-normal text-[10px] leading-snug text-muted-foreground">
                  {item.disabledReason}
                </span>
              </span>
            ) : (
              item.label
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_GIFT_ANCHOR_REASON =
  "No unlinked payment evidence — resolve the deposit's composition first.";
const CHARGE_PLEDGE_BLOCKED_REASON =
  "No QuickBooks record backs this charge yet — Stripe money can only be linked to an existing gift.";
const MANUAL_COMPONENT_QB_REASON =
  "No QuickBooks record backs this manual payment yet — link an existing gift, or attach its QB record first (Search QuickBooks… on the payment).";
const COMPONENT_NO_UNIT_REASON =
  "This payment has no decomposed payment unit to act on — reload and try again, or link an existing gift.";

export interface DepositRowProps {
  deposit: WorkbenchDeposit;
  expanded?: boolean;
  onToggle?: () => void;
  actions?: DepositActions;
  onConfirmProvisional?: (id: string) => void;
  onDismissProvisional?: (id: string) => void;
}

const NOOP_ACTIONS: DepositActions = {
  busy: false,
  openLinkGift: () => undefined,
  openCreateGift: () => undefined,
  openLinkEvidence: () => undefined,
  openColumnGiftSearch: () => undefined,
  openIdentify: () => undefined,
  openDonorboxSearch: () => undefined,
  openCodingFormLookup: () => undefined,
  openExclude: () => undefined,
  reInclude: () => undefined,
  openRevert: () => undefined,
  openConfirmRefund: () => undefined,
  openDismissRefund: () => undefined,
  openFlag: () => undefined,
  openFlagGift: () => undefined,
  openSettlementSearch: () => undefined,
  openLinkDepositPayout: () => undefined,
  openLinkPayoutDeposit: () => undefined,
  openUnlinkPayoutDeposit: () => undefined,
  openConfirmPayoutBankMatch: () => undefined,
  openBankDepositExclusion: () => undefined,
  clearBankDepositExclusion: () => undefined,
  isFinanceOrAdmin: false,
  canUseCodingForm: false,
  openQbDetail: () => undefined,
  rejectChargeQbTie: () => undefined,
  confirmProposedMatch: () => undefined,
  openUnlinkChooser: () => undefined,
  openMergeGifts: () => undefined,
  confirmChargeProposal: () => undefined,
  openAddKnownPayment: () => undefined,
  openFlagRemainder: () => undefined,
  removeManualComponent: () => undefined,
  openChargeQbSearch: () => undefined,
  openComponentQbSearch: () => undefined,
  clearComponentQbSource: () => undefined,
  openSinglePaymentDeposit: () => undefined,
  openDepositQbEvidenceSearch: () => undefined,
  openFlagAccountingError: () => undefined,
  applyBankDepositExclusion: () => undefined,
  openRevertChargeQbTie: () => undefined,
};

export function DepositGridHeader() {
  return (
    <div
      className={`${DEPOSIT_GRID} border-b bg-muted/40 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground`}
    >
      <span />
      <span className="flex items-center gap-1">
        <Landmark className="h-3 w-3" /> Bank
      </span>
      <span>Composition</span>
      <span>Gifts</span>
      <span>Accounting</span>
    </div>
  );
}

function Composition({
  deposit,
  actions,
  onConfirmProvisional,
  onDismissProvisional,
}: {
  deposit: WorkbenchDeposit;
  actions: DepositActions;
  onConfirmProvisional?: (id: string) => void;
  onDismissProvisional?: (id: string) => void;
}) {
  const composition = deposit.composition;
  const remainder = Number(composition.unexplainedAmount ?? 0);
  const showRemainderActions =
    actions.isFinanceOrAdmin &&
    (composition.kind === "unresolved" ||
      ((composition.kind === "components" ||
        composition.kind === "qbo_provisional") &&
        remainder > 0.005));
  const remainderLinks = showRemainderActions ? (
    <div className="mt-1.5 flex flex-wrap gap-2">
      <button
        type="button"
        className="text-[10px] font-medium text-primary hover:underline"
        onClick={() =>
          actions.openSinglePaymentDeposit?.(
            deposit.anchorId,
            composition.unexplainedAmount,
          )
        }
      >
        Single payment deposit…
      </button>
      <button
        type="button"
        className="text-[10px] font-medium text-primary hover:underline"
        onClick={() =>
          actions.openAddKnownPayment?.(
            deposit.anchorId,
            composition.unexplainedAmount,
          )
        }
      >
        Add known payment…
      </button>
      <button
        type="button"
        className="text-[10px] font-medium text-amber-800 hover:underline dark:text-amber-200"
        onClick={() =>
          actions.openFlagRemainder?.(
            deposit.anchorId,
            composition.unexplainedAmount,
          )
        }
      >
        Flag remainder for research
      </button>
    </div>
  ) : null;
  const remainderActions = showRemainderActions ? (
    <div className="rounded-md border border-dashed border-amber-300 bg-amber-50/50 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/20">
      <span className="text-[11px] text-amber-900 dark:text-amber-200">
        {money(composition.unexplainedAmount)} unresolved remainder
      </span>
      {remainderLinks}
    </div>
  ) : null;
  if (composition.kind === "stripe_unlinked") {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
          Stripe payout — not yet paired
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          The bank memo identifies a Stripe settlement, but no payout is linked
          yet.
        </p>
      </div>
    );
  }
  if (composition.kind === "unresolved") {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
          Unresolved composition
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {money(composition.unexplainedAmount)} of the deposit has no known
          source.
        </p>
        {remainderLinks}
      </div>
    );
  }
  if (composition.kind === "stripe_payout") {
    const refundTotal = Number(composition.refundTotal ?? 0);
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-2.5 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
        <p className="text-xs font-semibold">
          Stripe payout · {money(composition.netTotal)} net
        </p>
        <p className="text-[11px] text-muted-foreground">
          {composition.payoutDate
            ? formatDateShort(composition.payoutDate)
            : "Undated"}{" "}
          · {composition.payoutId} ·{" "}
          {composition.chargeCount ?? deposit.charges.length} charge
          {(composition.chargeCount ?? deposit.charges.length) === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
          Gross {money(composition.grossTotal)} − fees{" "}
          {money(composition.feeTotal)} − refunds{" "}
          {money(composition.refundTotal)} + adjustments{" "}
          {money(composition.adjustmentTotal)} = {money(composition.netTotal)} =
          bank {money(deposit.bank.amount)}
        </p>
        <div className="mt-2 space-y-1">
          {deposit.charges.map((charge) => {
            const refundedAmount = Number(charge.amountRefunded ?? 0);
            const laterRefunded = charge.refunded || refundedAmount > 0;
            const partialLaterRefund =
              laterRefunded &&
              refundedAmount > 0 &&
              refundedAmount < Number(charge.amount);
            return (
              <div
                key={charge.chargeId}
                className="flex items-center justify-between rounded border bg-background/80 px-2 py-1 text-[11px]"
              >
                <span className="truncate">
                  {charge.payerName ?? charge.chargeId}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="tabular-nums">{money(charge.amount)}</span>
                  {laterRefunded ? (
                    <Badge
                      variant="outline"
                      className="border-rose-300 text-[9px] text-rose-700 dark:border-rose-800 dark:text-rose-300"
                    >
                      Later refunded
                      {partialLaterRefund
                        ? ` · ${money(charge.amountRefunded)}`
                        : ""}
                    </Badge>
                  ) : null}
                  {charge.exclusionReason ? (
                    <Badge variant="destructive" className="text-[9px]">
                      Excluded
                    </Badge>
                  ) : null}
                  {actions.isFinanceOrAdmin ? (
                    <CardActionsMenu
                      items={[
                        {
                          label: "Exclude",
                          onSelect: () =>
                            actions.openExclude({
                              kind: "charge",
                              id: charge.chargeId,
                              label: charge.payerName ?? charge.chargeId,
                            }),
                        },
                        {
                          label: "Re-include",
                          onSelect: () =>
                            actions.reInclude({
                              kind: "charge",
                              id: charge.chargeId,
                              label: charge.payerName ?? charge.chargeId,
                            }),
                        },
                        ...(charge.refundKind
                          ? [
                              {
                                label: "Confirm refund",
                                onSelect: () =>
                                  actions.openConfirmRefund(
                                    charge.chargeId,
                                    charge.refundKind === "chargeback"
                                      ? "chargeback"
                                      : "refund",
                                    charge.payerName ?? charge.chargeId,
                                  ),
                              },
                              {
                                label: "Dismiss refund",
                                onSelect: () =>
                                  actions.openDismissRefund(
                                    charge.chargeId,
                                    charge.payerName ?? charge.chargeId,
                                  ),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ) : null}
                </span>
              </div>
            );
          })}
          {refundTotal > 0 ? (
            <div className="flex items-center justify-between rounded border border-rose-200 bg-rose-50/50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
              <span className="truncate">Refunds settled in payout</span>
              <span className="tabular-nums">
                −{money(composition.refundTotal)}
              </span>
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {composition.payoutAmbiguous ? (
            <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
              guessed match
            </span>
          ) : (
            <span />
          )}
          {actions.isFinanceOrAdmin && composition.payoutId ? (
            <CardActionsMenu
              items={[
                ...(composition.payoutAmbiguous
                  ? [
                      {
                        label: "Confirm match",
                        onSelect: () =>
                          actions.openConfirmPayoutBankMatch?.(
                            composition.payoutId ?? "",
                          ),
                      },
                    ]
                  : []),
                {
                  label: "Unlink deposit",
                  onSelect: () =>
                    actions.openUnlinkPayoutDeposit?.(
                      composition.payoutId ?? "",
                    ),
                },
                {
                  label: "Link to a different deposit…",
                  onSelect: () =>
                    actions.openLinkPayoutDeposit?.(composition.payoutId ?? ""),
                },
                {
                  label: "Resolve payout settlement",
                  onSelect: () =>
                    actions.openSettlementSearch({
                      payoutId: composition.payoutId ?? "",
                      amount: deposit.bank.amount,
                      date: deposit.date ?? null,
                    }),
                },
              ]}
            />
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {composition.components.map((component) => (
        <div
          key={component.componentId}
          className={`rounded-md border px-2.5 py-1.5 text-[11px] ${component.unconfirmed ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30" : "bg-card"}`}
        >
          <div className="flex items-center justify-between">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {component.needsReview || component.ambiguousDepositMatch ? (
                <CircleAlert className="h-3 w-3 shrink-0 text-amber-600" />
              ) : null}
              <span className="font-medium">{componentTitle(component)}</span>
              {component.unconfirmed ? (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-400 text-[9px] text-amber-700"
                >
                  Unconfirmed
                </Badge>
              ) : null}
              {component.manual && component.needsReview ? (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-400 text-[9px] text-amber-700"
                >
                  Research placeholder
                </Badge>
              ) : null}
              {component.manual && !component.needsReview ? (
                <Badge variant="outline" className="shrink-0 text-[9px]">
                  Manual
                </Badge>
              ) : null}
              {component.exclusionReason ? (
                <Badge variant="destructive" className="shrink-0 text-[9px]">
                  Excluded
                </Badge>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="tabular-nums">{money(component.amount)}</span>
              {actions.isFinanceOrAdmin ? (
                <CardActionsMenu
                  items={[
                    ...(component.unconfirmed && component.componentId
                      ? [
                          {
                            label: "Confirm match",
                            onSelect: () =>
                              onConfirmProvisional?.(component.componentId),
                          },
                          {
                            label: "Dismiss match",
                            onSelect: () =>
                              onDismissProvisional?.(component.componentId),
                          },
                        ]
                      : []),
                    ...(component.source !== "qbo_provisional"
                      ? [
                          component.exclusionReason
                            ? {
                                label: "Re-include",
                                onSelect: () =>
                                  actions.reInclude({
                                    kind: "component",
                                    id: component.componentId,
                                    label: componentTitle(component),
                                  }),
                              }
                            : {
                                label: "Exclude…",
                                onSelect: () =>
                                  actions.openExclude({
                                    kind: "component",
                                    id: component.componentId,
                                    label: componentTitle(component),
                                  }),
                              },
                        ]
                      : []),
                    ...(!component.unconfirmed &&
                    component.kind !== "stripe_charge" &&
                    component.source !== "qbo_provisional" &&
                    !component.stagedPaymentId
                      ? [
                          {
                            label: "Search QuickBooks…",
                            onSelect: () =>
                              actions.openComponentQbSearch?.(component),
                          },
                        ]
                      : []),
                    ...(!component.unconfirmed &&
                    component.source !== "qbo_provisional"
                      ? [
                          {
                            label: "Unlink payment",
                            onSelect: () =>
                              actions.removeManualComponent?.(
                                component.componentId,
                                componentTitle(component),
                              ),
                          },
                        ]
                      : []),
                    ...(component.sourceStagedPaymentManual &&
                    component.stagedPaymentId
                      ? [
                          {
                            label: "Clear QBO source",
                            onSelect: () =>
                              actions.clearComponentQbSource?.(
                                component.componentId,
                              ),
                          },
                        ]
                      : []),
                  ]}
                />
              ) : null}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {[
              composition.components.length === 1 &&
              amountNumber(composition.unexplainedAmount) === 0
                ? "Single payment"
                : null,
              component.receivedDate
                ? formatDateShort(component.receivedDate)
                : "Undated",
              componentKindLabel(component.kind),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      ))}
      {!composition.components.length ? (
        <span className="text-xs text-muted-foreground">No components</span>
      ) : null}
      {remainderActions}
    </div>
  );
}

function asQbDetailRecord(
  record: DepositAccountingRecord,
): Parameters<ClusterActions["openQbDetail"]>[0] {
  const role =
    record.role === "component" || record.role === "provisional"
      ? "anchor"
      : record.role;
  return { ...record, role } as Parameters<ClusterActions["openQbDetail"]>[0];
}

function accountingLabel(
  record: DepositAccountingRecord | WorkbenchDepositAccountingCheck,
): string {
  return (
    record.qbTransactionMemo ??
    ("memo" in record ? record.memo : null) ??
    record.payerName ??
    record.lineDescription ??
    record.stagedPaymentId
  );
}

function NodeQbCard({
  record,
  check,
  menuItems,
}: {
  record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord;
  check?: WorkbenchDepositAccountingCheck;
  menuItems?: Array<{
    label: string;
    onSelect: () => void;
    disabled?: boolean;
  }>;
}) {
  const registerRecord =
    "bankTransactionId" in record && record.bankTransactionId ? record : null;
  const correction = accountingCorrectionPresentation(check);
  return (
    <div className="rounded-md border border-dashed bg-card px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] font-medium">
          {registerRecord?.payee ??
            record.payerName ??
            record.memo ??
            record.lineDescription ??
            record.stagedPaymentId}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {correction ? (
            <Badge variant="destructive" className="text-[9px]">
              {correction.label}
            </Badge>
          ) : null}
          <span className="text-[10px] tabular-nums">
            {money(record.amount)}
          </span>
          {menuItems?.length ? <CardActionsMenu items={menuItems} /> : null}
        </span>
      </div>
      <div className="mt-0.5 whitespace-normal break-words text-[9px] text-muted-foreground">
        {registerRecord
          ? `${registerRecord.dateReceived ?? "Undated"} · ${registerRecord.txnType ?? "register"} · ${registerRecord.refNo ?? "No ref"} · ${registerRecord.reconciliationStatus ?? "Unreconciled"} · ${registerRecord.account ?? "No account"}`
          : [
              record.role.replace("_", " "),
              record.dateReceived ?? "Undated",
              record.qbLocation ?? record.revenueLocation ?? "No location",
              record.qbDocNumber
                ? `Doc ${record.qbDocNumber}`
                : record.qbCheckNumber
                  ? `Check ${record.qbCheckNumber}`
                  : null,
            ]
              .filter(Boolean)
              .join(" · ")}
      </div>
      {correction ? (
        <div className="mt-1 whitespace-normal break-words text-[9px] font-medium text-destructive">
          {correction.note}
        </div>
      ) : null}
      {registerRecord ? (
        <div className="whitespace-normal break-words text-[9px] text-muted-foreground">
          {record.memo ?? "No memo"}
        </div>
      ) : (
        <>
          {record.memo && record.memo !== record.payerName ? (
            <div className="whitespace-normal break-words text-[9px] text-muted-foreground">
              {record.memo}
            </div>
          ) : null}
          {record.lineDescription && record.lineDescription !== record.memo ? (
            <div className="whitespace-normal break-words text-[9px] text-muted-foreground">
              {record.lineDescription}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Accounting({
  deposit,
  actions,
  onDismissProvisional,
}: {
  deposit: WorkbenchDeposit;
  actions: DepositActions;
  onDismissProvisional?: (id: string) => void;
}) {
  const { accountingChecks: checks, qbRecords: records } = deposit;
  const visibleRecords = preferStagedAccountingRecords(records);
  const checksByPayment = new Map(
    checks.map((check) => [check.stagedPaymentId, check]),
  );
  const items = [
    ...visibleRecords.map((record) => ({
      record,
      check: checksByPayment.get(record.stagedPaymentId),
    })),
    ...checks
      .filter(
        (check) =>
          !visibleRecords.some(
            (record) => record.stagedPaymentId === check.stagedPaymentId,
          ),
      )
      .map((check) => ({ record: undefined, check })),
  ];
  const nodeGroups = dedupeAccountingGroups([
    ...deposit.charges.map((charge) => ({
      key: `charge-${charge.chargeId}`,
      label: "Stripe charge accounting",
      records: charge.qboRecords ?? [],
    })),
    ...deposit.composition.components.map((component) => ({
      key: `component-${component.componentId}`,
      label: "Payment accounting",
      records: component.qboRecords ?? [],
    })),
    {
      key: "deposit",
      label: "Deposit accounting",
      records: visibleRecords.filter((record) => record.role === "deposit"),
    },
    ...deposit.gifts.map((gift) => ({
      key: `gift-${gift.giftId}`,
      label: "Gift accounting",
      records: gift.qboRecords ?? [],
    })),
  ]);
  const nodeRecordIds = new Set(
    nodeGroups.flatMap((group) => group.records.map(accountingRecordIdentity)),
  );
  const unalignedItems = items.filter(
    ({ record }) =>
      !record || !nodeRecordIds.has(accountingRecordIdentity(record)),
  );
  const firstRecord = visibleRecords[0];
  const firstDisplay = firstRecord ?? checks[0];
  const firstCorrection = checks.find(
    (check) => check.disposition === "correction_needed",
  );
  const columnMenu = actions.isFinanceOrAdmin ? (
    <div className="absolute right-0 top-0 z-10">
      <CardActionsMenu
        items={[
          {
            label: "Search for accounting evidence…",
            onSelect: () => actions.openDepositQbEvidenceSearch?.(deposit),
          },
          {
            label: "Flag accounting error…",
            onSelect: () => actions.openFlagAccountingError?.(deposit),
            disabled: !visibleRecords.length && !checks.length,
          },
          {
            label: "QB detail",
            onSelect: () => {
              if (firstRecord)
                actions.openQbDetail(
                  asQbDetailRecord(firstRecord),
                  checksByPayment.get(firstRecord.stagedPaymentId)
                    ? "matched"
                    : "missing",
                );
            },
            disabled: !firstRecord,
          },
          {
            label: "Exclude",
            onSelect: () => {
              if (firstDisplay)
                actions.openExclude({
                  kind: "staged",
                  id: firstDisplay.stagedPaymentId,
                  label: accountingLabel(firstDisplay),
                });
            },
            disabled: !firstDisplay,
          },
          {
            label: "Mark corrected",
            onSelect: () => {
              if (firstCorrection)
                actions.openAccountingDisposition?.(
                  firstCorrection.id,
                  "corrected",
                );
            },
            disabled: !firstCorrection,
          },
          {
            label: "Accept historical…",
            onSelect: () => {
              if (firstCorrection)
                actions.openAccountingDisposition?.(
                  firstCorrection.id,
                  "accepted_historical",
                );
            },
            disabled: !firstCorrection,
          },
        ]}
      />
    </div>
  ) : null;
  const nodeMenuItems = (
    record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord,
  ): Array<{ label: string; onSelect: () => void }> => {
    if (!actions.isFinanceOrAdmin) return [];
    if (record.role === "component" && record.componentId) {
      const componentId = record.componentId;
      return [
        {
          label: "Unlink",
          onSelect: () => actions.clearComponentQbSource?.(componentId),
        },
      ];
    }
    if (record.role === "provisional" && record.componentId) {
      const componentId = record.componentId;
      return [
        {
          label: "Unlink (dismiss proposed)",
          onSelect: () => onDismissProvisional?.(componentId),
        },
      ];
    }
    if (record.role === "charge_tie" && record.linkedChargeId) {
      const chargeId = record.linkedChargeId;
      const tieLifecycle =
        "tieLifecycle" in record ? (record.tieLifecycle ?? null) : null;
      if (tieLifecycle === "confirmed") {
        const label = `${record.payerName ?? record.reference ?? "QB record"} ${money(record.amount)}`;
        return [
          {
            label: "Unlink (remove confirmed tie)",
            onSelect: () => actions.openRevertChargeQbTie?.(chargeId, label),
          },
        ];
      }
      return [
        {
          label: "Unlink (dismiss proposed)",
          onSelect: () => actions.rejectChargeQbTie(chargeId),
        },
      ];
    }
    return [
      {
        label: "Unlink",
        onSelect: () =>
          actions.unlinkAccountingRecord?.(deposit.anchorId, record),
      },
    ];
  };
  if (!nodeGroups.length && !unalignedItems.length) {
    return (
      <div className="relative min-w-0 pr-7">
        {columnMenu}
        <span className="text-xs text-muted-foreground">
          No accounting evidence linked
        </span>
      </div>
    );
  }
  return (
    <div className="relative min-w-0 space-y-1.5 pr-7">
      {columnMenu}
      {nodeGroups.map((group) => (
        <div
          key={group.key}
          className="space-y-1 rounded-md border border-sky-200/70 bg-sky-50/30 p-1.5 dark:border-sky-900/60 dark:bg-sky-950/20"
        >
          <div className="truncate text-[10px] font-semibold text-sky-900 dark:text-sky-200">
            {group.label}
          </div>
          {group.records.map((record) => (
            <NodeQbCard
              key={`${record.role}-${record.stagedPaymentId}-${record.linkedChargeId ?? ""}`}
              record={record}
              check={checksByPayment.get(record.stagedPaymentId)}
              menuItems={nodeMenuItems(record)}
            />
          ))}
        </div>
      ))}
      {unalignedItems.map(({ record, check }) => {
        const display = record ?? check;
        if (!display) return null;
        const anchor: AnchorRef = {
          kind: "staged",
          id: display.stagedPaymentId,
          label: accountingLabel(display),
        };
        return (
          <div
            key={display.stagedPaymentId}
            className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5"
          >
            <span className="min-w-0">
              <span className="block truncate text-[11px]">
                {accountingLabel(display)}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {display.dateReceived ?? "Undated"} · {money(display.amount)} ·{" "}
                {display.qbLocation ?? display.revenueLocation ?? "No location"}{" "}
                ·{" "}
                {display.payerName ??
                  display.entityId ??
                  display.qbPayerType ??
                  "No entity"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {record && "unconfirmed" in record && record.unconfirmed ? (
                <Badge
                  variant="outline"
                  className="border-amber-400 text-[9px] text-amber-700"
                >
                  Unconfirmed
                </Badge>
              ) : null}
              {display.exclusionReason ? (
                <Badge variant="secondary" className="text-[9px]">
                  {display.exclusionReason.replaceAll("_", " ")}
                </Badge>
              ) : null}
              {check ? (
                <Badge
                  variant={checkTone(check.disposition)}
                  className="text-[10px]"
                >
                  {check.disposition.replace("_", " ")}
                </Badge>
              ) : null}
              {actions.isFinanceOrAdmin ? (
                <CardActionsMenu
                  items={[
                    {
                      label: "QB detail",
                      onSelect: () =>
                        actions.openQbDetail(
                          record
                            ? asQbDetailRecord(record)
                            : (display as WorkbenchDepositQbRecord),
                          check ? "matched" : "missing",
                        ),
                    },
                    ...(record
                      ? [
                          {
                            label: "Unlink",
                            onSelect: () =>
                              actions.unlinkAccountingRecord?.(
                                deposit.anchorId,
                                record,
                              ),
                          },
                        ]
                      : []),
                    {
                      label: "Exclude",
                      onSelect: () => actions.openExclude(anchor),
                    },
                    ...(check && check.disposition === "correction_needed"
                      ? [
                          {
                            label: "Mark corrected",
                            onSelect: () =>
                              actions.openAccountingDisposition?.(
                                check.id,
                                "corrected",
                              ),
                          },
                          {
                            label: "Accept historical…",
                            onSelect: () =>
                              actions.openAccountingDisposition?.(
                                check.id,
                                "accepted_historical",
                              ),
                          },
                        ]
                      : []),
                  ]}
                />
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function chargePreview(
  charge: WorkbenchDeposit["charges"][number],
): EvidencePreview {
  return {
    amount: money(charge.amount),
    date: charge.chargeDate ?? "—",
    method: charge.cardBrand ? `Card · ${charge.cardBrand}` : "Stripe charge",
    source: `Stripe charge ${charge.chargeId}`,
    memo: charge.description ?? charge.statementDescriptor ?? null,
  };
}

export function DepositRow({
  deposit,
  actions: suppliedActions,
  onConfirmProvisional,
  onDismissProvisional,
}: DepositRowProps) {
  const actions = suppliedActions ?? NOOP_ACTIONS;
  const isNotFundraising = deposit.lenses.includes("not_fundraising");
  const bankSourceDetails = [deposit.bank.payee, deposit.bank.refNo]
    .filter(Boolean)
    .join(" · ");
  const giftColumnTarget: {
    anchor: AnchorRef;
    prefill: CreateGiftPrefill;
  } | null = (() => {
    const charge = deposit.charges.find((item) => !item.linkedGiftId);
    if (charge) {
      return {
        anchor: {
          kind: "charge",
          id: charge.chargeId,
          label: charge.payerName ?? charge.chargeId,
        },
        prefill: {
          name: charge.payerName ?? null,
          dateReceived: charge.chargeDate?.slice(0, 10) ?? null,
        },
      };
    }
    // Staged anchor only when the backing QB row is still actionable
    // (pending) — a row booked elsewhere, excluded, or derived-excluded (e.g.
    // by a confirmed charge tie) would 409 every staged action.
    const component =
      deposit.composition.kind === "components"
        ? deposit.composition.components.find(
            (item) =>
              (item.countedGiftIds?.length ?? 0) === 0 &&
              Boolean(item.stagedPaymentId) &&
              item.stagedActionable === true,
          )
        : undefined;
    if (component?.stagedPaymentId) {
      return {
        anchor: {
          kind: "staged",
          id: component.stagedPaymentId,
          label: component.label ?? component.kind,
        },
        prefill: {
          name: null,
          dateReceived: component.receivedDate?.slice(0, 10) ?? null,
        },
      };
    }
    // Gift-less payment without an actionable QB row (manual entry, or its
    // staged row is unavailable): gift actions target the decomposed payment
    // unit itself — link adopts it, create-gift mints from it.
    const unitComponent =
      deposit.composition.kind === "components"
        ? deposit.composition.components.find(
            (item) =>
              item.source === "bank_spine" &&
              (item.countedGiftIds?.length ?? 0) === 0 &&
              !(item.stagedPaymentId && item.stagedActionable === true) &&
              Boolean(item.paymentUnitId) &&
              !item.exclusionReason,
          )
        : undefined;
    if (unitComponent) {
      return {
        anchor: {
          kind: "component",
          id: unitComponent.componentId,
          label: componentTitle(unitComponent),
          bankDepositId: deposit.anchorId,
          amount: unitComponent.amount,
          paymentUnitId: unitComponent.paymentUnitId ?? undefined,
        },
        prefill: {
          name: unitComponent.label ?? null,
          dateReceived: unitComponent.receivedDate?.slice(0, 10) ?? null,
        },
      };
    }
    return null;
  })();
  const giftColumnAnchor = giftColumnTarget?.anchor ?? null;
  // A component anchor without a payment unit has nothing to act on — gift
  // actions (create/identify/lookup) are unit-backed for component anchors.
  const giftColumnUnitless =
    giftColumnAnchor?.kind === "component" && !giftColumnAnchor.paymentUnitId;
  const bankPreview: EvidencePreview = {
    amount: money(deposit.bank.amount),
    date: deposit.date ? formatDateShort(deposit.date) : "—",
    method: "Bank deposit",
    source: deposit.bank.memo ?? deposit.bank.reference ?? deposit.anchorId,
    memo: deposit.bank.memo ?? null,
  };
  const unlinkedCharges = deposit.charges.filter(
    (charge) => !charge.linkedGiftId,
  );
  const unlinkedComponents =
    deposit.composition.kind === "components"
      ? deposit.composition.components.filter(
          (component) =>
            component.source === "bank_spine" &&
            (component.countedGiftIds?.length ?? 0) === 0 &&
            ((Boolean(component.stagedPaymentId) &&
              component.stagedActionable === true) ||
              (Boolean(component.paymentUnitId) && !component.exclusionReason)),
        )
      : [];
  const hasGiftColumnCards =
    deposit.gifts.length > 0 ||
    unlinkedCharges.length > 0 ||
    unlinkedComponents.length > 0;
  const alignGiftsToStripeCharges =
    deposit.composition.kind === "stripe_payout";
  const giftAnchor = (
    gift: WorkbenchDeposit["gifts"][number],
  ): AnchorRef | null => {
    const stagedId = gift.linkedStagedPaymentIds?.[0];
    if (stagedId) {
      const record = deposit.qbRecords.find(
        (item) => item.stagedPaymentId === stagedId,
      );
      return {
        kind: "staged",
        id: stagedId,
        label:
          record?.payerName ?? record?.lineDescription ?? gift.name ?? stagedId,
      };
    }
    const chargeId = gift.linkedChargeIds?.[0];
    if (chargeId) {
      const charge = deposit.charges.find((item) => item.chargeId === chargeId);
      return {
        kind: "charge",
        id: chargeId,
        label: charge?.payerName ?? gift.name ?? chargeId,
      };
    }
    // A manual gift-less component anchor belongs to a DIFFERENT payment on
    // the deposit — never borrow it for an already-linked gift's lookups.
    return giftColumnAnchor?.kind === "component" ? null : giftColumnAnchor;
  };
  return (
    <section
      className="border-b last:border-b-0"
      data-testid={`deposit-row-${deposit.anchorId}`}
    >
      <div
        className={`${DEPOSIT_GRID} w-full py-3 text-left transition-colors hover:bg-muted/30`}
      >
        <span />
        <span className="min-w-0">
          <span className="flex items-center justify-between gap-1.5 text-sm font-semibold tabular-nums">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {money(deposit.bank.amount)}
              {isNotFundraising ? (
                <Badge variant="outline" className="text-[9px]">
                  Not fundraising
                  {deposit.notFundraisingReason
                    ? ` · ${deposit.notFundraisingReason.replaceAll("_", " ")}`
                    : ""}
                </Badge>
              ) : null}
            </span>
            {actions.isFinanceOrAdmin ? (
              <CardActionsMenu
                items={[
                  ...(deposit.bankExclusion
                    ? [
                        {
                          label: "Return to open queue",
                          onSelect: () =>
                            actions.clearBankDepositExclusion?.(
                              deposit.anchorId,
                            ),
                        },
                        {
                          label: "Change exclusion reason…",
                          onSelect: () =>
                            actions.openBankDepositExclusion?.(
                              deposit.anchorId,
                              deposit.bankExclusion ?? null,
                            ),
                        },
                      ]
                    : [
                        ...BANK_EXCLUSION_MENU.map((item) => ({
                          label: item.label,
                          onSelect: () =>
                            actions.applyBankDepositExclusion?.(
                              deposit.anchorId,
                              item.reason,
                            ),
                        })),
                        {
                          label: "Mark as excluded — other…",
                          onSelect: () =>
                            actions.openBankDepositExclusion?.(
                              deposit.anchorId,
                              deposit.bankExclusion ?? null,
                            ),
                        },
                      ]),
                  ...(deposit.composition.payoutId
                    ? [
                        {
                          label: "Unlink payout",
                          onSelect: () =>
                            actions.openUnlinkPayoutDeposit?.(
                              deposit.composition.payoutId ?? "",
                            ),
                        },
                      ]
                    : /stripe\s+transfer/i.test(deposit.bank.memo ?? "")
                      ? [
                          {
                            label: "Link a payout…",
                            onSelect: () =>
                              actions.openLinkDepositPayout?.(deposit.anchorId),
                          },
                        ]
                      : []),
                ]}
              />
            ) : null}
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {deposit.date ? formatDateShort(deposit.date) : "Undated"} ·{" "}
            {deposit.bank.account ?? "Wells Fargo"}
          </span>
          <span className="mt-1 block whitespace-normal break-words text-[11px] text-muted-foreground">
            {deposit.bank.memo ?? deposit.bank.reference ?? deposit.anchorId}
          </span>
          {bankSourceDetails ? (
            <span className="block whitespace-normal break-words text-[11px] text-muted-foreground">
              {bankSourceDetails}
            </span>
          ) : null}
        </span>
        <span onClick={(event) => event.stopPropagation()}>
          <Composition
            deposit={deposit}
            actions={actions}
            onConfirmProvisional={onConfirmProvisional}
            onDismissProvisional={onDismissProvisional}
          />
        </span>
        <span
          onClick={(event) => event.stopPropagation()}
          className={`relative min-w-0 space-y-1.5 pr-7 ${alignGiftsToStripeCharges ? "pt-[76px]" : ""}`}
        >
          {actions.isFinanceOrAdmin ? (
            <div className="absolute right-0 top-0 z-10">
              <CardActionsMenu
                items={[
                  {
                    label: "Search and link gift…",
                    onSelect: () => {
                      if (giftColumnAnchor)
                        actions.openColumnGiftSearch?.(deposit);
                    },
                    disabled: !giftColumnAnchor,
                    disabledReason: !giftColumnAnchor
                      ? NO_GIFT_ANCHOR_REASON
                      : undefined,
                  },
                  {
                    label: "Create standalone gift…",
                    onSelect: () => {
                      if (giftColumnTarget && !giftColumnUnitless)
                        actions.openCreateGift(
                          giftColumnTarget.anchor,
                          bankPreview,
                          giftColumnTarget.prefill,
                        );
                    },
                    disabled: !giftColumnAnchor || giftColumnUnitless,
                    disabledReason: !giftColumnAnchor
                      ? NO_GIFT_ANCHOR_REASON
                      : giftColumnUnitless
                        ? COMPONENT_NO_UNIT_REASON
                        : undefined,
                  },
                  {
                    label: "Record as payment on pledge…",
                    onSelect: () => {
                      if (giftColumnAnchor?.kind === "staged")
                        actions.openLinkEvidence?.(giftColumnAnchor, "pledges");
                    },
                    disabled:
                      !giftColumnAnchor || giftColumnAnchor.kind !== "staged",
                    disabledReason: !giftColumnAnchor
                      ? NO_GIFT_ANCHOR_REASON
                      : giftColumnAnchor.kind === "charge"
                        ? CHARGE_PLEDGE_BLOCKED_REASON
                        : giftColumnAnchor.kind === "component"
                          ? MANUAL_COMPONENT_QB_REASON
                          : undefined,
                  },
                  ...(giftColumnAnchor
                    ? [
                        {
                          label: "Identify donor…",
                          onSelect: () => {
                            if (!giftColumnUnitless)
                              actions.openIdentify(
                                giftColumnAnchor,
                                bankPreview,
                              );
                          },
                          disabled: giftColumnUnitless,
                          disabledReason: giftColumnUnitless
                            ? COMPONENT_NO_UNIT_REASON
                            : undefined,
                        },
                        ...(actions.openDonorboxSearch
                          ? [
                              {
                                label: "Donorbox lookup…",
                                onSelect: () => {
                                  if (!giftColumnUnitless)
                                    actions.openDonorboxSearch?.(
                                      giftColumnAnchor,
                                      bankPreview,
                                    );
                                },
                                disabled: giftColumnUnitless,
                                disabledReason: giftColumnUnitless
                                  ? COMPONENT_NO_UNIT_REASON
                                  : undefined,
                              },
                            ]
                          : []),
                        ...(actions.canUseCodingForm &&
                        actions.openCodingFormLookup
                          ? [
                              {
                                label: "Coding form…",
                                onSelect: () => {
                                  if (!giftColumnUnitless)
                                    actions.openCodingFormLookup?.(
                                      giftColumnAnchor,
                                      bankPreview,
                                    );
                                },
                                disabled: giftColumnUnitless,
                                disabledReason: giftColumnUnitless
                                  ? COMPONENT_NO_UNIT_REASON
                                  : undefined,
                              },
                            ]
                          : []),
                      ]
                    : []),
                  ...(deposit.gifts.length > 1
                    ? [
                        {
                          label: "Merge gifts…",
                          onSelect: () =>
                            actions.openMergeGifts(
                              deposit.gifts.map((item) => item.giftId),
                            ),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          ) : null}
          {deposit.gifts.map((gift) => {
            const anchor = giftAnchor(gift);
            const allocations = gift.allocations ?? [];
            const allocationPresentation = singleAllocationPresentation(gift);
            return (
              <div
                key={gift.giftId}
                className="rounded-md border bg-card px-2.5 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-xs font-semibold">
                    {gift.name ?? gift.giftId}
                  </p>
                  {actions.isFinanceOrAdmin ? (
                    <CardActionsMenu
                      items={[
                        ...((gift.linkedChargeIds?.length ?? 0) +
                          (gift.linkedStagedPaymentIds?.length ?? 0) >
                        0
                          ? [
                              {
                                label: "Unlink",
                                onSelect: () => {
                                  const options = [
                                    ...(gift.linkedChargeIds ?? []).map(
                                      (id) => {
                                        const charge = deposit.charges.find(
                                          (item) => item.chargeId === id,
                                        );
                                        return {
                                          anchor: {
                                            kind: "charge" as const,
                                            id,
                                            label: charge?.payerName ?? id,
                                          },
                                          source: `Stripe charge · ${charge?.payerName ?? id}`,
                                          amount: money(charge?.amount),
                                          date: charge?.chargeDate ?? null,
                                        };
                                      },
                                    ),
                                    ...(gift.linkedStagedPaymentIds ?? []).map(
                                      (id) => {
                                        const record = deposit.qbRecords.find(
                                          (item) => item.stagedPaymentId === id,
                                        );
                                        return {
                                          anchor: {
                                            kind: "staged" as const,
                                            id,
                                            label:
                                              record?.lineDescription ?? id,
                                          },
                                          source: `QuickBooks · ${record?.lineDescription ?? id}`,
                                          amount: money(record?.amount),
                                          date: record?.dateReceived ?? null,
                                        };
                                      },
                                    ),
                                  ];
                                  if (options.length > 1)
                                    actions.openUnlinkChooser(
                                      gift.name ?? gift.giftId,
                                      options,
                                    );
                                  else if (options[0])
                                    actions.openRevert(
                                      options[0].anchor,
                                      `Unlink “${gift.name ?? gift.giftId}” from ${options[0].source}.`,
                                    );
                                },
                              },
                            ]
                          : []),
                        ...(anchor && actions.openDonorboxSearch
                          ? [
                              {
                                label: "Find Donorbox match…",
                                onSelect: () =>
                                  actions.openDonorboxSearch?.(
                                    anchor,
                                    bankPreview,
                                  ),
                              },
                            ]
                          : []),
                        ...(anchor &&
                        actions.canUseCodingForm &&
                        actions.openCodingFormLookup
                          ? [
                              {
                                label: "Find coding form match…",
                                onSelect: () =>
                                  actions.openCodingFormLookup?.(
                                    anchor,
                                    bankPreview,
                                  ),
                              },
                            ]
                          : []),
                        ...(deposit.gifts.length > 1
                          ? [
                              {
                                label: "Merge gifts…",
                                onSelect: () =>
                                  actions.openMergeGifts(
                                    deposit.gifts.map((item) => item.giftId),
                                  ),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ) : null}
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {gift.donorKind ? `${gift.donorKind} · ` : ""}
                  {gift.donorName ?? "Donor not identified"}
                </p>
                <p className="text-[11px] tabular-nums">
                  {gift.dateReceived
                    ? formatDateShort(gift.dateReceived)
                    : "Undated"}{" "}
                  · {money(gift.amount)}
                </p>
                {allocationPresentation.collapse ? (
                  allocationPresentation.summary ? (
                    <p className="mt-1 whitespace-normal break-words text-[10px] text-muted-foreground">
                      {allocationPresentation.summary}
                    </p>
                  ) : null
                ) : allocations.length > 0 ? (
                  <div className="mt-1 space-y-1">
                    {allocations.map((allocation) => (
                      <div
                        key={allocation.id}
                        className="rounded border bg-muted/30 px-2 py-1"
                      >
                        <div className="flex items-center justify-between gap-2 text-[10px]">
                          <span className="truncate">
                            {allocation.usage ?? "No usage coded"}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {gift.dateReceived
                              ? formatDateShort(gift.dateReceived)
                              : "Undated"}{" "}
                            · {money(allocation.amount)}
                          </span>
                        </div>
                        {allocation.purpose ? (
                          <div className="whitespace-normal break-words text-[9px] text-muted-foreground">
                            {allocation.purpose}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {unlinkedCharges.map((charge) => {
            const placeholder = needsGiftPlaceholderPresentation(
              charge.payerName,
              charge.chargeId,
            );
            const anchor: AnchorRef = {
              kind: "charge",
              id: charge.chargeId,
              label: charge.payerName ?? charge.chargeId,
            };
            return (
              <div
                key={`unlinked-charge-${charge.chargeId}`}
                className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-1.5 dark:border-amber-800 dark:bg-amber-950/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                      {placeholder.title}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {placeholder.subtitle}
                    </p>
                  </div>
                  <CardActionsMenu
                    items={[
                      {
                        label: "Search and link gift…",
                        onSelect: () => actions.openLinkGift(anchor),
                      },
                      {
                        label: "Create standalone gift…",
                        onSelect: () =>
                          actions.openCreateGift(
                            anchor,
                            chargePreview(charge),
                            {
                              name: charge.payerName ?? null,
                              dateReceived:
                                charge.chargeDate?.slice(0, 10) ?? null,
                            },
                          ),
                      },
                      {
                        label: "Identify donor…",
                        onSelect: () =>
                          actions.openIdentify(anchor, chargePreview(charge)),
                      },
                      ...(actions.isFinanceOrAdmin && actions.openDonorboxSearch
                        ? [
                            {
                              label: "Find Donorbox match…",
                              onSelect: () =>
                                actions.openDonorboxSearch?.(
                                  anchor,
                                  chargePreview(charge),
                                ),
                            },
                          ]
                        : []),
                      ...(actions.canUseCodingForm &&
                      actions.openCodingFormLookup
                        ? [
                            {
                              label: "Find coding form match…",
                              onSelect: () =>
                                actions.openCodingFormLookup?.(
                                  anchor,
                                  chargePreview(charge),
                                ),
                            },
                          ]
                        : []),
                      ...(actions.isFinanceOrAdmin &&
                      deposit.composition.payoutId &&
                      actions.openChargeQbSearch
                        ? [
                            {
                              label: "Search QuickBooks…",
                              onSelect: () =>
                                actions.openChargeQbSearch?.(charge),
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
                <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {charge.chargeDate
                    ? formatDateShort(charge.chargeDate)
                    : "Undated"}{" "}
                  · {money(charge.amount)}
                </p>
              </div>
            );
          })}
          {unlinkedComponents.map((component) => {
            const placeholder = needsGiftPlaceholderPresentation(
              component.label,
              componentTitle(component),
            );
            // Staged anchor only while the QB row is actionable (pending);
            // otherwise act on the decomposed payment unit directly.
            const anchor: AnchorRef =
              component.stagedPaymentId && component.stagedActionable === true
                ? {
                    kind: "staged",
                    id: component.stagedPaymentId,
                    label: componentTitle(component),
                  }
                : {
                    kind: "component",
                    id: component.componentId,
                    label: componentTitle(component),
                    bankDepositId: deposit.anchorId,
                    amount: component.amount,
                    paymentUnitId: component.paymentUnitId ?? undefined,
                  };
            const manualNoQb =
              anchor.kind === "component" && !anchor.paymentUnitId;
            const preview: EvidencePreview = {
              amount: money(component.amount),
              date: deposit.date ? formatDateShort(deposit.date) : "—",
              method: componentKindLabel(component.kind),
              source: componentTitle(component),
              memo: null,
            };
            return (
              <div
                key={`unlinked-component-${component.componentId}`}
                className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-1.5 dark:border-amber-800 dark:bg-amber-950/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                      {placeholder.title}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {placeholder.subtitle}
                    </p>
                  </div>
                  <CardActionsMenu
                    items={[
                      {
                        label: "Search and link gift…",
                        onSelect: () => actions.openLinkGift(anchor),
                      },
                      {
                        label: "Create standalone gift…",
                        onSelect: () => {
                          if (!manualNoQb)
                            actions.openCreateGift(anchor, preview, {
                              name: component.label ?? null,
                              dateReceived:
                                component.receivedDate?.slice(0, 10) ?? null,
                            });
                        },
                        disabled: manualNoQb,
                        disabledReason: manualNoQb
                          ? COMPONENT_NO_UNIT_REASON
                          : undefined,
                      },
                      {
                        label: "Identify donor…",
                        onSelect: () => {
                          if (!manualNoQb)
                            actions.openIdentify(anchor, preview);
                        },
                        disabled: manualNoQb,
                        disabledReason: manualNoQb
                          ? COMPONENT_NO_UNIT_REASON
                          : undefined,
                      },
                      ...(actions.isFinanceOrAdmin && actions.openDonorboxSearch
                        ? [
                            {
                              label: "Find Donorbox match…",
                              onSelect: () => {
                                if (!manualNoQb)
                                  actions.openDonorboxSearch?.(anchor, preview);
                              },
                              disabled: manualNoQb,
                              disabledReason: manualNoQb
                                ? COMPONENT_NO_UNIT_REASON
                                : undefined,
                            },
                          ]
                        : []),
                      ...(actions.canUseCodingForm &&
                      actions.openCodingFormLookup
                        ? [
                            {
                              label: "Find coding form match…",
                              onSelect: () => {
                                if (!manualNoQb)
                                  actions.openCodingFormLookup?.(
                                    anchor,
                                    preview,
                                  );
                              },
                              disabled: manualNoQb,
                              disabledReason: manualNoQb
                                ? COMPONENT_NO_UNIT_REASON
                                : undefined,
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
                <p className="text-[11px] tabular-nums text-muted-foreground">
                  {component.receivedDate
                    ? formatDateShort(component.receivedDate)
                    : "Undated"}{" "}
                  · {money(component.amount)}
                </p>
              </div>
            );
          })}
          {!hasGiftColumnCards ? (
            <span className="text-xs text-muted-foreground">
              No CRM gifts linked
            </span>
          ) : null}
        </span>
        <span onClick={(event) => event.stopPropagation()}>
          <Accounting
            deposit={deposit}
            actions={actions}
            onDismissProvisional={onDismissProvisional}
          />
        </span>
      </div>
    </section>
  );
}
