import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getListWorkbenchDepositsQueryKey,
  getListWorkbenchRecentChangesQueryKey,
  getGetGiftOrPaymentQueryKey,
  getGetGiftOrPaymentQueryOptions,
  useConfirmSettlementLink,
  useConfirmStripeRefundPropagation,
  useCreateGiftFromStagedPayment,
  useCreateGiftFromStripeStagedCharge,
  useDismissStripeRefundPropagation,
  useExcludeStagedPayment,
  useExcludeStripeStagedCharge,
  useGetCurrentUser,
  useLinkStripeChargeToGift,
  useReconcileStagedPayment,
  useResolveStagedPayment,
  useResolveStripeStagedCharge,
  useListWorkbenchDeposits,
  useListWorkbenchRecentChanges,
  useReIncludeStagedPayment,
  useReIncludeStripeStagedCharge,
  useRevertStagedPayment,
  useRevertStripeStagedCharge,
  type GiftOrPayment,
  type GiftOrPaymentDetail,
  type StagedPaymentExclusionReason,
  type WorkbenchClusterQbRecord,
  type WorkbenchDepositLens,
  type WorkbenchRecentChange,
} from "@workspace/api-client-react";
import { DepositGridHeader, DepositRow, DEPOSIT_LENSES } from "@/components/reconciliation-deposits/rows";
import { GiftSearchDialog } from "@/components/gift-search-dialog";
import { MergeGiftsDialog } from "@/components/gift-merge-dialogs";
import { ResolveTieDialog, type PickOptions } from "@/components/reconciliation-bundles/ResolveTieDialog";
import { DonorResolveDialog, EvidenceChooserDialog, ExcludeReasonDialog, QbRecordDetailDialog, UnlinkChooserDialog, type EvidencePickOption, type EvidencePreview, type UnlinkOption } from "@/components/reconciliation-clusters/dialogs";
import type { AnchorRef, ClusterActions } from "@/components/reconciliation-clusters/rows";
import type { DonorType } from "@/components/entity-picker";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const PAGE_SIZE = 25;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function ReconciliationDepositsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [lens, setLens] = useState<WorkbenchDepositLens>("all_open");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = useMemo(() => ({ lens, ...(q ? { q } : {}), limit: PAGE_SIZE, page }), [lens, q, page]);
  const { data, isLoading, isError } = useListWorkbenchDeposits(params);
  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges();
  const { data: me } = useGetCurrentUser();
  const reIncludeStaged = useReIncludeStagedPayment();
  const reIncludeCharge = useReIncludeStripeStagedCharge();
  const revertStaged = useRevertStagedPayment();
  const revertCharge = useRevertStripeStagedCharge();
  const linkCharge = useLinkStripeChargeToGift();
  const resolveCharge = useResolveStripeStagedCharge();
  const createChargeGift = useCreateGiftFromStripeStagedCharge();
  const resolveStaged = useResolveStagedPayment();
  const createStagedGift = useCreateGiftFromStagedPayment();
  const reconcileStaged = useReconcileStagedPayment();
  const excludeCharge = useExcludeStripeStagedCharge();
  const excludeStaged = useExcludeStagedPayment();
  const confirmRefund = useConfirmStripeRefundPropagation();
  const dismissRefund = useDismissStripeRefundPropagation();
  const confirmSettlement = useConfirmSettlementLink();
  const deposits = data?.data ?? [];
  const canManageAccounting = data?.viewerCanManageAccounting ?? false;
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [linkGiftFor, setLinkGiftFor] = useState<AnchorRef | null>(null);
  const [createFor, setCreateFor] = useState<{ anchor: AnchorRef; preview: EvidencePreview } | null>(null);
  const [identifyFor, setIdentifyFor] = useState<{ anchor: AnchorRef; preview: EvidencePreview } | null>(null);
  const [excludeFor, setExcludeFor] = useState<AnchorRef | null>(null);
  const [revertFor, setRevertFor] = useState<{ anchor: AnchorRef; description: string } | null>(null);
  const [matchEvidenceFor, setMatchEvidenceFor] = useState<{ giftId: string; giftLabel: string; options: EvidencePickOption[] } | null>(null);
  const [unlinkChooserFor, setUnlinkChooserFor] = useState<{ giftLabel: string; options: UnlinkOption[] } | null>(null);
  const [refundFor, setRefundFor] = useState<{ chargeId: string; kind: "refund" | "chargeback"; label: string } | null>(null);
  const [dismissFor, setDismissFor] = useState<{ chargeId: string; label: string } | null>(null);
  const [settlementSearchFor, setSettlementSearchFor] = useState<{ payoutId: string; amount: string | null; date: string | null } | null>(null);
  const [qbDetailFor, setQbDetailFor] = useState<{ record: WorkbenchClusterQbRecord; linkage: string } | null>(null);
  const [mergeGiftIds, setMergeGiftIds] = useState<string[]>([]);
  const mergeQueries = useQueries({ queries: mergeGiftIds.map((id) => getGetGiftOrPaymentQueryOptions(id, { query: { enabled: mergeGiftIds.length > 0, queryKey: getGetGiftOrPaymentQueryKey(id) } })) });
  const mergeRecords = useMemo<GiftOrPaymentDetail[]>(() => mergeQueries.map((query) => query.data).filter((record): record is GiftOrPaymentDetail => !!record), [mergeQueries]);
  const busy = reIncludeStaged.isPending || reIncludeCharge.isPending || revertStaged.isPending || revertCharge.isPending || linkCharge.isPending || resolveCharge.isPending || createChargeGift.isPending || resolveStaged.isPending || createStagedGift.isPending || reconcileStaged.isPending || excludeCharge.isPending || excludeStaged.isPending || confirmRefund.isPending || dismissRefund.isPending || confirmSettlement.isPending;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getListWorkbenchDepositsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListWorkbenchRecentChangesQueryKey() });
  };

  const donorBody = (type: DonorType, id: string) => ({ organizationId: type === "organization" ? id : null, individualGiverPersonId: type === "individual" ? id : null, householdId: type === "household" ? id : null });
  const handlePickGift = async (gift: GiftOrPayment) => {
    if (!linkGiftFor) return;
    if (linkGiftFor.kind === "charge") await linkCharge.mutateAsync({ id: linkGiftFor.id, data: { giftId: gift.id } });
    else await reconcileStaged.mutateAsync({ id: linkGiftFor.id, data: { giftId: gift.id } });
    setLinkGiftFor(null); invalidate();
  };
  const handleDonor = async (type: DonorType, id: string, create: boolean) => {
    const target = create ? createFor : identifyFor;
    if (!target) return;
    const body = donorBody(type, id);
    if (target.anchor.kind === "charge") {
      await resolveCharge.mutateAsync({ id: target.anchor.id, data: body });
      if (create) await createChargeGift.mutateAsync({ id: target.anchor.id });
    } else {
      await resolveStaged.mutateAsync({ id: target.anchor.id, data: body });
      if (create) await createStagedGift.mutateAsync({ id: target.anchor.id });
    }
    setCreateFor(null); setIdentifyFor(null); invalidate();
  };
  const handleExclude = async (reason: StagedPaymentExclusionReason) => {
    if (!excludeFor) return;
    if (excludeFor.kind === "charge") await excludeCharge.mutateAsync({ id: excludeFor.id, data: { exclusionReason: reason } });
    else await excludeStaged.mutateAsync({ id: excludeFor.id, data: { exclusionReason: reason } });
    setExcludeFor(null); invalidate();
  };
  const handleRevert = async () => {
    if (!revertFor) return;
    if (revertFor.anchor.kind === "charge") await revertCharge.mutateAsync({ id: revertFor.anchor.id });
    else await revertStaged.mutateAsync({ id: revertFor.anchor.id });
    setRevertFor(null); invalidate();
  };
  const actions: ClusterActions = {
    busy,
    openLinkGift: setLinkGiftFor,
    openCreateGift: (anchor, preview) => setCreateFor({ anchor, preview }),
    openIdentify: (anchor, preview) => setIdentifyFor({ anchor, preview: preview ?? { amount: "—", date: "—", method: "Payment", source: anchor.label, memo: null } }),
    openExclude: setExcludeFor,
    reInclude: (anchor) => void (anchor.kind === "charge" ? reIncludeCharge.mutateAsync({ id: anchor.id }) : reIncludeStaged.mutateAsync({ id: anchor.id })).finally(invalidate),
    openRevert: (anchor, description) => setRevertFor({ anchor, description }),
    openConfirmRefund: (chargeId, kind, label) => setRefundFor({ chargeId, kind, label }),
    openDismissRefund: (chargeId, label) => setDismissFor({ chargeId, label }),
    openFlag: () => undefined,
    openFlagGift: () => undefined,
    openMarkLoss: () => undefined,
    openSettlementSearch: setSettlementSearchFor,
    isFinanceOrAdmin: canManageAccounting && (me?.role === "finance" || me?.role === "admin"),
    openQbDetail: (record, linkage) => setQbDetailFor({ record, linkage }),
    rejectChargeQbTie: () => undefined,
    confirmProposedMatch: () => undefined,
    openMatchEvidence: (giftId, giftLabel, options) => setMatchEvidenceFor({ giftId, giftLabel, options }),
    unmatchPledge: () => undefined,
    openUnlinkChooser: (giftLabel, options) => setUnlinkChooserFor({ giftLabel, options }),
    openMergeGifts: setMergeGiftIds,
    confirmChargeProposal: () => undefined,
  };

  const handleUndo = async (change: WorkbenchRecentChange) => {
    if (!change.undo) return;
    try {
      if (change.undo.kind === "revert_staged_payment") await revertStaged.mutateAsync({ id: change.undo.targetId });
      else if (change.undo.kind === "reinclude_staged_payment") await reIncludeStaged.mutateAsync({ id: change.undo.targetId });
      else if (change.undo.kind === "revert_stripe_charge") await revertCharge.mutateAsync({ id: change.undo.targetId });
      else await reIncludeCharge.mutateAsync({ id: change.undo.targetId });
      toast({ title: "Undone", description: "The reconciliation action was reversed." });
    } catch {
      toast({ title: "Couldn't undo", description: "The row changed or the action is no longer reversible.", variant: "destructive" });
    } finally {
      invalidate();
    }
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">Wells Fargo deposit ledger</p>
        <h1 className="mt-1 text-3xl font-serif font-bold text-foreground">Reconciliation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          One row per bank deposit, with the known composition, CRM gifts, and accounting evidence kept together.
        </p>
      </div>
      <div className="flex items-start gap-4">
        <main className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search memo, deposit, unit, or gift…" className="pl-8" data-testid="input-deposit-search" />
            </div>
            {!isLoading && !isError ? <span className="ml-auto text-sm text-muted-foreground" data-testid="text-deposit-total">{total.toLocaleString()} deposits</span> : null}
          </div>
          {isLoading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading deposits…</p> : isError ? <p className="py-8 text-center text-sm text-destructive">Failed to load the deposit list.</p> : deposits.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{q ? "No deposits match this search." : "Nothing in this lens right now."}</p> : (
            <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
              <DepositGridHeader />
              {deposits.map((deposit) => <DepositRow key={deposit.id} deposit={deposit} actions={actions} expanded={expanded.has(deposit.id)} onToggle={() => toggleExpanded(deposit.id)} />)}
            </div>
          )}
          {totalPages > 1 ? <div className="flex items-center justify-center gap-3 pt-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="h-4 w-4" /> Previous</Button>
            <span className="text-sm tabular-nums text-muted-foreground">Page {page} of {totalPages.toLocaleString()}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next <ChevronRight className="h-4 w-4" /></Button>
          </div> : null}
        </main>
        <aside className="sticky top-4 hidden w-60 shrink-0 space-y-3 lg:block">
          <div className="rounded-lg border bg-card p-3">
            <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Deposit lenses</h2>
            <nav className="space-y-0.5" data-testid="deposit-lens-rail">
              {DEPOSIT_LENSES.map((item) => <button key={item.id} type="button" onClick={() => { setLens(item.id); setPage(1); }} className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-medium ${lens === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`} data-testid={`button-deposit-lens-${item.id}`}><span>{item.label}</span><span className="tabular-nums">{data?.lensCounts[item.id] ?? "—"}</span></button>)}
            </nav>
          </div>
          <div className="rounded-lg border bg-card p-3" data-testid="deposit-recent-changes-rail">
            <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Recent changes</h2>
            {recentLoading ? <p className="text-[11px] text-muted-foreground">Loading…</p> : !recentData?.items.length ? <p className="text-[11px] text-muted-foreground">No reconciliation actions recorded yet.</p> : <ul className="max-h-80 space-y-2 overflow-y-auto pr-0.5">{recentData.items.map((change) => <li key={change.id} className="text-[11px] leading-snug" data-testid={`deposit-recent-change-${change.id}`}><p>{change.summary}</p><div className="mt-0.5 flex items-center justify-between gap-2"><span className="truncate text-muted-foreground">{change.actorName ?? "System"} · {formatWhen(change.at)}</span>{change.undo ? <Button variant="ghost" size="sm" className="h-5 shrink-0 px-1.5 text-[10px]" disabled={busy} onClick={() => void handleUndo(change)} data-testid={`deposit-button-undo-${change.id}`}>Undo</Button> : <span className="shrink-0 text-[10px] text-muted-foreground/50">No undo</span>}</div></li>)}</ul>}
          </div>
        </aside>
      </div>
      <GiftSearchDialog
        open={linkGiftFor != null}
        onOpenChange={(open) => { if (!open) setLinkGiftFor(null); }}
        onPick={(gift) => void handlePickGift(gift)}
        busy={busy}
        title="Link to an existing gift"
        description={linkGiftFor ? `Pick the CRM donation record that ${linkGiftFor.label} pays.` : undefined}
      />
      <EvidenceChooserDialog
        open={matchEvidenceFor != null}
        onOpenChange={(open) => { if (!open) setMatchEvidenceFor(null); }}
        giftLabel={matchEvidenceFor?.giftLabel ?? "this gift"}
        options={matchEvidenceFor?.options ?? []}
        busy={busy}
        onPick={(option) => {
          if (!matchEvidenceFor) return;
          const anchor = option.anchor;
          void (anchor.kind === "charge"
            ? linkCharge.mutateAsync({ id: anchor.id, data: { giftId: matchEvidenceFor.giftId } })
            : reconcileStaged.mutateAsync({ id: anchor.id, data: { giftId: matchEvidenceFor.giftId } }))
            .then(() => { setMatchEvidenceFor(null); invalidate(); });
        }}
      />
      <UnlinkChooserDialog
        open={unlinkChooserFor != null}
        onOpenChange={(open) => { if (!open) setUnlinkChooserFor(null); }}
        giftLabel={unlinkChooserFor?.giftLabel ?? ""}
        options={unlinkChooserFor?.options ?? []}
        busy={busy}
        onPick={(option) => {
          const label = unlinkChooserFor?.giftLabel ?? "this gift";
          setUnlinkChooserFor(null);
          setRevertFor({ anchor: option.anchor, description: `Unlink “${label}” from ${option.source}.` });
        }}
      />
      <DonorResolveDialog open={createFor != null} onOpenChange={(open) => { if (!open) setCreateFor(null); }} mode="create" recordLabel={createFor?.anchor.label ?? ""} preview={createFor?.preview ?? null} busy={busy} onSubmit={(type, id) => void handleDonor(type, id, true)} />
      <DonorResolveDialog open={identifyFor != null} onOpenChange={(open) => { if (!open) setIdentifyFor(null); }} mode="identify" recordLabel={identifyFor?.anchor.label ?? ""} preview={identifyFor?.preview ?? null} busy={busy} onSubmit={(type, id) => void handleDonor(type, id, false)} />
      <ExcludeReasonDialog open={excludeFor != null} onOpenChange={(open) => { if (!open) setExcludeFor(null); }} recordLabel={excludeFor?.label ?? "this record"} busy={busy} onSubmit={(reason) => void handleExclude(reason)} />
      <AlertDialog open={revertFor != null} onOpenChange={(open) => { if (!open && !busy) setRevertFor(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Unlink this match?</AlertDialogTitle><AlertDialogDescription>{revertFor?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => void handleRevert()}>Unlink</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={refundFor != null} onOpenChange={(open) => { if (!open && !busy) setRefundFor(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Confirm {refundFor?.kind === "chargeback" ? "chargeback" : "refund"}?</AlertDialogTitle><AlertDialogDescription>This removes the transaction from live payment evidence without changing the gift.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (!refundFor) return; void confirmRefund.mutateAsync({ id: refundFor.chargeId }).then(() => { setRefundFor(null); invalidate(); }); }}>Confirm</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={dismissFor != null} onOpenChange={(open) => { if (!open && !busy) setDismissFor(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Dismiss reversal proposal?</AlertDialogTitle><AlertDialogDescription>{dismissFor?.label} stays booked.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (!dismissFor) return; void dismissRefund.mutateAsync({ id: dismissFor.chargeId }).then(() => { setDismissFor(null); invalidate(); }); }}>Dismiss</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      {settlementSearchFor ? <ResolveTieDialog anchor={{ anchorId: settlementSearchFor.payoutId, amount: settlementSearchFor.amount, date: settlementSearchFor.date }} open onOpenChange={(open) => { if (!open) setSettlementSearchFor(null); }} onPick={(id, options: PickOptions) => { if (!settlementSearchFor) return; void confirmSettlement.mutateAsync({ payoutId: settlementSearchFor.payoutId, data: { depositStagedPaymentId: id, ...(options?.overrideExclusion ? { overrideExclusion: true } : {}) } }).then(() => { setSettlementSearchFor(null); invalidate(); }); }} busy={busy} /> : null}
      <QbRecordDetailDialog open={qbDetailFor != null} onOpenChange={(open) => { if (!open) setQbDetailFor(null); }} record={qbDetailFor?.record ?? null} linkage={qbDetailFor?.linkage ?? null} />
      <MergeGiftsDialog open={mergeGiftIds.length > 0} onOpenChange={(open) => { if (!open) setMergeGiftIds([]); }} gifts={mergeRecords} expectedCount={mergeGiftIds.length} loadError={mergeQueries.some((query) => query.isError)} onDone={() => { setMergeGiftIds([]); invalidate(); }} />
    </div>
  );
}
