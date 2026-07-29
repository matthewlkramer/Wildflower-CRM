import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getListWorkbenchDepositsQueryKey,
  getListWorkbenchRecentChangesQueryKey,
  getListDepositCandidatePayoutsQueryKey,
  getListDepositCandidatePaymentUnitsQueryKey,
  getListPayoutCandidateDepositsQueryKey,
  getGetGiftOrPaymentQueryKey,
  getGetGiftOrPaymentQueryOptions,
  getGetReconciliationGraphQueryOptions,
  getListCodingFormRowsQueryKey,
  getListDonorboxReviewQueryKey,
  useConfirmSettlementLink,
  useConfirmStagedPaymentMatch,
  useApproveReconciliationCard,
  useSetQboAccountingCheckDisposition,
  useConfirmPayoutChargeTies,
  useConfirmDepositQboComponent,
  useConfirmStripeRefundPropagation,
  useCreateGiftFromStagedPayment,
  useCreateGiftFromStripeStagedCharge,
  useCreateGiftFromDonorboxDonation,
  useDismissStripeRefundPropagation,
  useDismissDepositQboComponent,
  useExcludeStagedPayment,
  useExcludeBankDepositComponent,
  useExcludeStripeStagedCharge,
  useGetCurrentUser,
  useLinkStripeChargeToGift,
  useRejectChargeQbTie,
  useReconcileStagedPayment,
  useResolveStagedPayment,
  useResolveStripeStagedCharge,
  useListWorkbenchDeposits,
  useListWorkbenchRecentChanges,
  useListCodingFormRows,
  useListDonorboxReview,
  useListDepositCandidatePayouts,
  useLinkPayoutDeposit,
  useLinkDonorboxDonationToGift,
  useUnlinkPayoutDeposit,
  useConfirmPayoutBankMatch,
  useSetBankDepositExclusion,
  useClearBankDepositExclusion,
  useListDepositCandidatePaymentUnits,
  useAddBankDepositComponent,
  useRemoveManualBankDepositComponent,
  useSetBankDepositComponentSourceStagedPayment,
  useAttachDepositQboEvidence,
  useFlagQboAccountingError,
  DepositExclusionReason,
  type BankDepositExclusion,
  useListPayoutCandidateDeposits,
  type DepositCandidatePayout,
  type DepositCandidatePaymentUnit,
  type PayoutCandidateDeposit,
  useReIncludeStagedPayment,
  useReIncludeBankDepositComponent,
  useReIncludeStripeStagedCharge,
  useRevertStagedPayment,
  useRevertStripeStagedCharge,
  type GiftOrPayment,
  type GiftOrPaymentDetail,
  type CodingFormRow,
  type DonorboxReviewRow,
  type StagedPaymentExclusionReason,
  type WorkbenchClusterQbRecord,
  type PayoutChargeSummary,
  type WorkbenchDeposit,
  type WorkbenchDepositNodeQbRecord,
  type WorkbenchDepositQbRecord,
  type WorkbenchDepositCompositionComponentsItem,
  type WorkbenchDepositLens,
  type WorkbenchRecentChange,
  type MintGiftOverridesBody,
  type OpportunityOrPledge,
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import {
  DepositGridHeader,
  DepositRow,
  DEPOSIT_LENSES,
  type DepositActions,
} from "@/components/reconciliation-deposits/rows";
import { GiftSearchDialog } from "@/components/gift-search-dialog";
import { MergeGiftsDialog } from "@/components/gift-merge-dialogs";
import {
  ResolveTieDialog,
  type PickOptions,
} from "@/components/reconciliation-bundles/ResolveTieDialog";
import {
  CodingFormLookupDialog,
  DonorboxSearchDialog,
  DonorResolveDialog,
  ExcludeReasonDialog,
  QbRecordDetailDialog,
  UnlinkChooserDialog,
  type EvidencePreview,
  type UnlinkOption,
} from "@/components/reconciliation-clusters/dialogs";
import { TieChargeQbDialog } from "@/components/reconciliation-bundles/TieChargeQbDialog";
import {
  CreateStandaloneGiftDialog,
  LinkEvidenceSearchDialog,
} from "@/components/reconciliation-deposits/gift-column-dialogs";
import type {
  AnchorRef,
  CreateGiftPrefill,
} from "@/components/reconciliation-clusters/actions";
import type { DonorType } from "@/components/entity-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  apiErrorMessage,
  is409,
} from "@/components/reconciliation-bundles/settlement-actions";
import {
  deriveApproveBody,
  deriveApproveBodyFromProposal,
  hasAmountBlocker,
  type OutcomeChoice,
} from "@/lib/reconciliation";

type CandidatePaymentUnitWithClaim = DepositCandidatePaymentUnit & {
  claimed?: boolean;
  claimedComponentId?: string | null;
  claimedBankDepositId?: string | null;
  claimedComponentAmount?: string | null;
  claimedDepositDate?: string | null;
  claimedDepositAmount?: string | null;
  claimedDepositMemo?: string | null;
  claimedByCurrentDeposit?: boolean;
};

