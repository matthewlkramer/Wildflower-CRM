import { CircleAlert, Landmark, MoreHorizontal } from "lucide-react";
import type {
  WorkbenchDeposit,
  WorkbenchDepositAccountingCheck,
  WorkbenchDepositQbRecord,
  WorkbenchDepositLens,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ClusterActions, AnchorRef } from "@/components/reconciliation-clusters/rows";
import type { EvidencePickOption, EvidencePreview } from "@/components/reconciliation-clusters/dialogs";

export type DepositActions = ClusterActions & {
  openAddKnownPayment?: (bankDepositId: string, remainder: string) => void;
  openFlagRemainder?: (bankDepositId: string, remainder: string) => void;
  removeManualComponent?: (componentId: string, label: string) => void;
};

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

function checkTone(disposition: WorkbenchDepositAccountingCheck["disposition"]) {
  return disposition === "correction_needed"
    ? "destructive"
    : disposition === "consistent" || disposition === "corrected"
      ? "secondary"
      : "outline";
}

function CardActionsMenu({
  items,
}: {
  items: Array<{ label: string; onSelect: () => void; disabled?: boolean }>;
}) {
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Card actions" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {items.map((item) => (
          <DropdownMenuItem key={item.label} disabled={item.disabled} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  openMarkLoss: () => undefined,
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
  openMatchEvidence: () => undefined,
  unmatchPledge: () => undefined,
  openUnlinkChooser: () => undefined,
  openMergeGifts: () => undefined,
  confirmChargeProposal: () => undefined,
  openAddKnownPayment: () => undefined,
  openFlagRemainder: () => undefined,
  removeManualComponent: () => undefined,
};

