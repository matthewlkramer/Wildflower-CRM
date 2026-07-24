import { ChevronDown, ChevronRight, CircleAlert, Landmark } from "lucide-react";
import type {
  WorkbenchDeposit,
  WorkbenchDepositAccountingCheck,
  WorkbenchDepositQbRecord,
  WorkbenchDepositLens,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import type { ClusterActions, AnchorRef } from "@/components/reconciliation-clusters/rows";
import type { EvidencePickOption, EvidencePreview } from "@/components/reconciliation-clusters/dialogs";

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

export interface DepositRowProps {
  deposit: WorkbenchDeposit;
  expanded: boolean;
  onToggle: () => void;
  actions?: ClusterActions;
}

const NOOP_ACTIONS: ClusterActions = {
  busy: false,
  openLinkGift: () => undefined,
  openCreateGift: () => undefined,
  openIdentify: () => undefined,
  openExclude: () => undefined,
  reInclude: () => undefined,
  openRevert: () => undefined,
  openConfirmRefund: () => undefined,
  openDismissRefund: () => undefined,
  openFlag: () => undefined,
  openFlagGift: () => undefined,
  openMarkLoss: () => undefined,
  openSettlementSearch: () => undefined,
  isFinanceOrAdmin: false,
  openQbDetail: () => undefined,
  rejectChargeQbTie: () => undefined,
  confirmProposedMatch: () => undefined,
  openMatchEvidence: () => undefined,
  unmatchPledge: () => undefined,
  openUnlinkChooser: () => undefined,
  openMergeGifts: () => undefined,
  confirmChargeProposal: () => undefined,
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

function Composition({ deposit }: { deposit: WorkbenchDeposit }) {
  const composition = deposit.composition;
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
      <div className="rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">Unresolved composition</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {money(composition.unexplainedAmount)} of the deposit has no known source.
        </p>
      </div>
    );
  }
  if (composition.kind === "stripe_payout") {
    const refundLines = deposit.charges.filter((charge) => charge.refunded || Number(charge.amountRefunded ?? 0) > 0 || charge.refundPropagationKind != null || charge.refundPropagationStatus === "proposed");
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
        </div>
        {deposit.charges.slice(0, 3).map((charge) => (
          <div key={charge.chargeId} className="flex items-center justify-between rounded border bg-card px-2 py-1 text-[11px]">
            <span className="truncate">{charge.payerName ?? charge.chargeId}</span>
            <span className="tabular-nums">{money(charge.amount)}</span>
          </div>
        ))}
        {deposit.charges.length > 3 ? (
          <p className="text-[10px] text-muted-foreground">+{deposit.charges.length - 3} more charges</p>
        ) : null}
        {refundLines.map((charge) => (
          <div key={`${charge.chargeId}-refund`} className="flex items-center justify-between rounded border border-rose-200 bg-rose-50/50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
            <span className="truncate">Refund · {charge.payerName ?? charge.chargeId}</span>
            <span className="tabular-nums">−{money(charge.amountRefunded ?? charge.refundProposedAmount)}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {composition.components.map((component) => (
        <div key={component.componentId} className="flex items-center justify-between rounded-md border bg-card px-2.5 py-1.5 text-[11px]">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {component.needsReview || component.ambiguousDepositMatch ? <CircleAlert className="h-3 w-3 shrink-0 text-amber-600" /> : null}
            <span className="font-medium">{component.kind.replace("_", " ")}</span>
            <span className="truncate text-muted-foreground">{component.paymentUnitId}</span>
          </span>
          <span className="tabular-nums">{money(component.amount)}</span>
        </div>
      ))}
      {!composition.components.length ? <span className="text-xs text-muted-foreground">No components</span> : null}
    </div>
  );
}

function accountingLabel(record: WorkbenchDepositAccountingCheck | WorkbenchDepositQbRecord): string {
  return record.qbTransactionMemo ?? ("memo" in record ? record.memo : null) ?? record.lineDescription ?? record.stagedPaymentId;
}

function Accounting({ checks, records }: { checks: WorkbenchDepositAccountingCheck[]; records: WorkbenchDepositQbRecord[] }) {
  const items = [...checks, ...records];
  if (!items.length) {
    return <span className="text-xs text-muted-foreground">No accounting check</span>;
  }
  return (
    <div className="space-y-1.5">
      {items.map((check) => (
        <div key={"id" in check ? check.id : check.stagedPaymentId} className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5">
          <span className="min-w-0">
            <span className="block truncate text-[11px]">{accountingLabel(check)}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {check.dateReceived ?? "Undated"} · {money(check.amount)} · {check.qbLocation ?? check.revenueLocation ?? "No location"} · {check.payerName ?? check.entityId ?? check.qbPayerType ?? "No entity"}
            </span>
          </span>
          {"disposition" in check ? (
            <Badge variant={checkTone(check.disposition)} className="shrink-0 text-[10px]">
              {check.disposition.replace("_", " ")}
            </Badge>
          ) : null}
        </div>
      ))}
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

export function DepositRow({ deposit, expanded, onToggle, actions: suppliedActions }: DepositRowProps) {
  const actions = suppliedActions ?? NOOP_ACTIONS;
  const isNotFundraising = deposit.lenses.includes("not_fundraising");
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
      <div onClick={onToggle} className={`${DEPOSIT_GRID} w-full cursor-pointer py-3 text-left transition-colors hover:bg-muted/30`}>
        <span className="pt-1 text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-semibold tabular-nums">
            {money(deposit.bank.amount)}
            {isNotFundraising ? <Badge variant="outline" className="text-[9px]">Not fundraising</Badge> : null}
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {deposit.date ? formatDateShort(deposit.date) : "Undated"} · {deposit.bank.account ?? "Wells Fargo"}
          </span>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">{deposit.bank.memo ?? deposit.bank.reference ?? deposit.anchorId}</span>
        </span>
        <span onClick={(event) => event.stopPropagation()}><Composition deposit={deposit} /></span>
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
        </span>
        <span onClick={(event) => event.stopPropagation()}><Accounting checks={deposit.accountingChecks} records={deposit.qbRecords} /></span>
      </div>
      {expanded ? (
        <div className="grid gap-3 border-t bg-muted/20 px-4 py-3 lg:grid-cols-3">
          <div className="rounded-md border bg-card p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Deposit detail</p>
            <p className="mt-1 text-xs">{deposit.bank.reference ?? "No bank reference"}</p>
            <p className="text-[11px] text-muted-foreground">{deposit.id}</p>
          </div>
          <div className="rounded-md border bg-card p-3 lg:col-span-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Resolution actions</p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {deposit.charges.map((charge) => {
                const anchor: AnchorRef = { kind: "charge", id: charge.chargeId, label: charge.payerName ?? charge.chargeId };
                return (
                  <div key={charge.chargeId} className="rounded border bg-card px-2.5 py-2 text-xs">
                    <p className="font-semibold">{charge.payerName ?? charge.chargeId}</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {!charge.linkedGiftId ? <><button type="button" className="text-primary hover:underline" onClick={() => actions.openLinkGift(anchor)}>Link gift</button><button type="button" className="text-primary hover:underline" onClick={() => actions.openCreateGift(anchor, chargePreview(charge))}>Create gift</button><button type="button" className="text-primary hover:underline" onClick={() => actions.openIdentify(anchor, chargePreview(charge))}>Identify donor</button></> : <button type="button" className="text-destructive hover:underline" onClick={() => actions.openRevert(anchor, `Unlink ${anchor.label} from its gift.`)}>Unlink</button>}
                      <button type="button" className="text-muted-foreground hover:underline" onClick={() => actions.openExclude(anchor)}>Exclude</button>
                      {charge.refundKind ? <><button type="button" className="text-destructive hover:underline" onClick={() => actions.openConfirmRefund(charge.chargeId, charge.refundKind === "chargeback" ? "chargeback" : "refund", anchor.label)}>Confirm refund</button><button type="button" className="text-muted-foreground hover:underline" onClick={() => actions.openDismissRefund(charge.chargeId, anchor.label)}>Dismiss refund</button></> : null}
                      <button type="button" className="text-muted-foreground hover:underline" onClick={() => actions.reInclude(anchor)}>Re-include</button>
                    </div>
                  </div>
                );
              })}
              {deposit.qbRecords.map((record) => {
                const anchor: AnchorRef = { kind: "staged", id: record.stagedPaymentId, label: record.lineDescription ?? record.reference ?? record.stagedPaymentId };
                return (
                  <div key={record.stagedPaymentId} className="rounded border bg-card px-2.5 py-2 text-xs">
                    <p className="font-semibold">{anchor.label}</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button type="button" className="text-primary hover:underline" onClick={() => actions.openLinkGift(anchor)}>Link gift</button>
                      <button type="button" className="text-primary hover:underline" onClick={() => actions.openCreateGift(anchor, qbPreview(record))}>Create gift</button>
                      {actions.isFinanceOrAdmin ? <button type="button" className="text-primary hover:underline" onClick={() => actions.openQbDetail(record, "missing")}>QB detail</button> : null}
                      <button type="button" className="text-muted-foreground hover:underline" onClick={() => actions.openExclude(anchor)}>Exclude</button>
                    </div>
                  </div>
                );
              })}
              {deposit.composition.payoutId && actions.isFinanceOrAdmin ? <button type="button" className="rounded border px-2 py-1 text-xs text-primary hover:bg-muted" onClick={() => actions.openSettlementSearch({ payoutId: deposit.composition.payoutId!, amount: deposit.bank.amount, date: deposit.date ?? null })}>Resolve payout settlement</button> : null}
            </div>
          </div>
          <div className="rounded-md border bg-card p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Payment units</p>
            <p className="mt-1 text-xs">{deposit.composition.units?.length ?? 0} unit{(deposit.composition.units?.length ?? 0) === 1 ? "" : "s"} · {deposit.gifts.length} gift{deposit.gifts.length === 1 ? "" : "s"}</p>
          </div>
          <div className="rounded-md border bg-card p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">State</p>
            <p className="mt-1 text-xs">{deposit.status}</p>
            <p className="text-[11px] text-muted-foreground">{deposit.lenses.join(" · ")}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