const PAGE_SIZE = 25;
const DEPOSIT_EXCLUSION_REASONS = Object.values(DepositExclusionReason);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ReconciliationDepositsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [lens, setLens] = useState<WorkbenchDepositLens>("all_open");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = useMemo(
    () => ({ lens, ...(q ? { q } : {}), limit: PAGE_SIZE, page }),
    [lens, q, page],
  );
  const { data, isLoading, isError } = useListWorkbenchDeposits(params);
  const { data: recentData, isLoading: recentLoading } =
    useListWorkbenchRecentChanges();
  useEffect(() => {
    const refreshRecent = () => {
      void queryClient.invalidateQueries({
        queryKey: getListWorkbenchRecentChangesQueryKey(),
      });
    };
    const timer = window.setInterval(refreshRecent, 5000);
    window.addEventListener("focus", refreshRecent);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshRecent);
    };
  }, [queryClient]);
  const { data: me } = useGetCurrentUser();
  const reIncludeStaged = useReIncludeStagedPayment();
  const excludeComponent = useExcludeBankDepositComponent();
  const reIncludeComponent = useReIncludeBankDepositComponent();
  const reIncludeCharge = useReIncludeStripeStagedCharge();
  const revertStaged = useRevertStagedPayment();
  const revertCharge = useRevertStripeStagedCharge();
  const linkCharge = useLinkStripeChargeToGift();
  const resolveCharge = useResolveStripeStagedCharge();
  const createChargeGift = useCreateGiftFromStripeStagedCharge();
  const linkDonorbox = useLinkDonorboxDonationToGift();
  const createDonorboxGift = useCreateGiftFromDonorboxDonation();
  const resolveStaged = useResolveStagedPayment();
  const createStagedGift = useCreateGiftFromStagedPayment();
  const reconcileStaged = useReconcileStagedPayment();
  const excludeCharge = useExcludeStripeStagedCharge();
  const excludeStaged = useExcludeStagedPayment();
  const confirmRefund = useConfirmStripeRefundPropagation();
  const dismissRefund = useDismissStripeRefundPropagation();
  const confirmSettlement = useConfirmSettlementLink();
  const confirmChargeTies = useConfirmPayoutChargeTies();
  const confirmDepositQbo = useConfirmDepositQboComponent();
  const dismissDepositQbo = useDismissDepositQboComponent();
  const linkPayout = useLinkPayoutDeposit();
  const unlinkPayout = useUnlinkPayoutDeposit();
  const confirmPayoutBankMatch = useConfirmPayoutBankMatch();
  const setBankDepositExclusion = useSetBankDepositExclusion();
  const clearBankDepositExclusion = useClearBankDepositExclusion();
  const confirmMatch = useConfirmStagedPaymentMatch();
  const rejectChargeQbTie = useRejectChargeQbTie();
  const approveCard = useApproveReconciliationCard();
  const setAccountingDisposition = useSetQboAccountingCheckDisposition();
  const deposits = data?.data ?? [];
  const canManageAccounting = data?.viewerCanManageAccounting ?? false;
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [linkGiftFor, setLinkGiftFor] = useState<AnchorRef | null>(null);
  const [donorboxFor, setDonorboxFor] = useState<{
    anchor: AnchorRef;
    preview: EvidencePreview;
  } | null>(null);
  const [donorboxSearch, setDonorboxSearch] = useState("");
  const [donorboxLinkRow, setDonorboxLinkRow] =
    useState<DonorboxReviewRow | null>(null);
  const [codingFormFor, setCodingFormFor] = useState<{
    anchor: AnchorRef;
    preview: EvidencePreview;
  } | null>(null);
  const [codingHint, setCodingHint] = useState<CodingFormRow | null>(null);
  const [createFor, setCreateFor] = useState<{
    anchor: AnchorRef;
    preview: EvidencePreview;
    prefill: CreateGiftPrefill | null;
  } | null>(null);
  const [linkEvidenceFor, setLinkEvidenceFor] = useState<{
    anchor: AnchorRef;
    mode: "all" | "pledges";
  } | null>(null);
  const [oppOutcomeFor, setOppOutcomeFor] =
    useState<OpportunityOrPledge | null>(null);
  const [identifyFor, setIdentifyFor] = useState<{
    anchor: AnchorRef;
    preview: EvidencePreview;
  } | null>(null);
  const [excludeFor, setExcludeFor] = useState<AnchorRef | null>(null);
  const [revertFor, setRevertFor] = useState<{
    anchor: AnchorRef;
    description: string;
  } | null>(null);
  const [unlinkChooserFor, setUnlinkChooserFor] = useState<{
    giftLabel: string;
    options: UnlinkOption[];
  } | null>(null);
  const [refundFor, setRefundFor] = useState<{
    chargeId: string;
    kind: "refund" | "chargeback";
    label: string;
  } | null>(null);
  const [dismissFor, setDismissFor] = useState<{
    chargeId: string;
    label: string;
  } | null>(null);
  const [settlementSearchFor, setSettlementSearchFor] = useState<{
    payoutId: string;
    amount: string | null;
    date: string | null;
  } | null>(null);
  const [linkPayoutFor, setLinkPayoutFor] = useState<string | null>(null);
  const [unlinkPayoutFor, setUnlinkPayoutFor] = useState<string | null>(null);
  const [confirmPayoutFor, setConfirmPayoutFor] = useState<string | null>(null);
  const [payoutCandidateFor, setPayoutCandidateFor] = useState<string | null>(
    null,
  );
  const [bankExclusionFor, setBankExclusionFor] = useState<{
    depositId: string;
    existing: BankDepositExclusion | null;
  } | null>(null);
  const [bankExclusionReason, setBankExclusionReason] =
    useState<DepositExclusionReason>("other");
  const [bankExclusionNote, setBankExclusionNote] = useState("");
  const [accountingDispositionFor, setAccountingDispositionFor] = useState<{
    checkId: string;
    disposition: "corrected" | "accepted_historical";
  } | null>(null);
  const [accountingDispositionNote, setAccountingDispositionNote] =
    useState("");
  const [knownPaymentFor, setKnownPaymentFor] = useState<{
    depositId: string;
    remainder: string;
  } | null>(null);
  const [knownPaymentMode, setKnownPaymentMode] = useState<"search" | "create">(
    "search",
  );
  const [knownPaymentSearch, setKnownPaymentSearch] = useState("");
  const [knownPaymentFilterAmount, setKnownPaymentFilterAmount] = useState("");
  const [knownPaymentFilterDate, setKnownPaymentFilterDate] = useState("");
  const [knownPaymentAmount, setKnownPaymentAmount] = useState("");
  const [knownPaymentKind, setKnownPaymentKind] = useState<
    "check" | "direct_ach" | "wire" | "other"
  >("check");
  const [knownPaymentDate, setKnownPaymentDate] = useState("");
  const [manualComponentFor, setManualComponentFor] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [tieChargeFor, setTieChargeFor] = useState<{
    payoutId: string;
    charge: PayoutChargeSummary;
  } | null>(null);
  const [componentQbFor, setComponentQbFor] = useState<{
    id: string;
    charge: PayoutChargeSummary;
  } | null>(null);
  const [clearComponentQbFor, setClearComponentQbFor] = useState<string | null>(
    null,
  );
  const [singlePaymentFor, setSinglePaymentFor] = useState<{
    depositId: string;
    amount: string;
  } | null>(null);
  const [qbEvidenceFor, setQbEvidenceFor] = useState<WorkbenchDeposit | null>(
    null,
  );
  const [flagErrorFor, setFlagErrorFor] = useState<WorkbenchDeposit | null>(
    null,
  );
  const [flagErrorStagedId, setFlagErrorStagedId] = useState<string>("");
  const [flagErrorNote, setFlagErrorNote] = useState("");
  const donorboxParams = {
    queue: "needs_review" as const,
    search: donorboxSearch.trim() || undefined,
    limit: 25,
    page: 1,
  };
  const donorboxRows = useListDonorboxReview(donorboxParams, {
    query: {
      enabled: donorboxFor != null,
      queryKey: getListDonorboxReviewQueryKey(donorboxParams),
    },
  });
  const codingFormParams = { status: "pending" as const, limit: 500, page: 1 };
  const codingFormRows = useListCodingFormRows(codingFormParams, {
    query: {
      enabled:
        codingFormFor != null && canManageAccounting && me?.role === "admin",
      queryKey: getListCodingFormRowsQueryKey(codingFormParams),
    },
  });
  const candidatePayouts = useListDepositCandidatePayouts(linkPayoutFor ?? "", {
    query: {
      enabled: linkPayoutFor != null,
      queryKey: getListDepositCandidatePayoutsQueryKey(linkPayoutFor ?? ""),
    },
  });
  const candidateDeposits = useListPayoutCandidateDeposits(
    payoutCandidateFor ?? "",
    {
      query: {
        enabled: payoutCandidateFor != null,
        queryKey: getListPayoutCandidateDepositsQueryKey(
          payoutCandidateFor ?? "",
        ),
      },
    },
  );
  const candidatePaymentUnits = useListDepositCandidatePaymentUnits(
    knownPaymentFor?.depositId ?? "",
    {
      amount: knownPaymentFor?.remainder,
      q: knownPaymentSearch.trim() || undefined,
      filterAmount: knownPaymentFilterAmount.trim() || undefined,
      filterDate: knownPaymentFilterDate || undefined,
      limit: 100,
    },
    {
      query: {
        enabled: knownPaymentFor != null && knownPaymentMode === "search",
        queryKey: getListDepositCandidatePaymentUnitsQueryKey(
          knownPaymentFor?.depositId ?? "",
          {
            amount: knownPaymentFor?.remainder,
            q: knownPaymentSearch.trim() || undefined,
            filterAmount: knownPaymentFilterAmount.trim() || undefined,
            filterDate: knownPaymentFilterDate || undefined,
            limit: 100,
          },
        ),
      },
    },
  );
  const [qbDetailFor, setQbDetailFor] = useState<{
    record: WorkbenchClusterQbRecord;
    linkage: string;
  } | null>(null);
  const [mergeGiftIds, setMergeGiftIds] = useState<string[]>([]);
  const mergeQueries = useQueries({
    queries: mergeGiftIds.map((id) =>
      getGetGiftOrPaymentQueryOptions(id, {
        query: {
          enabled: mergeGiftIds.length > 0,
          queryKey: getGetGiftOrPaymentQueryKey(id),
        },
      }),
    ),
  });
  const mergeRecords = useMemo<GiftOrPaymentDetail[]>(
    () =>
      mergeQueries
        .map((query) => query.data)
        .filter((record): record is GiftOrPaymentDetail => !!record),
    [mergeQueries],
  );
  const addBankComponent = useAddBankDepositComponent();
  const removeManualComponent = useRemoveManualBankDepositComponent();
  const setComponentQbSource = useSetBankDepositComponentSourceStagedPayment();
  const attachQboEvidence = useAttachDepositQboEvidence();
  const flagAccountingError = useFlagQboAccountingError();
  const busy =
    reIncludeStaged.isPending ||
    reIncludeCharge.isPending ||
    excludeComponent.isPending ||
    reIncludeComponent.isPending ||
    revertStaged.isPending ||
    revertCharge.isPending ||
    linkCharge.isPending ||
    resolveCharge.isPending ||
    createChargeGift.isPending ||
    linkDonorbox.isPending ||
    createDonorboxGift.isPending ||
    resolveStaged.isPending ||
    createStagedGift.isPending ||
    reconcileStaged.isPending ||
    excludeCharge.isPending ||
    excludeStaged.isPending ||
    confirmRefund.isPending ||
    dismissRefund.isPending ||
    confirmSettlement.isPending ||
    confirmChargeTies.isPending ||
    confirmMatch.isPending ||
    rejectChargeQbTie.isPending ||
    approveCard.isPending ||
    setAccountingDisposition.isPending ||
    confirmDepositQbo.isPending ||
    dismissDepositQbo.isPending ||
    linkPayout.isPending ||
    unlinkPayout.isPending ||
    confirmPayoutBankMatch.isPending ||
    setBankDepositExclusion.isPending ||
    clearBankDepositExclusion.isPending ||
    addBankComponent.isPending ||
    removeManualComponent.isPending ||
    setComponentQbSource.isPending ||
    attachQboEvidence.isPending ||
    flagAccountingError.isPending;

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListWorkbenchDepositsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getListWorkbenchRecentChangesQueryKey(),
    });
  };

  const handleConfirmProposedMatch = async (
    stagedPaymentId: string,
    label: string,
  ) => {
    try {
      await confirmMatch.mutateAsync({ id: stagedPaymentId });
      invalidate();
      toast({
        title: "Match confirmed",
        description: `${label} is now confirmed against its gift.`,
      });
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "The record changed — try again.",
          description: apiErrorMessage(err) ?? errMessage(err),
        });
        invalidate();
      } else {
        toast({
          title: "Couldn't confirm match",
          description: errMessage(err),
          variant: "destructive",
        });
      }
    }
  };

  const handleRejectChargeQbTie = async (chargeId: string) => {
    try {
      await rejectChargeQbTie.mutateAsync({ chargeId });
      invalidate();
      toast({
        title: "QB tie dismissed",
        description: "The proposed charge–QB link was cleared.",
      });
    } catch (err) {
      toast({
        title: "Couldn't dismiss QB tie",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleConfirmChargeProposal = async (
    chargeId: string,
    label: string,
    depositStagedPaymentId: string,
  ) => {
    try {
      const graph = await queryClient.fetchQuery(
        getGetReconciliationGraphQueryOptions(depositStagedPaymentId),
      );
      if ((graph.evidence.stripe?.chargeId ?? null) !== chargeId) {
        toast({
          title: "Confirm from the QuickBooks card",
          description:
            "This proposal covers the whole deposit, not just this charge — use “Confirm proposed match” on the deposit's QuickBooks card.",
        });
        return;
      }
      const derived = deriveApproveBodyFromProposal(graph);
      if (!derived.ok) {
        toast({ title: "Can't confirm yet", description: derived.reason });
        return;
      }
      if (
        derived.confirm &&
        !window.confirm(
          `${derived.confirm.title}\n\n${derived.confirm.description}`,
        )
      )
        return;
      await approveCard.mutateAsync({
        stagedPaymentId: depositStagedPaymentId,
        data: derived.body,
      });
      invalidate();
      toast({
        title: "Match confirmed",
        description: `${label} was approved as proposed.`,
      });
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "The record changed — try again.",
          description: apiErrorMessage(err) ?? errMessage(err),
        });
        invalidate();
      } else {
        toast({
          title: "Couldn't confirm match",
          description: errMessage(err),
          variant: "destructive",
        });
      }
    }
  };

  const handleAccountingDisposition = async () => {
    if (!accountingDispositionFor) return;
    try {
      await setAccountingDisposition.mutateAsync({
        id: accountingDispositionFor.checkId,
        data: {
          disposition: accountingDispositionFor.disposition,
          ...(accountingDispositionFor.disposition === "accepted_historical"
            ? { note: accountingDispositionNote.trim() }
            : {}),
        },
      });
      setAccountingDispositionFor(null);
      setAccountingDispositionNote("");
      invalidate();
      toast({ title: "Accounting disposition saved" });
    } catch (err) {
      toast({
        title: "Couldn't save accounting disposition",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const linkAnchorToGift = async (anchor: AnchorRef, giftId: string) => {
    if (anchor.kind === "charge") {
      await linkCharge.mutateAsync({ id: anchor.id, data: { giftId } });
    } else if (anchor.kind === "staged") {
      await reconcileStaged.mutateAsync({ id: anchor.id, data: { giftId } });
    }
  };

  const donorBody = (type: DonorType, id: string) => ({
    organizationId: type === "organization" ? id : null,
    individualGiverPersonId: type === "individual" ? id : null,
    householdId: type === "household" ? id : null,
  });
  const handlePickGift = async (gift: GiftOrPayment) => {
    if (!linkGiftFor) return;
    try {
      if (donorboxLinkRow) {
        await linkDonorbox.mutateAsync({
          id: donorboxLinkRow.id,
          data: { giftId: gift.id },
        });
        await linkAnchorToGift(linkGiftFor, gift.id);
        setDonorboxLinkRow(null);
      } else {
        await linkAnchorToGift(linkGiftFor, gift.id);
      }
      setLinkGiftFor(null);
      invalidate();
      toast({
        title: "Gift linked",
        description: `${linkGiftFor.label} now pays “${gift.name ?? gift.id}”.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't link gift",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
      invalidate();
    }
  };

  const handleSinglePaymentPick = async (gift: GiftOrPayment) => {
    if (!singlePaymentFor) return;
    try {
      const created = await addBankComponent.mutateAsync({
        bankDepositId: singlePaymentFor.depositId,
        data: { mode: "gift", giftId: gift.id },
      });
      setSinglePaymentFor(null);
      invalidate();
      const coversWholeDeposit =
        Math.abs(Number(created.amount) - Number(singlePaymentFor.amount)) <=
        0.005;
      toast(
        coversWholeDeposit
          ? {
              title: "Deposit linked to gift",
              description: `This deposit is now recorded as a single payment for “${gift.name ?? gift.id}”.`,
            }
          : {
              title: "Payment linked to gift",
              description: `Recorded a ${formatCurrency(created.amount)} payment for “${gift.name ?? gift.id}” — the rest of the deposit is still unresolved.`,
            },
      );
    } catch (err) {
      toast({
        title: "Couldn't link deposit to gift",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleSinglePaymentNoGift = async () => {
    if (!singlePaymentFor) return;
    try {
      await addBankComponent.mutateAsync({
        bankDepositId: singlePaymentFor.depositId,
        data: {
          mode: "create",
          kind: "other",
          amount: singlePaymentFor.amount,
        },
      });
      setSinglePaymentFor(null);
      invalidate();
      toast({
        title: "Single payment recorded",
        description:
          "This deposit is now one payment for its full amount — link a CRM gift when you find it.",
      });
    } catch (err) {
      toast({
        title: "Couldn't record single payment",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleQbEvidencePick = async (qbStagedPaymentId: string) => {
    if (!qbEvidenceFor) return;
    try {
      await attachQboEvidence.mutateAsync({
        bankDepositId: qbEvidenceFor.anchorId,
        data: { stagedPaymentId: qbStagedPaymentId },
      });
      setQbEvidenceFor(null);
      invalidate();
      toast({
        title: "Accounting evidence attached",
        description:
          "The selected QuickBooks record now documents this deposit.",
      });
    } catch (err) {
      toast({
        title: "Couldn't attach accounting evidence",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleFlagAccountingError = async () => {
    if (!flagErrorFor || !flagErrorStagedId || !flagErrorNote.trim()) return;
    try {
      await flagAccountingError.mutateAsync({
        data: {
          stagedPaymentId: flagErrorStagedId,
          note: flagErrorNote.trim(),
        },
      });
      setFlagErrorFor(null);
      setFlagErrorStagedId("");
      setFlagErrorNote("");
      invalidate();
      toast({
        title: "Accounting error flagged",
        description: "The record is on the accounting-corrections worklist.",
      });
    } catch (err) {
      toast({
        title: "Couldn't flag accounting error",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleCreateFromDonorbox = async (row: DonorboxReviewRow) => {
    if (!donorboxFor) return;
    const donorbox = await createDonorboxGift.mutateAsync({
      id: row.id,
      data: {
        organizationId: row.organizationId ?? null,
        individualGiverPersonId: row.individualGiverPersonId ?? null,
        householdId: row.householdId ?? null,
      },
    });
    await linkAnchorToGift(donorboxFor.anchor, donorbox.gift.id);
    setDonorboxFor(null);
    setDonorboxSearch("");
    invalidate();
  };

  const handleUseCodingForm = (
    row: CodingFormRow,
    mode: "identify" | "create",
  ) => {
    if (!codingFormFor) return;
    setCodingHint(row);
    if (mode === "create") {
      setCreateFor({ ...codingFormFor, prefill: null });
    } else {
      setIdentifyFor(codingFormFor);
    }
    setCodingFormFor(null);
  };
  const handleDonor = async (type: DonorType, id: string) => {
    const target = identifyFor;
    if (!target) return;
    const body = donorBody(type, id);
    if (target.anchor.kind === "charge") {
      await resolveCharge.mutateAsync({ id: target.anchor.id, data: body });
    } else {
      await resolveStaged.mutateAsync({ id: target.anchor.id, data: body });
    }
    setIdentifyFor(null);
    invalidate();
  };
  const handleCreateStandalone = async (
    type: DonorType,
    id: string,
    overrides: MintGiftOverridesBody,
  ) => {
    const target = createFor;
    if (!target) return;
    try {
      const body = donorBody(type, id);
      if (target.anchor.kind === "charge") {
        await resolveCharge.mutateAsync({ id: target.anchor.id, data: body });
        await createChargeGift.mutateAsync({
          id: target.anchor.id,
          data: overrides,
        });
      } else {
        await resolveStaged.mutateAsync({ id: target.anchor.id, data: body });
        await createStagedGift.mutateAsync({
          id: target.anchor.id,
          data: overrides,
        });
      }
      setCreateFor(null);
      setCodingHint(null);
      invalidate();
      toast({
        title: "Gift created",
        description: `A standalone gift was minted from “${target.anchor.label}”.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't create gift",
        description: is409(err) ? apiErrorMessage(err) : errMessage(err),
        variant: "destructive",
      });
      if (is409(err)) invalidate();
    }
  };
  /**
   * Book a staged payment against a picked gift or opportunity via the unified
   * approve endpoint (server re-derives + re-validates; amount-tolerance
   * failures need an explicit human override reason).
   */
  const approveStagedAgainst = async (
    stagedPaymentId: string,
    pick: { giftId?: string; giftLabel?: string; opp?: OpportunityOrPledge },
    outcomeChoice: OutcomeChoice,
  ): Promise<boolean> => {
    const graph = await queryClient.fetchQuery(
      getGetReconciliationGraphQueryOptions(stagedPaymentId),
    );
    let overrideReason = "";
    if (hasAmountBlocker(graph.blockers)) {
      const entered = window.prompt(
        "The amounts don't match within tolerance. Enter a reason to override:",
      );
      if (entered == null || !entered.trim()) return false;
      overrideReason = entered.trim();
    }
    const derived = deriveApproveBody({
      donor: null,
      gift: pick.giftId
        ? {
            nodeType: "gift",
            id: pick.giftId,
            label: pick.giftLabel ?? pick.giftId,
            donorId: null,
          }
        : null,
      opportunity: pick.opp
        ? {
            nodeType: "opportunity",
            id: pick.opp.id,
            label: pick.opp.name ?? pick.opp.id,
          }
        : null,
      outcomeChoice,
      overrideAmountMismatchReason: overrideReason,
      graph,
    });
    if (!derived.ok) {
      toast({ title: "Can't link yet", description: derived.reason });
      return false;
    }
    if (
      derived.confirm &&
      !window.confirm(
        `${derived.confirm.title}\n\n${derived.confirm.description}`,
      )
    ) {
      return false;
    }
    await approveCard.mutateAsync({ stagedPaymentId, data: derived.body });
    return true;
  };
  const handleLinkEvidenceGift = async (gift: GiftOrPayment) => {
    const target = linkEvidenceFor;
    if (!target) return;
    try {
      if (target.anchor.kind === "charge") {
        await linkCharge.mutateAsync({
          id: target.anchor.id,
          data: { giftId: gift.id },
        });
      } else {
        const done = await approveStagedAgainst(
          target.anchor.id,
          { giftId: gift.id, giftLabel: gift.name ?? gift.id },
          "create_gift_from_opportunity",
        );
        if (!done) return;
      }
      setLinkEvidenceFor(null);
      invalidate();
      toast({
        title: "Gift linked",
        description: `“${target.anchor.label}” now pays the selected gift.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't link gift",
        description: is409(err) ? apiErrorMessage(err) : errMessage(err),
        variant: "destructive",
      });
      if (is409(err)) invalidate();
    }
  };
  const handleLinkEvidenceOpp = async (
    opp: OpportunityOrPledge,
    choice?: OutcomeChoice,
  ) => {
    const target = linkEvidenceFor;
    if (!target || target.anchor.kind === "charge") return;
    if (target.anchor.kind !== "staged") {
      toast({
        title: "Not available",
        description:
          "Only QuickBooks-backed payments can be booked against an opportunity or pledge.",
      });
      return;
    }
    // An OPEN opportunity has two booking outcomes — ask the human which one.
    if (!choice && opp.status === "open" && linkEvidenceFor?.mode === "all") {
      setOppOutcomeFor(opp);
      return;
    }
    const outcome: OutcomeChoice =
      choice ??
      (opp.status === "open"
        ? "convert_to_pledge_and_first_payment"
        : "create_gift_from_opportunity");
    try {
      const done = await approveStagedAgainst(
        target.anchor.id,
        { opp },
        outcome,
      );
      if (!done) return;
      setOppOutcomeFor(null);
      setLinkEvidenceFor(null);
      invalidate();
      toast({
        title:
          outcome === "convert_to_pledge_and_first_payment"
            ? "Pledge created with first payment"
            : "Payment recorded",
        description: `“${target.anchor.label}” was booked against “${opp.name ?? "the selected record"}”.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't record payment",
        description: is409(err) ? apiErrorMessage(err) : errMessage(err),
        variant: "destructive",
      });
      if (is409(err)) invalidate();
    }
  };
  const handleExclude = async (reason: StagedPaymentExclusionReason) => {
    if (!excludeFor) return;
    if (excludeFor.kind === "charge")
      await excludeCharge.mutateAsync({
        id: excludeFor.id,
        data: { exclusionReason: reason },
      });
    else if (excludeFor.kind === "staged")
      await excludeStaged.mutateAsync({
        id: excludeFor.id,
        data: { exclusionReason: reason },
      });
    else
      await excludeComponent.mutateAsync({
        id: excludeFor.id,
        data: { exclusionReason: reason },
      });
    setExcludeFor(null);
    invalidate();
  };
  const handleFlagRemainder = async (depositId: string, remainder: string) => {
    await addBankComponent.mutateAsync({
      bankDepositId: depositId,
      data: { mode: "placeholder", amount: remainder },
    });
    toast({
      title: "Remainder flagged for research",
      description: `${formatCurrency(remainder)} remains visible as a review placeholder.`,
    });
    invalidate();
  };
  const handleAttachPaymentUnit = async (
    candidate: CandidatePaymentUnitWithClaim,
  ) => {
    if (!knownPaymentFor) return;
    await addBankComponent.mutateAsync({
      bankDepositId: knownPaymentFor.depositId,
      data: { mode: "attach", paymentUnitId: candidate.id },
    });
    setKnownPaymentFor(null);
    setKnownPaymentSearch("");
    setKnownPaymentFilterAmount("");
    setKnownPaymentFilterDate("");
    invalidate();
  };
  const handleUnlinkCandidatePaymentUnit = async (
    candidate: CandidatePaymentUnitWithClaim,
  ) => {
    if (!candidate.claimedComponentId) return;
    await removeManualComponent.mutateAsync({
      id: candidate.claimedComponentId,
    });
    invalidate();
  };
  const handleCreateKnownPayment = async () => {
    if (!knownPaymentFor || !knownPaymentAmount.trim()) return;
    await addBankComponent.mutateAsync({
      bankDepositId: knownPaymentFor.depositId,
      data: {
        mode: "create",
        kind: knownPaymentKind,
        amount: knownPaymentAmount.trim(),
        receivedDate: knownPaymentDate || undefined,
      },
    });
    setKnownPaymentFor(null);
    setKnownPaymentSearch("");
    setKnownPaymentFilterAmount("");
    setKnownPaymentFilterDate("");
    invalidate();
  };
  const handleRemoveManualComponent = async () => {
    if (!manualComponentFor) return;
    await removeManualComponent.mutateAsync({ id: manualComponentFor.id });
    setManualComponentFor(null);
    toast({
      title: "Payment unlinked",
      description:
        "The payment remains available to attach to another deposit.",
    });
    invalidate();
  };
  const handleUnlinkAccountingRecord = async (
    bankDepositId: string,
    record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord,
  ) => {
    const query = new URLSearchParams({ role: record.role });
    if (record.linkedChargeId) {
      query.set("linkedChargeId", record.linkedChargeId);
    }
    if ("bankTransactionId" in record && record.bankTransactionId) {
      query.set("bankTransactionId", record.bankTransactionId);
    }
    const response = await fetch(
      `/api/reconciliation/deposits/${encodeURIComponent(bankDepositId)}/accounting-evidence/${encodeURIComponent(record.stagedPaymentId)}?${query.toString()}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(body?.message ?? "Could not unlink accounting evidence.");
    }
    invalidate();
  };

  const handleChargeQbPick = async (
    qbStagedPaymentId: string,
    opts?: PickOptions,
  ) => {
    if (!tieChargeFor) return;
    try {
      await confirmChargeTies.mutateAsync({
        payoutId: tieChargeFor.payoutId,
        data: {
          qbStagedPaymentIds: [qbStagedPaymentId],
          chargeId: tieChargeFor.charge.id,
          ...opts,
        },
      });
      toast({
        title: "QuickBooks row tied",
        description:
          "The selected QBO record now documents this Stripe charge.",
      });
      setTieChargeFor(null);
      invalidate();
    } catch (error) {
      toast({
        title: "Couldn't tie QuickBooks row",
        description:
          error instanceof Error
            ? error.message
            : "The charge or QBO row changed. Refresh and try again.",
        variant: "destructive",
      });
    }
  };
  const handleComponentQbPick = async (qbStagedPaymentId: string) => {
    if (!componentQbFor) return;
    try {
      await setComponentQbSource.mutateAsync({
        id: componentQbFor.id,
        data: { stagedPaymentId: qbStagedPaymentId },
      });
      toast({
        title: "QuickBooks source attached",
        description:
          "The selected QBO record now documents this direct payment component.",
      });
      setComponentQbFor(null);
      invalidate();
    } catch (error) {
      toast({
        title: "Couldn't attach QuickBooks source",
        description:
          error instanceof Error
            ? error.message
            : "The component or QBO row changed. Refresh and try again.",
        variant: "destructive",
      });
    }
  };
  const handleClearComponentQbSource = async () => {
    if (!clearComponentQbFor) return;
    try {
      await setComponentQbSource.mutateAsync({
        id: clearComponentQbFor,
        data: { stagedPaymentId: null },
      });
      setClearComponentQbFor(null);
      toast({ title: "QuickBooks source cleared" });
      invalidate();
    } catch (error) {
      toast({
        title: "Couldn't clear QuickBooks source",
        description:
          error instanceof Error
            ? error.message
            : "The component changed. Refresh and try again.",
        variant: "destructive",
      });
    }
  };
  const handleRevert = async () => {
    if (!revertFor) return;
    if (revertFor.anchor.kind === "charge")
      await revertCharge.mutateAsync({ id: revertFor.anchor.id });
    else await revertStaged.mutateAsync({ id: revertFor.anchor.id });
    setRevertFor(null);
    invalidate();
  };
  const actions: DepositActions = {
    busy,
    openLinkGift: setLinkGiftFor,
    openCreateGift: (anchor, preview, prefill) =>
      setCreateFor({ anchor, preview, prefill: prefill ?? null }),
    openLinkEvidence: (anchor, mode) => setLinkEvidenceFor({ anchor, mode }),
    openIdentify: (anchor, preview) =>
      setIdentifyFor({
        anchor,
        preview: preview ?? {
          amount: "—",
          date: "—",
          method: "Payment",
          source: anchor.label,
          memo: null,
        },
      }),
    openDonorboxSearch: (anchor, preview) => {
      setDonorboxFor({ anchor, preview });
      setDonorboxSearch("");
    },
    openCodingFormLookup: (anchor, preview) =>
      setCodingFormFor({ anchor, preview }),
    openExclude: setExcludeFor,
    reInclude: (anchor) =>
      void (
        anchor.kind === "charge"
          ? reIncludeCharge.mutateAsync({ id: anchor.id })
          : anchor.kind === "staged"
            ? reIncludeStaged.mutateAsync({ id: anchor.id })
            : reIncludeComponent.mutateAsync({ id: anchor.id })
      ).finally(invalidate),
    openRevert: (anchor, description) => setRevertFor({ anchor, description }),
    openConfirmRefund: (chargeId, kind, label) =>
      setRefundFor({ chargeId, kind, label }),
    openDismissRefund: (chargeId, label) => setDismissFor({ chargeId, label }),
    openFlag: () => undefined,
    openFlagGift: () => undefined,
    openSettlementSearch: setSettlementSearchFor,
    openLinkDepositPayout: setLinkPayoutFor,
    openLinkPayoutDeposit: setPayoutCandidateFor,
    openUnlinkPayoutDeposit: setUnlinkPayoutFor,
    openConfirmPayoutBankMatch: setConfirmPayoutFor,
    openBankDepositExclusion: (depositId, existing) => {
      setBankExclusionFor({ depositId, existing });
      setBankExclusionReason(existing?.reason ?? "other");
      setBankExclusionNote(existing?.note ?? "");
    },
    clearBankDepositExclusion: (depositId) => {
      void clearBankDepositExclusion
        .mutateAsync({ bankDepositId: depositId })
        .then(invalidate);
    },
    applyBankDepositExclusion: (depositId, reason) => {
      void setBankDepositExclusion
        .mutateAsync({ bankDepositId: depositId, data: { reason, note: null } })
        .then(() => {
          toast({
            title: "Deposit excluded",
            description: `Marked as ${reason.replaceAll("_", " ")}.`,
          });
          invalidate();
        })
        .catch((error) => {
          toast({
            title: "Couldn't exclude deposit",
            description:
              error instanceof Error ? error.message : "Refresh and try again.",
            variant: "destructive",
          });
        });
    },
    openAddKnownPayment: (depositId, remainder) => {
      setKnownPaymentFor({ depositId, remainder });
      setKnownPaymentMode("search");
      setKnownPaymentSearch("");
      setKnownPaymentFilterAmount("");
      setKnownPaymentFilterDate("");
      setKnownPaymentAmount(remainder);
      setKnownPaymentDate("");
    },
    openFlagRemainder: (depositId, remainder) => {
      void handleFlagRemainder(depositId, remainder);
    },
    removeManualComponent: (id, label) => setManualComponentFor({ id, label }),
    openChargeQbSearch: (charge) => {
      const deposit = deposits.find((item) =>
        item.charges.some(
          (itemCharge) => itemCharge.chargeId === charge.chargeId,
        ),
      );
      if (!deposit?.composition.payoutId) return;
      setTieChargeFor({
        payoutId: deposit.composition.payoutId,
        charge: {
          id: charge.chargeId,
          payerName: charge.payerName,
          amount: charge.amount,
          fee: charge.feeAmount,
          net: charge.netAmount,
          description: charge.description,
          statementDescriptor: charge.statementDescriptor,
          date: charge.chargeDate,
          status: charge.status,
          exclusionReason: charge.exclusionReason,
        },
      });
    },
    openComponentQbSearch: (
      component: WorkbenchDepositCompositionComponentsItem,
    ) => {
      setComponentQbFor({
        id: component.componentId,
        charge: {
          id: component.componentId,
          payerName: component.label ?? component.kind.replace("_", " "),
          amount: component.amount,
          date: null,
        },
      });
    },
    clearComponentQbSource: (componentId) =>
      setClearComponentQbFor(componentId),
    unlinkAccountingRecord: (bankDepositId, record) => {
      void handleUnlinkAccountingRecord(bankDepositId, record).catch((error) =>
        toast({
          title: "Couldn't unlink accounting evidence",
          description:
            error instanceof Error ? error.message : "Refresh and try again.",
          variant: "destructive",
        }),
      );
    },
    isFinanceOrAdmin:
      canManageAccounting && (me?.role === "finance" || me?.role === "admin"),
    canUseCodingForm: canManageAccounting && me?.role === "admin",
    openQbDetail: (record, linkage) => setQbDetailFor({ record, linkage }),
    rejectChargeQbTie: (chargeId) => void handleRejectChargeQbTie(chargeId),
    confirmProposedMatch: (stagedPaymentId, label) =>
      void handleConfirmProposedMatch(stagedPaymentId, label),
    openUnlinkChooser: (giftLabel, options) =>
      setUnlinkChooserFor({ giftLabel, options }),
    openMergeGifts: setMergeGiftIds,
    confirmChargeProposal: (chargeId, label, depositStagedPaymentId) =>
      void handleConfirmChargeProposal(chargeId, label, depositStagedPaymentId),
    openAccountingDisposition: (
      checkId: string,
      disposition: "corrected" | "accepted_historical",
    ) => {
      setAccountingDispositionFor({ checkId, disposition });
      setAccountingDispositionNote("");
    },
    openSinglePaymentDeposit: (depositId, amount) =>
      setSinglePaymentFor({ depositId, amount }),
    openDepositQbEvidenceSearch: (deposit) => setQbEvidenceFor(deposit),
    openFlagAccountingError: (deposit) => {
      setFlagErrorFor(deposit);
      setFlagErrorStagedId(
        deposit.qbRecords[0]?.stagedPaymentId ??
          deposit.accountingChecks[0]?.stagedPaymentId ??
          "",
      );
      setFlagErrorNote("");
    },
  };

  const handleUndo = async (change: WorkbenchRecentChange) => {
    if (!change.undo) return;
    try {
      if (change.undo.kind === "revert_staged_payment")
        await revertStaged.mutateAsync({ id: change.undo.targetId });
      else if (change.undo.kind === "reinclude_staged_payment")
        await reIncludeStaged.mutateAsync({ id: change.undo.targetId });
      else if (change.undo.kind === "revert_stripe_charge")
        await revertCharge.mutateAsync({ id: change.undo.targetId });
      else await reIncludeCharge.mutateAsync({ id: change.undo.targetId });
      toast({
        title: "Undone",
        description: "The reconciliation action was reversed.",
      });
    } catch {
      toast({
        title: "Couldn't undo",
        description: "The row changed or the action is no longer reversible.",
        variant: "destructive",
      });
    } finally {
      invalidate();
    }
  };

  const renderRecentChanges = (testIdSuffix = "") => (
    <>
      <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Recent changes
      </h2>
      {recentLoading ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : !recentData?.items.length ? (
        <p className="text-[11px] text-muted-foreground">
          No reconciliation actions recorded yet.
        </p>
      ) : (
        <ul className="max-h-80 space-y-2 overflow-y-auto pr-0.5">
          {recentData.items.map((change) => (
            <li
              key={change.id}
              className="text-[11px] leading-snug"
              data-testid={`deposit-recent-change-${change.id}${testIdSuffix}`}
            >
              <p>{change.summary}</p>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">
                  {change.actorName ?? "System"} · {formatWhen(change.at)}
                </span>
                {change.undo ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 shrink-0 px-1.5 text-[10px]"
                    disabled={busy}
                    onClick={() => void handleUndo(change)}
                    data-testid={`deposit-button-undo-${change.id}${testIdSuffix}`}
                  >
                    Undo
                  </Button>
                ) : (
                  <span className="shrink-0 text-[10px] text-muted-foreground/50">
                    No undo
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
          Wells Fargo deposit ledger
        </p>
        <h1 className="mt-1 text-3xl font-serif font-bold text-foreground">
          Reconciliation
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          One row per bank deposit, with the known composition, CRM gifts, and
          accounting evidence kept together.
        </p>
      </div>
      <div className="flex items-start gap-4">
        <main className="min-w-0 flex-1 space-y-3">
          <div
            className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden"
            data-testid="deposit-lens-strip-mobile"
          >
            {DEPOSIT_LENSES.map((item) => (
              <Button
                key={item.id}
                variant={lens === item.id ? "default" : "outline"}
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setLens(item.id);
                  setPage(1);
                }}
                data-testid={`button-deposit-lens-mobile-${item.id}`}
              >
                {item.label}
                <span className="ml-1.5 text-xs tabular-nums">
                  {data?.lensCounts[item.id] ?? "—"}
                </span>
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search memo, deposit, unit, or gift…"
                className="pl-8"
                data-testid="input-deposit-search"
              />
            </div>
            {!isLoading && !isError ? (
              <span
                className="ml-auto text-sm text-muted-foreground"
                data-testid="text-deposit-total"
              >
                {total.toLocaleString()} deposits
              </span>
            ) : null}
          </div>
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading deposits…
            </p>
          ) : isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              Failed to load the deposit list.
            </p>
          ) : deposits.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {q
                ? "No deposits match this search."
                : "Nothing in this lens right now."}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
              <div className="min-w-[880px]">
                <DepositGridHeader />
                {deposits.map((deposit) => (
                  <DepositRow
                    key={deposit.id}
                    deposit={deposit}
                    actions={actions}
                    onConfirmProvisional={(id) =>
                      void confirmDepositQbo
                        .mutateAsync({ id })
                        .then(invalidate)
                    }
                    onDismissProvisional={(id) =>
                      void dismissDepositQbo
                        .mutateAsync({ id })
                        .then(invalidate)
                    }
                  />
                ))}
              </div>
            </div>
          )}
          {totalPages > 1 ? (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <span className="text-sm tabular-nums text-muted-foreground">
                Page {page} of {totalPages.toLocaleString()}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
          <div
            className="rounded-lg border bg-card p-3 lg:hidden"
            data-testid="deposit-recent-changes-mobile"
          >
            {renderRecentChanges("-mobile")}
          </div>
        </main>
        <aside className="sticky top-4 hidden w-60 shrink-0 space-y-3 lg:block">
          <div className="rounded-lg border bg-card p-3">
            <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Deposit lenses
            </h2>
            <nav className="space-y-0.5" data-testid="deposit-lens-rail">
              {DEPOSIT_LENSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setLens(item.id);
                    setPage(1);
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-medium ${lens === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  data-testid={`button-deposit-lens-${item.id}`}
                >
                  <span>{item.label}</span>
                  <span className="tabular-nums">
                    {data?.lensCounts[item.id] ?? "—"}
                  </span>
                </button>
              ))}
            </nav>
          </div>
          <div
            className="rounded-lg border bg-card p-3"
            data-testid="deposit-recent-changes-rail"
          >
            {renderRecentChanges()}
          </div>
        </aside>
      </div>
      <AlertDialog
        open={knownPaymentFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setKnownPaymentFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add known payment</AlertDialogTitle>
            <AlertDialogDescription>
              Resolve{" "}
              {knownPaymentFor
                ? formatCurrency(knownPaymentFor.remainder)
                : "the"}{" "}
              unexplained remainder by attaching, moving, or creating a payment
              unit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={knownPaymentMode === "search" ? "default" : "outline"}
              size="sm"
              onClick={() => setKnownPaymentMode("search")}
            >
              Search existing
            </Button>
            <Button
              type="button"
              variant={knownPaymentMode === "create" ? "default" : "outline"}
              size="sm"
              onClick={() => setKnownPaymentMode("create")}
            >
              Create new
            </Button>
          </div>
          {knownPaymentMode === "search" ? (
            <div className="space-y-3">
              <Input
                value={knownPaymentSearch}
                onChange={(event) => setKnownPaymentSearch(event.target.value)}
                placeholder="Search payer, memo, or payment unit…"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span className="font-medium">Amount</span>
                  <Input
                    value={knownPaymentFilterAmount}
                    onChange={(event) =>
                      setKnownPaymentFilterAmount(event.target.value)
                    }
                    inputMode="decimal"
                    placeholder="Any amount"
                    aria-label="Filter payments by amount"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="font-medium">Date</span>
                  <Input
                    type="date"
                    value={knownPaymentFilterDate}
                    onChange={(event) =>
                      setKnownPaymentFilterDate(event.target.value)
                    }
                    aria-label="Filter payments by date"
                  />
                </label>
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {candidatePaymentUnits.isLoading ? (
                  <p className="text-sm text-muted-foreground">
                    Searching payment units…
                  </p>
                ) : candidatePaymentUnits.isError ? (
                  <p className="text-sm text-destructive">
                    Could not load candidate payment units.
                  </p>
                ) : candidatePaymentUnits.data?.data.length ? (
                  (
                    candidatePaymentUnits.data
                      .data as CandidatePaymentUnitWithClaim[]
                  ).map((candidate) => (
                    <div key={candidate.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {candidate.sourceLabel}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {candidate.kind.replaceAll("_", " ")} ·{" "}
                            {candidate.receivedDate ?? "Undated"} ·{" "}
                            {candidate.id}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {candidate.claimedByCurrentDeposit
                              ? "Attached to this deposit"
                              : candidate.claimed
                                ? `Attached to ${candidate.claimedDepositDate ?? "an undated deposit"}${candidate.claimedComponentAmount ? ` · component ${formatCurrency(candidate.claimedComponentAmount)}` : ""}${candidate.claimedDepositAmount ? ` · deposit ${formatCurrency(candidate.claimedDepositAmount)}` : ""}${candidate.claimedDepositMemo ? ` · ${candidate.claimedDepositMemo}` : ""}`
                                : "Available"}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block tabular-nums">
                            {formatCurrency(candidate.amount)}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant={
                              candidate.claimedByCurrentDeposit
                                ? "outline"
                                : "default"
                            }
                            className="mt-2"
                            disabled={
                              addBankComponent.isPending ||
                              removeManualComponent.isPending
                            }
                            onClick={() =>
                              void (candidate.claimedByCurrentDeposit
                                ? handleUnlinkCandidatePaymentUnit(candidate)
                                : handleAttachPaymentUnit(candidate))
                            }
                          >
                            {candidate.claimedByCurrentDeposit
                              ? "Unlink"
                              : candidate.claimed
                                ? "Move here"
                                : "Attach"}
                          </Button>
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No payment units match this search and filters. Try a payer,
                    memo, amount, date, or payment-unit ID.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label
                  className="text-sm font-medium"
                  htmlFor="known-payment-kind"
                >
                  Payment method
                </label>
                <Select
                  value={knownPaymentKind}
                  onValueChange={(value) =>
                    setKnownPaymentKind(value as typeof knownPaymentKind)
                  }
                >
                  <SelectTrigger id="known-payment-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="direct_ach">Direct ACH</SelectItem>
                    <SelectItem value="wire">Wire</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label
                  className="text-sm font-medium"
                  htmlFor="known-payment-amount"
                >
                  Amount
                </label>
                <Input
                  id="known-payment-amount"
                  inputMode="decimal"
                  value={knownPaymentAmount}
                  onChange={(event) =>
                    setKnownPaymentAmount(event.target.value)
                  }
                />
              </div>
              <div className="space-y-1">
                <label
                  className="text-sm font-medium"
                  htmlFor="known-payment-date"
                >
                  Received date (optional)
                </label>
                <Input
                  id="known-payment-date"
                  type="date"
                  value={knownPaymentDate}
                  onChange={(event) => setKnownPaymentDate(event.target.value)}
                />
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {knownPaymentMode === "create" ? (
              <AlertDialogAction
                disabled={busy || !knownPaymentAmount.trim()}
                onClick={() => void handleCreateKnownPayment()}
              >
                Create payment
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={manualComponentFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setManualComponentFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove component?</AlertDialogTitle>
            <AlertDialogDescription>
              Unlink {manualComponentFor?.label ?? "this payment"} from this
              deposit. The payment unit and any linked gift remain intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleRemoveManualComponent()}
            >
              Remove component
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <GiftSearchDialog
        open={linkGiftFor != null}
        onOpenChange={(open) => {
          if (!open) {
            setLinkGiftFor(null);
            setDonorboxLinkRow(null);
          }
        }}
        onPick={(gift) => void handlePickGift(gift)}
        busy={busy}
        title="Link to an existing gift"
        description={
          linkGiftFor
            ? `Pick the CRM donation record that ${linkGiftFor.label} pays.`
            : undefined
        }
      />
      <GiftSearchDialog
        open={singlePaymentFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setSinglePaymentFor(null);
        }}
        onPick={(gift) => void handleSinglePaymentPick(gift)}
        busy={busy}
        title="Single payment deposit"
        description={
          singlePaymentFor
            ? `Record this ${formatCurrency(singlePaymentFor.amount)} deposit as a single payment for an existing CRM gift.`
            : undefined
        }
        extraAction={{
          label: "Record without a gift",
          description: singlePaymentFor
            ? `One ${formatCurrency(singlePaymentFor.amount)} payment covering the whole deposit — no CRM gift linked yet.`
            : undefined,
          onSelect: () => void handleSinglePaymentNoGift(),
        }}
      />
      {qbEvidenceFor ? (
        <TieChargeQbDialog
          payoutId=""
          charge={{
            id: qbEvidenceFor.anchorId,
            payerName:
              qbEvidenceFor.bank.memo ??
              qbEvidenceFor.bank.reference ??
              qbEvidenceFor.anchorId,
            amount: qbEvidenceFor.bank.amount,
            date: qbEvidenceFor.date ?? null,
          }}
          mode="component"
          open
          onOpenChange={(open) => {
            if (!open) setQbEvidenceFor(null);
          }}
          onPick={(id) => void handleQbEvidencePick(id)}
          busy={busy}
        />
      ) : null}
      <AlertDialog
        open={flagErrorFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setFlagErrorFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Flag accounting error</AlertDialogTitle>
            <AlertDialogDescription>
              Puts the selected QuickBooks record on the accounting-corrections
              worklist. This records a review decision only — it does not change
              money or QuickBooks itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="flag-error-record"
              >
                QuickBooks record
              </label>
              <Select
                value={flagErrorStagedId}
                onValueChange={setFlagErrorStagedId}
              >
                <SelectTrigger id="flag-error-record">
                  <SelectValue placeholder="Pick a record" />
                </SelectTrigger>
                <SelectContent>
                  {(flagErrorFor?.qbRecords ?? []).map((record) => (
                    <SelectItem
                      key={record.stagedPaymentId}
                      value={record.stagedPaymentId}
                    >
                      {record.payerName ??
                        record.memo ??
                        record.lineDescription ??
                        record.stagedPaymentId}{" "}
                      · {formatCurrency(record.amount ?? "0")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="flag-error-note">
                What's wrong?
              </label>
              <Textarea
                id="flag-error-note"
                value={flagErrorNote}
                onChange={(event) => setFlagErrorNote(event.target.value)}
                placeholder="Describe the accounting error"
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !flagErrorStagedId || !flagErrorNote.trim()}
              onClick={() => void handleFlagAccountingError()}
            >
              Flag error
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DonorboxSearchDialog
        open={donorboxFor != null}
        onOpenChange={(open) => {
          if (!open) {
            setDonorboxFor(null);
            setDonorboxSearch("");
          }
        }}
        rows={donorboxRows.data?.data ?? []}
        search={donorboxSearch}
        onSearchChange={setDonorboxSearch}
        busy={busy || donorboxRows.isFetching}
        onLink={(row) => {
          if (!donorboxFor) return;
          setDonorboxLinkRow(row);
          setLinkGiftFor(donorboxFor.anchor);
          setDonorboxFor(null);
        }}
        onCreate={(row) => void handleCreateFromDonorbox(row)}
      />
      <CodingFormLookupDialog
        open={codingFormFor != null}
        onOpenChange={(open) => {
          if (!open) setCodingFormFor(null);
        }}
        rows={(codingFormRows.data?.data ?? [])
          .filter((row) => {
            if (!codingFormFor) return false;
            const amountMatches =
              !codingFormFor.preview.amount ||
              codingFormFor.preview.amount === "—" ||
              row.amount == null ||
              codingFormFor.preview.amount.includes(row.amount);
            const dateMatches =
              !codingFormFor.preview.date ||
              codingFormFor.preview.date === "—" ||
              row.donationDate == null ||
              codingFormFor.preview.date.includes(row.donationDate);
            return amountMatches || dateMatches;
          })
          .slice(0, 50)}
        busy={busy || codingFormRows.isFetching}
        onUse={handleUseCodingForm}
      />
      <UnlinkChooserDialog
        open={unlinkChooserFor != null}
        onOpenChange={(open) => {
          if (!open) setUnlinkChooserFor(null);
        }}
        giftLabel={unlinkChooserFor?.giftLabel ?? ""}
        options={unlinkChooserFor?.options ?? []}
        busy={busy}
        onPick={(option) => {
          const label = unlinkChooserFor?.giftLabel ?? "this gift";
          setUnlinkChooserFor(null);
          setRevertFor({
            anchor: option.anchor,
            description: `Unlink “${label}” from ${option.source}.`,
          });
        }}
      />
      <CreateStandaloneGiftDialog
        open={createFor != null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateFor(null);
            setCodingHint(null);
          }
        }}
        recordLabel={createFor?.anchor.label ?? ""}
        preview={createFor?.preview ?? null}
        contextNote={
          codingHint
            ? `Coding form suggests ${codingHint.donorName ?? codingHint.donorNameRaw ?? "an unidentified donor"}${codingHint.intendedUsageSuggested ? ` · purpose: ${codingHint.intendedUsageSuggested}` : ""}.`
            : null
        }
        prefill={createFor?.prefill ?? null}
        busy={busy}
        onSubmit={(type, id, overrides) =>
          void handleCreateStandalone(type, id, overrides)
        }
      />
      <LinkEvidenceSearchDialog
        open={linkEvidenceFor != null}
        onOpenChange={(open) => {
          if (!open) setLinkEvidenceFor(null);
        }}
        mode={linkEvidenceFor?.mode ?? "all"}
        anchorKind={linkEvidenceFor?.anchor.kind ?? null}
        busy={busy}
        onPickGift={(gift) => void handleLinkEvidenceGift(gift)}
        onPickOpp={(opp) => void handleLinkEvidenceOpp(opp)}
      />
      <AlertDialog
        open={oppOutcomeFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setOppOutcomeFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>How should this be booked?</AlertDialogTitle>
            <AlertDialogDescription>
              “{oppOutcomeFor?.name ?? oppOutcomeFor?.id}” is still an open
              opportunity. Convert it into a pledge with this as its first
              payment, or book a one-time gift from it and keep the opportunity
              as-is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const opp = oppOutcomeFor;
                if (opp)
                  void handleLinkEvidenceOpp(
                    opp,
                    "create_gift_from_opportunity",
                  );
              }}
              data-testid="button-opp-outcome-gift"
            >
              One-time gift
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const opp = oppOutcomeFor;
                if (opp)
                  void handleLinkEvidenceOpp(
                    opp,
                    "convert_to_pledge_and_first_payment",
                  );
              }}
              data-testid="button-opp-outcome-pledge"
            >
              Convert to pledge + first payment
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DonorResolveDialog
        open={identifyFor != null}
        onOpenChange={(open) => {
          if (!open) {
            setIdentifyFor(null);
            setCodingHint(null);
          }
        }}
        mode="identify"
        recordLabel={identifyFor?.anchor.label ?? ""}
        preview={identifyFor?.preview ?? null}
        contextNote={
          codingHint
            ? `Coding form suggests ${codingHint.donorName ?? codingHint.donorNameRaw ?? "an unidentified donor"}${codingHint.intendedUsageSuggested ? ` · purpose: ${codingHint.intendedUsageSuggested}` : ""}.`
            : null
        }
        busy={busy}
        onSubmit={(type, id) => void handleDonor(type, id)}
      />
      <ExcludeReasonDialog
        open={excludeFor != null}
        onOpenChange={(open) => {
          if (!open) setExcludeFor(null);
        }}
        recordLabel={excludeFor?.label ?? "this record"}
        busy={busy}
        onSubmit={(reason) => void handleExclude(reason)}
      />
      <AlertDialog
        open={revertFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevertFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this match?</AlertDialogTitle>
            <AlertDialogDescription>
              {revertFor?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleRevert()}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={linkPayoutFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setLinkPayoutFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Link Stripe payout</AlertDialogTitle>
            <AlertDialogDescription>
              Choose the paid payout that settled this bank deposit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {candidatePayouts.isLoading ? (
              <p className="text-sm text-muted-foreground">
                Loading candidate payouts…
              </p>
            ) : candidatePayouts.isError ? (
              <p className="text-sm text-destructive">
                Could not load candidate payouts.
              </p>
            ) : candidatePayouts.data?.data.length ? (
              candidatePayouts.data.data.map(
                (candidate: DepositCandidatePayout) => (
                  <button
                    key={candidate.payoutId}
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                    disabled={busy}
                    onClick={() => {
                      if (!linkPayoutFor) return;
                      void linkPayout
                        .mutateAsync({
                          payoutId: candidate.payoutId,
                          data: { bankDepositId: linkPayoutFor },
                        })
                        .then(() => {
                          setLinkPayoutFor(null);
                          invalidate();
                        });
                    }}
                  >
                    <span>
                      <span className="block font-medium">
                        {candidate.payoutId}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {candidate.arrivalDate} ·{" "}
                        {formatCurrency(candidate.amount)} {candidate.currency}
                      </span>
                    </span>
                    {candidate.currentBankDepositId ? (
                      <span className="text-right text-[11px] text-muted-foreground">
                        currently on {candidate.currentDepositDate ?? "undated"}
                        {candidate.ambiguous ? " · ambiguous" : ""}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        unlinked
                      </span>
                    )}
                  </button>
                ),
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                No matching paid payouts found in the candidate window.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={unlinkPayoutFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setUnlinkPayoutFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink payout?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes only the Stripe payout → bank deposit tie. It does
              not change payment applications, bank components, payment units,
              or gifts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!unlinkPayoutFor) return;
                void unlinkPayout
                  .mutateAsync({ payoutId: unlinkPayoutFor })
                  .then(() => {
                    setUnlinkPayoutFor(null);
                    invalidate();
                  });
              }}
            >
              Unlink payout
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmPayoutFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmPayoutFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm payout match?</AlertDialogTitle>
            <AlertDialogDescription>
              This confirms the guessed Stripe payout → bank deposit tie without
              changing the linked deposit or any counted money.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!confirmPayoutFor) return;
                void confirmPayoutBankMatch
                  .mutateAsync({ payoutId: confirmPayoutFor })
                  .then(() => {
                    setConfirmPayoutFor(null);
                    invalidate();
                  });
              }}
            >
              Confirm match
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={bankExclusionFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setBankExclusionFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark deposit as not fundraising</AlertDialogTitle>
            <AlertDialogDescription>
              This records only a deposit-level decision and does not change
              payment units, components, payment applications, or gifts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="deposit-exclusion-reason"
              >
                Reason
              </label>
              <Select
                value={bankExclusionReason}
                onValueChange={(value) =>
                  setBankExclusionReason(value as DepositExclusionReason)
                }
              >
                <SelectTrigger id="deposit-exclusion-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPOSIT_EXCLUSION_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>
                      {reason.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="deposit-exclusion-note"
              >
                Note (optional)
              </label>
              <Textarea
                id="deposit-exclusion-note"
                value={bankExclusionNote}
                onChange={(event) => setBankExclusionNote(event.target.value)}
                placeholder="Add context for this decision"
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!bankExclusionFor) return;
                void setBankDepositExclusion
                  .mutateAsync({
                    bankDepositId: bankExclusionFor.depositId,
                    data: {
                      reason: bankExclusionReason,
                      note: bankExclusionNote.trim() || null,
                    },
                  })
                  .then(() => {
                    setBankExclusionFor(null);
                    invalidate();
                  });
              }}
            >
              Save decision
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={payoutCandidateFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setPayoutCandidateFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Link payout to a different deposit
            </AlertDialogTitle>
            <AlertDialogDescription>
              Choose a free bank deposit after the payout arrival date.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {candidateDeposits.isLoading ? (
              <p className="text-sm text-muted-foreground">
                Loading candidate deposits…
              </p>
            ) : candidateDeposits.isError ? (
              <p className="text-sm text-destructive">
                Could not load candidate deposits.
              </p>
            ) : candidateDeposits.data?.data.length ? (
              candidateDeposits.data.data.map(
                (candidate: PayoutCandidateDeposit) => (
                  <button
                    key={candidate.bankDepositId}
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                    disabled={busy}
                    onClick={() => {
                      if (!payoutCandidateFor) return;
                      void linkPayout
                        .mutateAsync({
                          payoutId: payoutCandidateFor,
                          data: { bankDepositId: candidate.bankDepositId },
                        })
                        .then(() => {
                          setPayoutCandidateFor(null);
                          invalidate();
                        });
                    }}
                  >
                    <span>
                      <span className="block font-medium">
                        {candidate.depositDate} ·{" "}
                        {formatCurrency(candidate.amount)} {candidate.currency}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.memo ?? candidate.bankDepositId}
                      </span>
                    </span>
                    <span className="text-right text-[11px] text-muted-foreground">
                      {candidate.claimed
                        ? `currently claimed${candidate.ambiguous ? " · ambiguous" : ""}`
                        : "free"}
                    </span>
                  </button>
                ),
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                No matching deposits found in the candidate window.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={refundFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setRefundFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm{" "}
              {refundFor?.kind === "chargeback" ? "chargeback" : "refund"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the transaction from live payment evidence without
              changing the gift.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!refundFor) return;
                void confirmRefund
                  .mutateAsync({ id: refundFor.chargeId })
                  .then(() => {
                    setRefundFor(null);
                    invalidate();
                  });
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={dismissFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setDismissFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss reversal proposal?</AlertDialogTitle>
            <AlertDialogDescription>
              {dismissFor?.label} stays booked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!dismissFor) return;
                void dismissRefund
                  .mutateAsync({ id: dismissFor.chargeId })
                  .then(() => {
                    setDismissFor(null);
                    invalidate();
                  });
              }}
            >
              Dismiss
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={accountingDispositionFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setAccountingDispositionFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {accountingDispositionFor?.disposition === "accepted_historical"
                ? "Accept historical accounting?"
                : "Mark accounting corrected?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This records a human review decision on the accounting check only.
              It does not change money or gift relationships.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {accountingDispositionFor?.disposition === "accepted_historical" ? (
            <Textarea
              value={accountingDispositionNote}
              onChange={(event) =>
                setAccountingDispositionNote(event.target.value)
              }
              placeholder="Explain why this historical discrepancy is intentionally accepted"
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                busy ||
                (accountingDispositionFor?.disposition ===
                  "accepted_historical" &&
                  !accountingDispositionNote.trim())
              }
              onClick={() => void handleAccountingDisposition()}
            >
              Save disposition
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {settlementSearchFor ? (
        <ResolveTieDialog
          anchor={{
            anchorId: settlementSearchFor.payoutId,
            amount: settlementSearchFor.amount,
            date: settlementSearchFor.date,
          }}
          open
          onOpenChange={(open) => {
            if (!open) setSettlementSearchFor(null);
          }}
          onPick={(id, options: PickOptions) => {
            if (!settlementSearchFor) return;
            void confirmSettlement
              .mutateAsync({
                payoutId: settlementSearchFor.payoutId,
                data: {
                  depositStagedPaymentId: id,
                  ...(options?.overrideExclusion
                    ? { overrideExclusion: true }
                    : {}),
                },
              })
              .then(() => {
                setSettlementSearchFor(null);
                invalidate();
              });
          }}
          busy={busy}
        />
      ) : null}
      {tieChargeFor ? (
        <TieChargeQbDialog
          payoutId={tieChargeFor.payoutId}
          charge={tieChargeFor.charge}
          open
          onOpenChange={(open) => {
            if (!open) setTieChargeFor(null);
          }}
          onPick={(id, options) => void handleChargeQbPick(id, options)}
          busy={busy}
        />
      ) : null}
      {componentQbFor ? (
        <TieChargeQbDialog
          payoutId=""
          charge={componentQbFor.charge}
          mode="component"
          open
          onOpenChange={(open) => {
            if (!open) setComponentQbFor(null);
          }}
          onPick={(id) => void handleComponentQbPick(id)}
          busy={busy}
        />
      ) : null}
      <AlertDialog
        open={clearComponentQbFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setClearComponentQbFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear QuickBooks source?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears only the direct payment's source pointer. It does not
              change its amount, deposit composition, gift, or payment
              applications.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleClearComponentQbSource()}
            >
              Clear source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <QbRecordDetailDialog
        open={qbDetailFor != null}
        onOpenChange={(open) => {
          if (!open) setQbDetailFor(null);
        }}
        record={qbDetailFor?.record ?? null}
        linkage={qbDetailFor?.linkage ?? null}
      />
      <MergeGiftsDialog
        open={mergeGiftIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setMergeGiftIds([]);
        }}
        gifts={mergeRecords}
        expectedCount={mergeGiftIds.length}
        loadError={mergeQueries.some((query) => query.isError)}
        onDone={() => {
          setMergeGiftIds([]);
          invalidate();
        }}
      />
    </div>
  );
}
