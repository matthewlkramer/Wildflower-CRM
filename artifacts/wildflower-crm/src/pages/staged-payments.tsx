import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  useListStagedPayments,
  getListStagedPaymentsQueryKey,
  getGetStagedPaymentsSummaryQueryKey,
  useGetStagedPaymentsSummary,
  useResolveStagedPayment,
  useCreateGiftFromStagedPayment,
  useRejectStagedPayment,
  useReIncludeStagedPayment,
  useReconcileStagedPayment,
  useRevertStagedPayment,
  useExcludeStagedPayment,
  useConfirmStagedPaymentMatch,
  useUnmatchStagedPayment,
  useListStagedPaymentGiftCandidates,
  getListStagedPaymentGiftCandidatesQueryKey,
  useListStagedPaymentGiftWindow,
  getListStagedPaymentGiftWindowQueryKey,
  useRunQuickbooksSync,
  useRematchStagedPayments,
  useReclassifyStagedPayments,
  useGetCurrentUser,
  useCreateOrganization,
  useCreatePerson,
  useCreateHousehold,
  getGetQuickbooksOauthStatusQueryKey,
  type StagedPayment,
  type StagedPaymentQueue,
  type StagedPaymentExclusionReason,
  type StagedPaymentMatchMethod,
  type QuickbooksEntityType,
  type GiftCandidate,
  type GiftCandidateList,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";

// The five reconciliation queues. `needs_review` holds uncertain pending rows;
// `auto_matched` holds high-confidence rows the system already applied (awaiting
// a quick human confirm); `done` holds confirmed / manually-resolved rows;
// `excluded` holds non-gift noise; `rejected` holds discarded rows.
const QUEUES: { value: StagedPaymentQueue; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "auto_matched", label: "Auto-matched" },
  { value: "done", label: "Done" },
  { value: "excluded", label: "Excluded" },
  { value: "rejected", label: "Rejected" },
];

// Human-friendly labels for the auto-exclude reasons.
const EXCLUSION_REASON_LABELS: Record<StagedPaymentExclusionReason, string> = {
  zero_amount: "Zero amount",
  loan: "Loan activity",
  membership: "Membership dues",
  interest: "Interest / investment income",
  government_reimbursement: "Government reimbursement",
  tax_refund: "Tax / insurance refund",
  other_revenue: "Other revenue (non-gift)",
  earned_income: "Earned income (non-gift)",
};

// QuickBooks entity types are stored snake_case (matching the DB enum); show a
// human-friendly label in the review queue.
const QB_ENTITY_TYPE_LABELS: Record<QuickbooksEntityType, string> = {
  sales_receipt: "Sales Receipt",
  payment: "Payment",
  deposit: "Deposit",
};

// How the scored matcher arrived at the donor/gift suggestion.
const MATCH_METHOD_LABELS: Record<StagedPaymentMatchMethod, string> = {
  email: "Email match",
  name: "Name match",
  name_amount_date: "Name + amount + date",
  amount_date: "Amount + date",
  memo: "Memo match",
  intermediary: "Payment intermediary",
  manual: "Manual",
};

function donorTypeFromRow(row: StagedPayment): DonorType {
  if (row.organizationId != null) return "organization";
  if (row.individualGiverPersonId != null) return "individual";
  if (row.householdId != null) return "household";
  return "organization";
}

function donorIdFromRow(row: StagedPayment, t: DonorType): string | null {
  if (t === "organization") return row.organizationId ?? null;
  if (t === "individual") return row.individualGiverPersonId ?? null;
  return row.householdId ?? null;
}

function donorNameFromRow(row: StagedPayment): string | null {
  return (
    row.organizationName ??
    row.individualGiverPersonName ??
    row.householdName ??
    null
  );
}