export function DepositGridHeader() {
  return (
    <div className={`${DEPOSIT_GRID} border-b bg-muted/40 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground`}>
      <span />
      <span className="flex items-center gap-1"><Landmark className="h-3 w-3" /> Bank</span>
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
      ((composition.kind === "components" || composition.kind === "qbo_provisional") &&
        remainder > 0.005));
  const remainderActions = showRemainderActions ? (
    <div className="rounded-md border border-dashed border-amber-300 bg-amber-50/50 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/20">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-amber-900 dark:text-amber-200">
          {money(composition.unexplainedAmount)} unresolved remainder
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="text-[10px] font-medium text-primary hover:underline"
            onClick={() => actions.openAddKnownPayment?.(deposit.anchorId, composition.unexplainedAmount)}
          >
            Add known payment…
          </button>
          <button
            type="button"
            className="text-[10px] font-medium text-amber-800 hover:underline dark:text-amber-200"
            onClick={() => actions.openFlagRemainder?.(deposit.anchorId, composition.unexplainedAmount)}
          >
            Flag remainder for research
          </button>
        </div>
      </div>
    </div>
  ) : null;
  if (composition.kind === "stripe_unlinked") {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">Stripe payout — not yet paired</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          The bank memo identifies a Stripe settlement, but no payout is linked yet.
        </p>
      </div>
    );
  }
  if (composition.kind === "unresolved") {
    return (
      <div className="space-y-1.5">
        <div className="rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">Unresolved composition</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {money(composition.unexplainedAmount)} of the deposit has no known source.
          </p>
        </div>
        {remainderActions}
      </div>
    );
  }
  if (composition.kind === "stripe_payout") {
    const refundTotal = Number(composition.refundTotal ?? 0);
    return (
      <div className="space-y-1.5">
        <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-2.5 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
          <p className="text-xs font-semibold">Stripe payout · {money(composition.netTotal)} net</p>
          <p className="text-[11px] text-muted-foreground">
            {composition.payoutDate ? formatDateShort(composition.payoutDate) : "Undated"} · {composition.payoutId} · {composition.chargeCount ?? deposit.charges.length} charge{(composition.chargeCount ?? deposit.charges.length) === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
            Gross {money(composition.grossTotal)} − fees {money(composition.feeTotal)} − refunds {money(composition.refundTotal)} + adjustments {money(composition.adjustmentTotal)} = {money(composition.netTotal)} = bank {money(deposit.bank.amount)}
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            {composition.payoutAmbiguous ? <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300">guessed match</span> : <span />}
            {actions.isFinanceOrAdmin && composition.payoutId ? (
              <CardActionsMenu items={[
                ...(composition.payoutAmbiguous
                  ? [{ label: "Confirm match", onSelect: () => actions.openConfirmPayoutBankMatch?.(composition.payoutId ?? "") }]
                  : []),
                { label: "Unlink deposit", onSelect: () => actions.openUnlinkPayoutDeposit?.(composition.payoutId ?? "") },
                { label: "Link to a different deposit…", onSelect: () => actions.openLinkPayoutDeposit?.(composition.payoutId ?? "") },
                { label: "Resolve payout settlement", onSelect: () => actions.openSettlementSearch({ payoutId: composition.payoutId ?? "", amount: deposit.bank.amount, date: deposit.date ?? null }) },
              ]} />
            ) : null}
          </div>
        </div>
        {deposit.charges.map((charge) => {
          const refundedAmount = Number(charge.amountRefunded ?? 0);
          const laterRefunded = charge.refunded || refundedAmount > 0;
          const partialLaterRefund = laterRefunded && refundedAmount > 0 && refundedAmount < Number(charge.amount);
          return (
          <div key={charge.chargeId} className="flex items-center justify-between rounded border bg-card px-2 py-1 text-[11px]">
            <span className="truncate">{charge.payerName ?? charge.chargeId}</span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="tabular-nums">{money(charge.amount)}</span>
              {laterRefunded ? (
                <Badge variant="outline" className="border-rose-300 text-[9px] text-rose-700 dark:border-rose-800 dark:text-rose-300">
                  Later refunded{partialLaterRefund ? ` · ${money(charge.amountRefunded)}` : ""}
                </Badge>
              ) : null}
              {charge.exclusionReason ? (
                <Badge variant="destructive" className="text-[9px]">Excluded</Badge>
              ) : null}
              {actions.isFinanceOrAdmin ? (
                <CardActionsMenu items={[
                  { label: "Exclude", onSelect: () => actions.openExclude({ kind: "charge", id: charge.chargeId, label: charge.payerName ?? charge.chargeId }) },
                  { label: "Re-include", onSelect: () => actions.reInclude({ kind: "charge", id: charge.chargeId, label: charge.payerName ?? charge.chargeId }) },
                  ...(charge.refundKind
                    ? [
                        { label: "Confirm refund", onSelect: () => actions.openConfirmRefund(charge.chargeId, charge.refundKind === "chargeback" ? "chargeback" : "refund", charge.payerName ?? charge.chargeId) },
                        { label: "Dismiss refund", onSelect: () => actions.openDismissRefund(charge.chargeId, charge.payerName ?? charge.chargeId) },
                      ]
                    : []),
                ]} />
              ) : null}
            </span>
          </div>
          );
        })}
        {refundTotal > 0 ? (
          <div className="flex items-center justify-between rounded border border-rose-200 bg-rose-50/50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
            <span className="truncate">Refunds settled in payout</span>
            <span className="tabular-nums">−{money(composition.refundTotal)}</span>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {composition.components.map((component) => (
        <div key={component.componentId} className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 text-[11px] ${component.unconfirmed ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30" : "bg-card"}`}>
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {component.needsReview || component.ambiguousDepositMatch ? <CircleAlert className="h-3 w-3 shrink-0 text-amber-600" /> : null}
            <span className="font-medium">{component.label ?? component.kind.replace("_", " ")}</span>
            {component.unconfirmed ? <Badge variant="outline" className="shrink-0 border-amber-400 text-[9px] text-amber-700">Unconfirmed</Badge> : null}
            {component.manual && component.needsReview ? <Badge variant="outline" className="shrink-0 border-amber-400 text-[9px] text-amber-700">Research placeholder</Badge> : null}
            {component.manual && !component.needsReview ? <Badge variant="outline" className="shrink-0 text-[9px]">Manual</Badge> : null}
            {component.exclusionReason ? <Badge variant="destructive" className="shrink-0 text-[9px]">Excluded</Badge> : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="tabular-nums">{money(component.amount)}</span>
            {actions.isFinanceOrAdmin && component.source !== "qbo_provisional" ? (
              <CardActionsMenu items={[
                component.exclusionReason
                  ? { label: "Re-include", onSelect: () => actions.reInclude({ kind: "component", id: component.componentId, label: component.label ?? component.kind }) }
                  : { label: "Exclude…", onSelect: () => actions.openExclude({ kind: "component", id: component.componentId, label: component.label ?? component.kind }) },
              ]} />
            ) : null}
            {component.unconfirmed && component.componentId && actions.isFinanceOrAdmin ? (
              <>
                <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => onConfirmProvisional?.(component.componentId)}>Confirm</button>
                <button type="button" className="text-[10px] text-muted-foreground hover:underline" onClick={() => onDismissProvisional?.(component.componentId)}>Dismiss</button>
              </>
            ) : null}
            {component.manual && (component.countedGiftIds?.length ?? 0) === 0 && actions.isFinanceOrAdmin ? (
              <button type="button" className="text-[10px] text-destructive hover:underline" onClick={() => actions.removeManualComponent?.(component.componentId, component.label ?? component.kind)}>
                Remove
              </button>
            ) : null}
          </span>
        </div>
      ))}
      {!composition.components.length ? <span className="text-xs text-muted-foreground">No components</span> : null}
      {remainderActions}
    </div>
  );
}

function accountingLabel(record: WorkbenchDepositAccountingCheck | WorkbenchDepositQbRecord): string {
  return record.qbTransactionMemo ?? ("memo" in record ? record.memo : null) ?? record.lineDescription ?? record.stagedPaymentId;
}

function Accounting({ checks, records, actions }: { checks: WorkbenchDepositAccountingCheck[]; records: WorkbenchDepositQbRecord[]; actions: ClusterActions }) {
  const checksByPayment = new Map(checks.map((check) => [check.stagedPaymentId, check]));
  const items = [
    ...records.map((record) => ({ record, check: checksByPayment.get(record.stagedPaymentId) })),
    ...checks
      .filter((check) => !records.some((record) => record.stagedPaymentId === check.stagedPaymentId))
      .map((check) => ({ record: undefined, check })),
  ];
  if (!items.length) {
    return <span className="text-xs text-muted-foreground">No accounting check</span>;
  }
  return (
    <div className="space-y-1.5">
      {items.map(({ record, check }) => {
        const display = record ?? check;
        if (!display) return null;
        const anchor: AnchorRef = { kind: "staged", id: display.stagedPaymentId, label: accountingLabel(display) };
        return (
        <div key={display.stagedPaymentId} className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5">
          <span className="min-w-0">
            <span className="block truncate text-[11px]">{accountingLabel(display)}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {display.dateReceived ?? "Undated"} · {money(display.amount)} · {display.qbLocation ?? display.revenueLocation ?? "No location"} · {display.payerName ?? display.entityId ?? display.qbPayerType ?? "No entity"}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {record?.unconfirmed ? <Badge variant="outline" className="border-amber-400 text-[9px] text-amber-700">Unconfirmed</Badge> : null}
            {display.exclusionReason ? <Badge variant="secondary" className="text-[9px]">{display.exclusionReason.replaceAll("_", " ")}</Badge> : null}
            {check ? (
              <Badge variant={checkTone(check.disposition)} className="text-[10px]">
                {check.disposition.replace("_", " ")}
              </Badge>
            ) : null}
            {actions.isFinanceOrAdmin ? (
              <CardActionsMenu items={[
                { label: "QB detail", onSelect: () => actions.openQbDetail(record ?? (display as WorkbenchDepositQbRecord), check ? "matched" : "missing") },
                { label: "Exclude", onSelect: () => actions.openExclude(anchor) },
              ]} />
            ) : null}
          </span>
        </div>
        );
      })}
    </div>
  );
}

function chargePreview(charge: WorkbenchDeposit["charges"][number]): EvidencePreview {
  return {
    amount: money(charge.amount),
    date: charge.chargeDate ?? "—",
    method: charge.cardBrand ? `Card · ${charge.cardBrand}` : "Stripe charge",
    source: `Stripe charge ${charge.chargeId}`,
    memo: charge.description ?? charge.statementDescriptor ?? null,
  };
}

function qbPreview(record: WorkbenchDeposit["qbRecords"][number]): EvidencePreview {
  return {
    amount: money(record.amount),
    date: record.dateReceived ?? "—",
    method: "QuickBooks payment",
    source: `QuickBooks record ${record.stagedPaymentId}`,
    memo: record.memo ?? record.lineDescription ?? null,
  };
}

export function DepositRow({ deposit, actions: suppliedActions, onConfirmProvisional, onDismissProvisional }: DepositRowProps) {
  const actions = suppliedActions ?? NOOP_ACTIONS;
  const isNotFundraising = deposit.lenses.includes("not_fundraising");
  const bankSourceDetails = [
    deposit.bank.payee,
    deposit.bank.refNo,
  ].filter(Boolean).join(" · ");
  const linkedStagedPaymentIds = new Set(deposit.gifts.flatMap((gift) => gift.linkedStagedPaymentIds ?? []));
  const evidenceOptions: EvidencePickOption[] = [
    ...deposit.charges.map((charge) => ({
      anchor: { kind: "charge" as const, id: charge.chargeId, label: charge.payerName ?? charge.chargeId },
      source: `Stripe charge · ${charge.payerName ?? charge.chargeId}`,
      amount: money(charge.amount),
      date: charge.chargeDate ?? null,
    })),
    ...deposit.qbRecords.map((record) => ({
      anchor: { kind: "staged" as const, id: record.stagedPaymentId, label: record.lineDescription ?? record.stagedPaymentId },
      source: `QuickBooks · ${record.lineDescription ?? record.stagedPaymentId}`,
      amount: money(record.amount),
      date: record.dateReceived ?? null,
    })),
  ];
  return (
    <section className="border-b last:border-b-0" data-testid={`deposit-row-${deposit.anchorId}`}>
      <div className={`${DEPOSIT_GRID} w-full py-3 text-left transition-colors hover:bg-muted/30`}>
        <span />
        <span className="min-w-0">
          <span className="flex items-center justify-between gap-1.5 text-sm font-semibold tabular-nums">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {money(deposit.bank.amount)}
              {isNotFundraising ? <Badge variant="outline" className="text-[9px]">Not fundraising{deposit.notFundraisingReason ? ` · ${deposit.notFundraisingReason.replaceAll("_", " ")}` : ""}</Badge> : null}
            </span>
            {actions.isFinanceOrAdmin ? (
              <CardActionsMenu items={[
                deposit.bankExclusion
                  ? { label: "Return to open queue", onSelect: () => actions.clearBankDepositExclusion?.(deposit.anchorId) }
                  : { label: "Mark not fundraising…", onSelect: () => actions.openBankDepositExclusion?.(deposit.anchorId, deposit.bankExclusion ?? null) },
                ...(deposit.composition.payoutId
                  ? [{ label: "Unlink payout", onSelect: () => actions.openUnlinkPayoutDeposit?.(deposit.composition.payoutId ?? "") }]
                  : /stripe\s+transfer/i.test(deposit.bank.memo ?? "")
                    ? [{ label: "Link a payout…", onSelect: () => actions.openLinkDepositPayout?.(deposit.anchorId) }]
                    : []),
              ]} />
            ) : null}
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {deposit.date ? formatDateShort(deposit.date) : "Undated"} · {deposit.bank.account ?? "Wells Fargo"}
          </span>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">{deposit.bank.memo ?? deposit.bank.reference ?? deposit.anchorId}</span>
          {bankSourceDetails ? <span className="block truncate text-[11px] text-muted-foreground">{bankSourceDetails}</span> : null}
        </span>
        <span onClick={(event) => event.stopPropagation()}><Composition deposit={deposit} actions={actions} onConfirmProvisional={onConfirmProvisional} onDismissProvisional={onDismissProvisional} /></span>
        <span onClick={(event) => event.stopPropagation()} className="space-y-1.5">
          {deposit.gifts.length ? deposit.gifts.map((gift) => (
            <div key={gift.giftId} className="rounded-md border bg-card px-2.5 py-1.5">
              <p className="truncate text-xs font-semibold">{gift.name ?? gift.giftId}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {gift.donorKind ? `${gift.donorKind} · ` : ""}{gift.donorName ?? "Donor not identified"}
              </p>
              <p className="text-[11px] tabular-nums">{money(gift.amount)}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openMatchEvidence(gift.giftId, gift.name ?? gift.giftId, evidenceOptions)}>Match evidence</button>
                {(gift.linkedChargeIds?.length ?? 0) + (gift.linkedStagedPaymentIds?.length ?? 0) > 0 ? (
                  <button
                    type="button"
                    className="text-[10px] text-destructive hover:underline"
                    onClick={() => {
                      const options = [
                        ...(gift.linkedChargeIds ?? []).map((id) => {
                          const charge = deposit.charges.find((item) => item.chargeId === id);
                          return { anchor: { kind: "charge" as const, id, label: charge?.payerName ?? id }, source: `Stripe charge · ${charge?.payerName ?? id}`, amount: money(charge?.amount), date: charge?.chargeDate ?? null };
                        }),
                        ...(gift.linkedStagedPaymentIds ?? []).map((id) => {
                          const record = deposit.qbRecords.find((item) => item.stagedPaymentId === id);
                          return { anchor: { kind: "staged" as const, id, label: record?.lineDescription ?? id }, source: `QuickBooks · ${record?.lineDescription ?? id}`, amount: money(record?.amount), date: record?.dateReceived ?? null };
                        }),
                      ];
                      if (options.length > 1) actions.openUnlinkChooser(gift.name ?? gift.giftId, options);
                      else if (options[0]) actions.openRevert(options[0].anchor, `Unlink “${gift.name ?? gift.giftId}” from ${options[0].source}.`);
                    }}
                  >
                    Unlink
                  </button>
                ) : null}
                {deposit.gifts.length > 1 ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openMergeGifts(deposit.gifts.map((item) => item.giftId))}>Merge gifts</button> : null}
              </div>
            </div>
          )) : <span className="text-xs text-muted-foreground">No CRM gifts linked</span>}
          {deposit.charges.filter((charge) => !charge.linkedGiftId).map((charge) => {
            const anchor: AnchorRef = { kind: "charge", id: charge.chargeId, label: charge.payerName ?? charge.chargeId };
            return (
              <div key={`unlinked-charge-${charge.chargeId}`} className="rounded-md border border-dashed bg-card px-2.5 py-1.5">
                <p className="truncate text-[11px] font-medium">{charge.payerName ?? charge.chargeId}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openLinkGift(anchor)}>Search and link gift</button>
                  <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openCreateGift(anchor, chargePreview(charge))}>Create gift</button>
                  <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openIdentify(anchor, chargePreview(charge))}>Identify donor</button>
                  {actions.isFinanceOrAdmin && actions.openDonorboxSearch ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openDonorboxSearch?.(anchor, chargePreview(charge))}>Donorbox lookup</button> : null}
                  {actions.canUseCodingForm && actions.openCodingFormLookup ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openCodingFormLookup?.(anchor, chargePreview(charge))}>Coding form</button> : null}
                </div>
              </div>
            );
          })}
          {deposit.qbRecords.filter((record) => !linkedStagedPaymentIds.has(record.stagedPaymentId)).map((record) => {
            const anchor: AnchorRef = { kind: "staged", id: record.stagedPaymentId, label: record.lineDescription ?? record.reference ?? record.stagedPaymentId };
            return (
              <div key={`unlinked-qb-${record.stagedPaymentId}`} className="rounded-md border border-dashed bg-card px-2.5 py-1.5">
                <p className="truncate text-[11px] font-medium">{anchor.label}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openLinkGift(anchor)}>Search and link gift</button>
                  <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openCreateGift(anchor, qbPreview(record))}>Create gift</button>
                  {actions.isFinanceOrAdmin && actions.openDonorboxSearch ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openDonorboxSearch?.(anchor, qbPreview(record))}>Donorbox lookup</button> : null}
                  {actions.canUseCodingForm && actions.openCodingFormLookup ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openCodingFormLookup?.(anchor, qbPreview(record))}>Coding form</button> : null}
                </div>
              </div>
            );
          })}
          {deposit.composition.kind === "components" ? deposit.composition.components
            .filter((component) => component.source === "bank_spine" && (component.countedGiftIds?.length ?? 0) === 0 && component.stagedPaymentId)
            .map((component) => {
              const anchor: AnchorRef = {
                kind: "staged",
                id: component.stagedPaymentId ?? "",
                label: component.label ?? component.kind,
              };
              const preview: EvidencePreview = {
                amount: money(component.amount),
                date: deposit.date ? formatDateShort(deposit.date) : "—",
                method: component.kind.replaceAll("_", " "),
                source: component.label ?? component.kind,
                memo: null,
              };
              return (
                <div key={`unlinked-component-${component.componentId}`} className="rounded-md border border-dashed bg-card px-2.5 py-1.5">
                  <p className="truncate text-[11px] font-medium">{component.label ?? component.kind}</p>
                  <p className="text-[11px] tabular-nums text-muted-foreground">{money(component.amount)}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openLinkGift(anchor)}>Search and link gift</button>
                    <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openCreateGift(anchor, preview)}>Create gift</button>
                    <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openIdentify(anchor, preview)}>Identify donor</button>
                    {actions.isFinanceOrAdmin && actions.openDonorboxSearch ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openDonorboxSearch?.(anchor, preview)}>Donorbox lookup</button> : null}
                    {actions.canUseCodingForm && actions.openCodingFormLookup ? <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => actions.openCodingFormLookup?.(anchor, preview)}>Coding form</button> : null}
                  </div>
                </div>
              );
            }) : null}
        </span>
        <span><Accounting checks={deposit.accountingChecks} records={deposit.qbRecords} actions={actions} /></span>
      </div>
    </section>
  );
}