function formatAmount(amount: string | null | undefined): string {
  if (amount == null) return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

// When a candidate gift is larger than the QB net amount, surface the gap as a
// likely processing fee so the fundraiser understands why a non-exact match
// surfaced (e.g. CRM $50 gift vs. QB $47.25 deposit → "+$2.75 fee?").
function feeDeltaLabel(
  stagedAmount: string | null | undefined,
  giftAmount: string | null | undefined,
): string {
  if (stagedAmount == null || giftAmount == null) return "";
  const staged = Number(stagedAmount);
  const gift = Number(giftAmount);
  if (Number.isNaN(staged) || Number.isNaN(gift)) return "";
  const delta = gift - staged;
  if (delta <= 0.01) return "";
  return ` · +${delta.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  })} fee?`;
}

// Three derived donor-match states for the badge / actions:
//   unmatched  — no donor (matchStatus "unmatched")
//   suggested  — system suggested a donor, not yet human-confirmed
//   confirmed  — a human picked/confirmed the donor (matchConfirmedAt set)
type MatchState = "unmatched" | "suggested" | "confirmed";

function matchStateOf(row: StagedPayment): MatchState {
  // matchConfirmedAt is the ONLY signal for "confirmed" — a human acted. A
  // system-set matchStatus of "matched" (e.g. the high-tier rematch path) is
  // still only a suggestion until confirmed, so it must offer the Confirm action
  // rather than masquerade as confirmed.
  if (row.matchConfirmedAt != null) return "confirmed";
  const hasDonor =
    row.organizationId != null ||
    row.individualGiverPersonId != null ||
    row.householdId != null;
  if (!hasDonor || row.matchStatus === "unmatched") return "unmatched";
  return "suggested";
}

const MATCH_STATE_LABEL: Record<MatchState, string> = {
  unmatched: "Unmatched",
  suggested: "Suggested",
  confirmed: "Confirmed",
};

export default function StagedPayments() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [queue, setQueue] = useState<StagedPaymentQueue>("needs_review");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const me = useGetCurrentUser().data ?? null;
  const isAdmin = me?.role === "admin";

  const listParams = { queue, limit: PAGE_SIZE, page };
  const listQ = useListStagedPayments(listParams, {
    query: { queryKey: getListStagedPaymentsQueryKey(listParams) },
  });
  const summaryQ = useGetStagedPaymentsSummary({
    query: { queryKey: getGetStagedPaymentsSummaryQueryKey() },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["/staged-payments"] });
    qc.invalidateQueries({ queryKey: getGetStagedPaymentsSummaryQueryKey() });
  };

  // ── Inline donor creation (org / person / household) ──────────────────────
  const createOrg = useCreateOrganization();
  const createPerson = useCreatePerson();
  const createHousehold = useCreateHousehold();

  const onCreateOrganization = (name: string): Promise<string | null> =>
    new Promise((resolve) => {
      createOrg.mutate(
        { data: { name } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: (e: unknown) => {
            toast({
              title: "Create organization failed",
              description: e instanceof Error ? e.message : "Unknown error",
              variant: "destructive",
            });
            resolve(null);
          },
        },
      );
    });

  const onCreatePerson = (name: string): Promise<string | null> =>
    new Promise((resolve) => {
      createPerson.mutate(
        { data: { fullName: name } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: (e: unknown) => {
            toast({
              title: "Create person failed",
              description: e instanceof Error ? e.message : "Unknown error",
              variant: "destructive",
            });
            resolve(null);
          },
        },
      );
    });

  const onCreateHousehold = (name: string): Promise<string | null> =>
    new Promise((resolve) => {
      createHousehold.mutate(
        { data: { name } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: (e: unknown) => {
            toast({
              title: "Create household failed",
              description: e instanceof Error ? e.message : "Unknown error",
              variant: "destructive",
            });
            resolve(null);
          },
        },
      );
    });

  const syncNow = useRunQuickbooksSync({
    mutation: {
      onSuccess: (data) => {
        invalidateAll();
        qc.invalidateQueries({
          queryKey: getGetQuickbooksOauthStatusQueryKey(),
        });
        toast({
          title: "Sync complete",
          description: data.ran
            ? `Pulled ${data.pulled}, staged ${data.staged} new (${data.autoApplied} auto-applied, ${data.matched} matched).`
            : "A sync was already in progress.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Sync failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const rematch = useRematchStagedPayments({
    mutation: {
      onSuccess: (data) => {
        invalidateAll();
        toast({
          title: data.ran ? "Re-match complete" : "Re-match skipped",
          description: data.ran
            ? `Checked ${data.scanned} unmatched, newly suggested ${data.matched}.`
            : "A sync or re-match was already in progress.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Re-match failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const reclassify = useReclassifyStagedPayments({
    mutation: {
      onSuccess: (data) => {
        invalidateAll();
        toast({
          title: data.ran ? "Reclassify complete" : "Reclassify skipped",
          description: data.ran
            ? `Scanned ${data.scanned}; excluded ${data.excluded}, restored ${data.included}.`
            : "A sync, re-match, or reclassify was already in progress.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Reclassify failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const rows = listQ.data?.data ?? [];
  const total = listQ.data?.pagination?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summary = summaryQ.data;

  // If the queue shrinks (after a sync / resolve / reject), pull the user back
  // onto a valid page instead of stranding them on an empty one.
  useEffect(() => {
    if (!listQ.isFetching && page > totalPages) setPage(totalPages);
  }, [listQ.isFetching, page, totalPages]);

  const countFor = (q: StagedPaymentQueue): number | undefined => {
    if (!summary) return undefined;
    switch (q) {
      case "needs_review":
        return summary.needsReview;
      case "auto_matched":
        return summary.autoMatched;
      case "done":
        return summary.done;
      case "excluded":
        return summary.excluded;
      case "rejected":
        return summary.rejected;
    }
  };

  const activeLabel =
    QUEUES.find((q) => q.value === queue)?.label.toLowerCase() ?? "";

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            QuickBooks Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Incoming payments pulled from QuickBooks. High-confidence matches are
            applied automatically (reversible); uncertain ones land in “Needs
            review” for you to reconcile to an existing gift or record a new one.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => reclassify.mutate()}
              disabled={
                reclassify.isPending || rematch.isPending || syncNow.isPending
              }
              data-testid="staged-reclassify"
              title="Re-run the non-gift classifier over auto-classified rows. Never touches a category you set by hand."
            >
              {reclassify.isPending ? "Reclassifying…" : "Reclassify"}
            </Button>
            <Button
              variant="outline"
              onClick={() => rematch.mutate()}
              disabled={
                rematch.isPending || syncNow.isPending || reclassify.isPending
              }
              data-testid="staged-rematch"
              title="Re-run donor auto-match over still-unmatched rows. Never overwrites a match you've already made."
            >
              {rematch.isPending ? "Re-matching…" : "Re-run matching"}
            </Button>
            <Button
              onClick={() => syncNow.mutate()}
              disabled={
                syncNow.isPending || rematch.isPending || reclassify.isPending
              }
              data-testid="staged-sync-now"
            >
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {QUEUES.map((q) => {
          const c = countFor(q.value);
          return (
            <Button
              key={q.value}
              variant={queue === q.value ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setQueue(q.value);
                setPage(1);
              }}
              data-testid={`staged-tab-${q.value}`}
            >
              {q.label}
              {typeof c === "number" ? (
                <span className="ml-2 text-xs opacity-70">{c}</span>
              ) : null}
            </Button>
          );
        })}
      </div>

      {listQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : listQ.isError ? (
        <p className="text-sm text-red-700">Failed to load staged payments.</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {activeLabel} payments.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <StagedPaymentCard
              key={row.id}
              row={row}
              queue={queue}
              onChanged={invalidateAll}
              onCreateOrganization={onCreateOrganization}
              onCreatePerson={onCreatePerson}
              onCreateHousehold={onCreateHousehold}
            />
          ))}
        </div>
      )}

      {total > PAGE_SIZE || page > 1 ? (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || listQ.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="staged-page-prev"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || listQ.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              data-testid="staged-page-next"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StagedPaymentCard({
  row,
  queue,
  onChanged,
  onCreateOrganization,
  onCreatePerson,
  onCreateHousehold,
}: {
  row: StagedPayment;
  queue: StagedPaymentQueue;
  onChanged: () => void;
  onCreateOrganization: (name: string) => Promise<string | null>;
  onCreatePerson: (name: string) => Promise<string | null>;
  onCreateHousehold: (name: string) => Promise<string | null>;
}) {
  const { toast } = useToast();
  const initialType = donorTypeFromRow(row);
  const [donorType, setDonorType] = useState<DonorType>(initialType);
  const [donorId, setDonorId] = useState<string | null>(
    donorIdFromRow(row, initialType),
  );
  // Keep local donor selection in sync if the server row changes underneath us.
  useEffect(() => {
    const t = donorTypeFromRow(row);
    setDonorType(t);
    setDonorId(donorIdFromRow(row, t));
  }, [
    row.id,
    row.organizationId,
    row.individualGiverPersonId,
    row.householdId,
  ]);

  const editable = queue === "needs_review";
  const isExcluded = queue === "excluded";

  const resolve = useResolveStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({ title: "Donor updated" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Update failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const createGift = useCreateGiftFromStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Gift created",
          description: "A new gift was recorded from this payment.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Create gift failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const reject = useRejectStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({ title: "Rejected" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Reject failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const reInclude = useReIncludeStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Re-included",
          description: "Moved back to the needs-review queue.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Re-include failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const confirmMatch = useConfirmStagedPaymentMatch({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({ title: "Match confirmed" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Confirm failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const unmatch = useUnmatchStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({ title: "Match cleared" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Unmatch failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const reconcile = useReconcileStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Reconciled",
          description: "Tied to an existing gift — no new gift was created.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Reconcile failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const revert = useRevertStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Reverted",
          description: "Returned to the needs-review queue.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Revert failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  // Seeded from the row so re-classifying an already-excluded row pre-selects
  // its current category; pending rows start blank to force an explicit choice.
  const [excludeReason, setExcludeReason] = useState<
    StagedPaymentExclusionReason | ""
  >(row.exclusionReason ?? "");
  useEffect(() => {
    setExcludeReason(row.exclusionReason ?? "");
  }, [row.id, row.exclusionReason]);
  const exclude = useExcludeStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Excluded",
          description: "Filed under a non-gift category. Re-include if wrong.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Exclude failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const [showReconciler, setShowReconciler] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const busy =
    resolve.isPending ||
    createGift.isPending ||
    reject.isPending ||
    reInclude.isPending ||
    exclude.isPending ||
    confirmMatch.isPending ||
    unmatch.isPending ||
    reconcile.isPending ||
    revert.isPending;

  const hasDonor = donorId != null;
  const matchState = matchStateOf(row);
  const hasSavedDonor =
    row.organizationId != null ||
    row.individualGiverPersonId != null ||
    row.householdId != null;

  const handleSaveDonor = () => {
    resolve.mutate({ id: row.id, data: donorBodyFor(donorType, donorId) });
  };

  const donorLabel = donorNameFromRow(row);

  // Revert is allowed for reconciled rows (link cleared) and auto-minted gifts
  // (gift deleted), but not for a manually created gift (would orphan a row).
  const wasReconciled = row.matchedGiftId != null;
  const wasAutoMinted = row.createdGiftId != null && row.autoApplied;
  const canRevert = wasReconciled || wasAutoMinted;

  return (
    <Card data-testid={`staged-payment-${row.id}`}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-lg">
              {row.payerName ?? "Unknown payer"}
              <span className="ml-2 text-base font-normal text-muted-foreground">
                {formatAmount(row.amount)}
              </span>
            </CardTitle>
            <CardDescription>
              {QB_ENTITY_TYPE_LABELS[row.qbEntityType] ?? row.qbEntityType} ·{" "}
              {row.dateReceived ?? "no date"}
              {row.payerEmail ? ` · ${row.payerEmail}` : ""}
              {row.rawReference ? ` · ${row.rawReference}` : ""}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {row.autoApplied && (queue === "auto_matched" || queue === "done") ? (
              <Badge variant="outline" data-testid={`staged-auto-${row.id}`}>
                Auto-applied
              </Badge>
            ) : null}
            {typeof row.matchScore === "number" ? (
              <Badge
                variant="secondary"
                data-testid={`staged-score-${row.id}`}
                title={
                  row.matchMethod
                    ? MATCH_METHOD_LABELS[row.matchMethod] ?? row.matchMethod
                    : undefined
                }
              >
                {row.matchScore}% match
              </Badge>
            ) : null}
            {isExcluded && row.exclusionReason ? (
              <Badge variant="secondary">
                {EXCLUSION_REASON_LABELS[row.exclusionReason] ??
                  row.exclusionReason}
              </Badge>
            ) : !isExcluded && queue !== "rejected" ? (
              <Badge
                variant={
                  matchState === "confirmed"
                    ? "default"
                    : matchState === "suggested"
                      ? "outline"
                      : "secondary"
                }
                data-testid={`staged-match-state-${row.id}`}
              >
                {MATCH_STATE_LABEL[matchState]}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {editable ? (
          <>
            <div>
              <label className="text-sm font-medium">Donor</label>
              <div className="mt-1">
                <DonorFieldPicker
                  type={donorType}
                  id={donorId}
                  onChange={(t, id) => {
                    setDonorType(t);
                    setDonorId(id);
                  }}
                  testIdBase={`staged-donor-${row.id}`}
                  disabled={busy}
                  onCreateOrganization={onCreateOrganization}
                  onCreatePerson={onCreatePerson}
                  onCreateHousehold={onCreateHousehold}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveDonor}
                disabled={busy || !hasDonor}
                data-testid={`staged-save-donor-${row.id}`}
              >
                Save donor
              </Button>
              {matchState === "suggested" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => confirmMatch.mutate({ id: row.id })}
                  disabled={busy}
                  data-testid={`staged-confirm-match-${row.id}`}
                  title="Confirm the system-suggested donor as human-approved."
                >
                  {confirmMatch.isPending ? "Confirming…" : "Confirm donor"}
                </Button>
              ) : null}
              {matchState !== "unmatched" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => unmatch.mutate({ id: row.id })}
                  disabled={busy}
                  data-testid={`staged-unmatch-${row.id}`}
                  title="Clear the donor and reset this row to unmatched."
                >
                  {unmatch.isPending ? "Clearing…" : "Unmatch"}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowReconciler((v) => !v)}
                disabled={busy}
                data-testid={`staged-reconcile-toggle-${row.id}`}
              >
                {showReconciler
                  ? "Hide existing gifts"
                  : "Reconcile to existing gift"}
              </Button>
              <Button
                size="sm"
                onClick={() => createGift.mutate({ id: row.id })}
                disabled={busy || !hasDonor}
                data-testid={`staged-create-gift-${row.id}`}
              >
                {createGift.isPending ? "Creating…" : "Create new gift"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => reject.mutate({ id: row.id })}
                disabled={busy}
                data-testid={`staged-reject-${row.id}`}
              >
                Reject
              </Button>
              <div className="flex items-center gap-2">
                <Select
                  value={excludeReason}
                  onValueChange={(v) =>
                    setExcludeReason(v as StagedPaymentExclusionReason)
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    className="h-9 w-[210px]"
                    data-testid={`staged-exclude-reason-${row.id}`}
                  >
                    <SelectValue placeholder="Exclude as…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(EXCLUSION_REASON_LABELS).map(
                      ([value, label]) => (
                        <SelectItem
                          key={value}
                          value={value}
                          data-testid={`staged-exclude-reason-${row.id}-${value}`}
                        >
                          {label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !excludeReason}
                  onClick={() =>
                    excludeReason &&
                    exclude.mutate({
                      id: row.id,
                      data: { exclusionReason: excludeReason },
                    })
                  }
                  data-testid={`staged-exclude-${row.id}`}
                >
                  {exclude.isPending ? "Excluding…" : "Exclude"}
                </Button>
              </div>
            </div>
            {!hasDonor ? (
              <p className="text-xs text-muted-foreground">
                Pick a donor before creating a new gift, or reconcile to an
                existing gift below (which can adopt the gift’s donor).
              </p>
            ) : null}
            {showReconciler ? (
              <Reconciler
                row={row}
                hasSavedDonor={hasSavedDonor}
                onReconcile={(giftId) =>
                  reconcile.mutate({ id: row.id, data: { giftId } })
                }
                reconciling={reconcile.isPending}
              />
            ) : null}
          </>
        ) : isExcluded ? (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Excluded as a non-gift
              {row.exclusionReason
                ? ` (${EXCLUSION_REASON_LABELS[row.exclusionReason] ?? row.exclusionReason})`
                : ""}
              {row.classificationSource === "manual"
                ? " — set by hand"
                : " — auto-classified"}
              . Not deleted — re-include it, or change its category below.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => reInclude.mutate({ id: row.id })}
                disabled={busy}
                data-testid={`staged-re-include-${row.id}`}
              >
                {reInclude.isPending ? "Re-including…" : "Re-include → review"}
              </Button>
              <Select
                value={excludeReason}
                onValueChange={(v) =>
                  setExcludeReason(v as StagedPaymentExclusionReason)
                }
                disabled={busy}
              >
                <SelectTrigger
                  className="h-9 w-[210px]"
                  data-testid={`staged-reclassify-reason-${row.id}`}
                >
                  <SelectValue placeholder="Change category…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXCLUSION_REASON_LABELS).map(
                    ([value, label]) => (
                      <SelectItem
                        key={value}
                        value={value}
                        data-testid={`staged-reclassify-reason-${row.id}-${value}`}
                      >
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  busy || !excludeReason || excludeReason === row.exclusionReason
                }
                onClick={() =>
                  excludeReason &&
                  exclude.mutate({
                    id: row.id,
                    data: { exclusionReason: excludeReason },
                  })
                }
                data-testid={`staged-reclassify-${row.id}`}
              >
                {exclude.isPending ? "Updating…" : "Update category"}
              </Button>
            </div>
          </div>
        ) : queue === "rejected" ? (
          <div className="text-sm text-muted-foreground">
            Rejected{row.rejectedAt ? ` · ${formatDateTime(row.rejectedAt)}` : ""}
            . Retained so a future sync won’t re-stage it.
          </div>
        ) : (
          // auto_matched + done: show the applied result + confirm / revert.
          <ResolvedSummary
            row={row}
            queue={queue}
            donorLabel={donorLabel}
            busy={busy}
            canRevert={canRevert}
            confirming={confirmMatch.isPending}
            reverting={revert.isPending}
            onConfirm={() => confirmMatch.mutate({ id: row.id })}
            onRevert={() => revert.mutate({ id: row.id })}
          />
        )}
        <StagedPaymentDetails
          row={row}
          donorLabel={donorLabel}
          show={showDetails}
          onToggle={() => setShowDetails((v) => !v)}
        />
      </CardContent>
    </Card>
  );
}

// Summary of an applied (approved) row for the Auto-matched / Done queues:
// what gift it was tied to, plus Confirm (auto_matched → done) and Revert.
function ResolvedSummary({
  row,
  queue,
  donorLabel,
  busy,
  canRevert,
  confirming,
  reverting,
  onConfirm,
  onRevert,
}: {
  row: StagedPayment;
  queue: StagedPaymentQueue;
  donorLabel: string | null;
  busy: boolean;
  canRevert: boolean;
  confirming: boolean;
  reverting: boolean;
  onConfirm: () => void;
  onRevert: () => void;
}) {
  const reconciled = row.matchedGiftId != null;
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        Donor: {donorLabel ?? "—"}
        {row.intermediaryName ? ` · via ${row.intermediaryName}` : ""}
      </div>
      <div className="text-sm">
        {reconciled
          ? "Reconciled to an existing gift"
          : "New gift created from this payment"}
        {row.resolvedGiftName ? (
          <span className="text-muted-foreground">
            {" — "}
            {row.resolvedGiftName}
            {row.resolvedGiftAmount
              ? ` · ${formatAmount(row.resolvedGiftAmount)}`
              : ""}
            {row.resolvedGiftDate ? ` · ${row.resolvedGiftDate}` : ""}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {queue === "auto_matched" ? (
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            data-testid={`staged-confirm-auto-${row.id}`}
            title="Confirm this auto-applied match as reviewed; moves it to Done."
          >
            {confirming ? "Confirming…" : "Looks right → confirm"}
          </Button>
        ) : null}
        {canRevert ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRevert}
            disabled={busy}
            data-testid={`staged-revert-${row.id}`}
            title={
              reconciled
                ? "Undo the link and return to review. The existing gift is untouched."
                : "Delete the auto-created gift and return to review."
            }
          >
            {reverting ? "Reverting…" : "Revert"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground self-center">
            Manually created gift — revert from the gift record.
          </span>
        )}
      </div>
    </div>
  );
}

// Two-column reconciler: left lists candidate existing gifts, sourced either
// from the saved donor (tight amount band) or a donor-agnostic amount/date
// window. The fundraiser reconciles the staged payment to one of them.
function Reconciler({
  row,
  hasSavedDonor,
  onReconcile,
  reconciling,
}: {
  row: StagedPayment;
  hasSavedDonor: boolean;
  onReconcile: (giftId: string) => void;
  reconciling: boolean;
}) {
  const [source, setSource] = useState<"donor" | "window">(
    hasSavedDonor ? "donor" : "window",
  );
  useEffect(() => {
    if (!hasSavedDonor) setSource("window");
  }, [hasSavedDonor]);

  const donorQ = useListStagedPaymentGiftCandidates(row.id, {
    query: {
      enabled: source === "donor" && hasSavedDonor,
      queryKey: getListStagedPaymentGiftCandidatesQueryKey(row.id),
    },
  });
  const windowParams = { days: 30 };
  const windowQ = useListStagedPaymentGiftWindow(row.id, windowParams, {
    query: {
      enabled: source === "window",
      queryKey: getListStagedPaymentGiftWindowQueryKey(row.id, windowParams),
    },
  });
  const activeQ = source === "donor" ? donorQ : windowQ;

  return (
    <div
      className="rounded-md border"
      data-testid={`staged-reconciler-${row.id}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-2">
        {/* Left column: the QuickBooks payment we're reconciling. */}
        <div className="border-b p-3 md:border-b-0 md:border-r">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            QuickBooks payment
          </div>
          <div className="text-sm font-medium">
            {row.payerName ?? "Unknown payer"} {formatAmount(row.amount)}
          </div>
          <div className="text-xs text-muted-foreground">
            {QB_ENTITY_TYPE_LABELS[row.qbEntityType] ?? row.qbEntityType} ·{" "}
            {row.dateReceived ?? "no date"}
          </div>
          {row.lineDescription ? (
            <div className="mt-1 text-xs text-muted-foreground break-words">
              {row.lineDescription}
            </div>
          ) : null}
        </div>

        {/* Right column: candidate existing gifts. */}
        <div className="p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Existing gifts
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={source === "donor" ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setSource("donor")}
                disabled={!hasSavedDonor}
                data-testid={`staged-reconciler-source-donor-${row.id}`}
                title={
                  hasSavedDonor
                    ? "Gifts for the saved donor near this amount."
                    : "Save a donor first to search their gifts."
                }
              >
                This donor
              </Button>
              <Button
                size="sm"
                variant={source === "window" ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setSource("window")}
                data-testid={`staged-reconciler-source-window-${row.id}`}
                title="Any donor's gifts within ±30 days and this amount."
              >
                Amount + date
              </Button>
            </div>
          </div>
          <GiftCandidateList
            row={row}
            query={activeQ}
            showDonor={source === "window"}
            onReconcile={onReconcile}
            reconciling={reconciling}
          />
        </div>
      </div>
    </div>
  );
}

function GiftCandidateList({
  row,
  query,
  showDonor,
  onReconcile,
  reconciling,
}: {
  row: StagedPayment;
  query: UseQueryResult<GiftCandidateList>;
  showDonor: boolean;
  onReconcile: (giftId: string) => void;
  reconciling: boolean;
}) {
  const candidates: GiftCandidate[] = query.data?.data ?? [];

  if (query.isLoading) {
    return <p className="text-xs text-muted-foreground">Searching…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-xs text-destructive">
        Could not load candidates. Try again.
      </p>
    );
  }
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No matching gift found. Use “Create new gift” to record one.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {candidates.map((c) => {
        const alreadyLinked = c.alreadyLinkedStagedPaymentId != null;
        const donorName =
          c.organizationName ??
          c.individualGiverPersonName ??
          c.householdName ??
          null;
        return (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5"
            data-testid={`staged-candidate-${row.id}-${c.id}`}
          >
            <div className="min-w-0">
              <div className="truncate text-sm">
                {c.name ?? "Untitled gift"}
                <span className="ml-2 text-muted-foreground">
                  {formatAmount(c.amount)}
                </span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {showDonor && donorName ? `${donorName} · ` : ""}
                {c.dateReceived ?? "no date"}
                {c.type ? ` · ${c.type}` : ""}
                {feeDeltaLabel(row.amount, c.amount)}
                {alreadyLinked
                  ? " · already linked to a QuickBooks payment"
                  : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReconcile(c.id)}
              disabled={reconciling || alreadyLinked}
              data-testid={`staged-reconcile-${row.id}-${c.id}`}
            >
              {alreadyLinked ? "Linked" : "Reconcile"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

// Full, read-only dump of everything QuickBooks gave us for this row —
// including the per-line item / account / class arrays — so a fundraiser can
// see exactly what they are reconciling without leaving the page.
function StagedPaymentDetails({
  row,
  donorLabel,
  show,
  onToggle,
}: {
  row: StagedPayment;
  donorLabel: string | null;
  show: boolean;
  onToggle: () => void;
}) {
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "QuickBooks type",
      value: QB_ENTITY_TYPE_LABELS[row.qbEntityType] ?? row.qbEntityType,
    },
    { label: "QuickBooks entity ID", value: row.qbEntityId },
    { label: "QuickBooks line ID", value: row.qbLineId },
    { label: "Realm ID", value: row.realmId },
    { label: "Amount", value: formatAmount(row.amount) },
    { label: "Date received", value: row.dateReceived },
    { label: "Payer name", value: row.payerName },
    { label: "Payer email", value: row.payerEmail },
    { label: "Reference / memo", value: row.rawReference },
    { label: "Line description", value: row.lineDescription },
    { label: "Status", value: row.status },
    { label: "Match status", value: row.matchStatus },
    {
      label: "Match method",
      value: row.matchMethod
        ? (MATCH_METHOD_LABELS[row.matchMethod] ?? row.matchMethod)
        : null,
    },
    {
      label: "Match score",
      value: typeof row.matchScore === "number" ? `${row.matchScore}%` : null,
    },
    { label: "Classification", value: row.classificationSource },
    {
      label: "Exclusion reason",
      value: row.exclusionReason
        ? (EXCLUSION_REASON_LABELS[row.exclusionReason] ?? row.exclusionReason)
        : null,
    },
    { label: "Donor", value: donorLabel },
    { label: "Intermediary", value: row.intermediaryName },
    { label: "Reconciled gift ID", value: row.matchedGiftId },
    { label: "Created gift ID", value: row.createdGiftId },
    { label: "Auto-applied", value: row.autoApplied ? "Yes" : "No" },
    { label: "Confirmed at", value: formatDateTime(row.matchConfirmedAt) },
    { label: "Approved at", value: formatDateTime(row.approvedAt) },
    { label: "Rejected at", value: formatDateTime(row.rejectedAt) },
    { label: "First seen", value: formatDateTime(row.createdAt) },
    { label: "Last updated", value: formatDateTime(row.updatedAt) },
  ];

  const lineGroups: { label: string; values: string[] | null | undefined }[] = [
    { label: "Line items", values: row.lineItemNames },
    { label: "Line accounts", values: row.lineAccountNames },
    { label: "Line classes", values: row.lineClasses },
  ];

  return (
    <div className="border-t pt-3">
      <Button
        variant="ghost"
        size="sm"
        className="px-0 text-xs text-muted-foreground hover:bg-transparent"
        onClick={onToggle}
        data-testid={`staged-details-toggle-${row.id}`}
      >
        {show ? "Hide details" : "Show details"}
      </Button>
      {show ? (
        <div className="mt-2 space-y-3" data-testid={`staged-details-${row.id}`}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {rows.map((d) => (
              <div key={d.label} className="flex gap-2 text-sm">
                <dt className="min-w-[7.5rem] shrink-0 text-muted-foreground">
                  {d.label}
                </dt>
                <dd className="min-w-0 break-words">
                  {d.value === null || d.value === undefined || d.value === ""
                    ? "—"
                    : d.value}
                </dd>
              </div>
            ))}
          </dl>
          {lineGroups.map((g) => (
            <div key={g.label} className="text-sm">
              <div className="text-muted-foreground">{g.label}</div>
              {g.values && g.values.length > 0 ? (
                <ul className="ml-4 list-disc">
                  {g.values.map((v, i) => (
                    <li key={`${g.label}-${i}`} className="break-words">
                      {v}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="ml-1">—</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
