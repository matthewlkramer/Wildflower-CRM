import { useState } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  useListStagedPayments,
  getListStagedPaymentsQueryKey,
  getGetStagedPaymentsSummaryQueryKey,
  useGetStagedPaymentsSummary,
  useResolveStagedPayment,
  useApproveStagedPayment,
  useRejectStagedPayment,
  useReIncludeStagedPayment,
  useLinkStagedPayment,
  useListStagedPaymentGiftCandidates,
  getListStagedPaymentGiftCandidatesQueryKey,
  useRunQuickbooksSync,
  useGetCurrentUser,
  getGetQuickbooksOauthStatusQueryKey,
  type StagedPayment,
  type StagedPaymentStatus,
  type StagedPaymentExclusionReason,
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
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";

const STATUS_TABS: { value: StagedPaymentStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "excluded", label: "Excluded" },
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

function formatAmount(amount: string | null | undefined): string {
  if (amount == null) return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

export default function StagedPayments() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<StagedPaymentStatus>("pending");

  const me = useGetCurrentUser().data ?? null;
  const isAdmin = me?.role === "admin";

  const listQ = useListStagedPayments(
    { status, limit: 200 },
    {
      query: {
        queryKey: getListStagedPaymentsQueryKey({ status, limit: 200 }),
      },
    },
  );
  const summaryQ = useGetStagedPaymentsSummary({
    query: { queryKey: getGetStagedPaymentsSummaryQueryKey() },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["/staged-payments"] });
    qc.invalidateQueries({
      queryKey: getGetStagedPaymentsSummaryQueryKey(),
    });
  };

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
            ? `Pulled ${data.pulled}, staged ${data.staged} new (${data.matched} auto-matched).`
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

  const rows = listQ.data?.data ?? [];
  const summary = summaryQ.data;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            QuickBooks Review Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Incoming payments pulled from QuickBooks. Confirm the donor match
            and approve to create a gift, or reject to discard.
          </p>
        </div>
        {isAdmin ? (
          <Button
            onClick={() => syncNow.mutate()}
            disabled={syncNow.isPending}
            data-testid="staged-sync-now"
          >
            {syncNow.isPending ? "Syncing…" : "Sync now"}
          </Button>
        ) : null}
      </div>

      <div className="flex gap-2">
        {STATUS_TABS.map((tab) => {
          const c =
            tab.value === "pending"
              ? summary?.pending
              : tab.value === "approved"
                ? summary?.approved
                : tab.value === "rejected"
                  ? summary?.rejected
                  : summary?.excluded;
          return (
            <Button
              key={tab.value}
              variant={status === tab.value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatus(tab.value)}
              data-testid={`staged-tab-${tab.value}`}
            >
              {tab.label}
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
        <p className="text-sm text-red-700">
          Failed to load staged payments.
        </p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {status} payments.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <StagedPaymentCard
              key={row.id}
              row={row}
              editable={status === "pending"}
              excluded={status === "excluded"}
              onChanged={invalidateAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StagedPaymentCard({
  row,
  editable,
  excluded,
  onChanged,
}: {
  row: StagedPayment;
  editable: boolean;
  excluded: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const initialType = donorTypeFromRow(row);
  const [donorType, setDonorType] = useState<DonorType>(initialType);
  const [donorId, setDonorId] = useState<string | null>(
    donorIdFromRow(row, initialType),
  );

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
  const approve = useApproveStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Approved",
          description: "A gift was created from this payment.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Approve failed",
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
          description: "Moved back to the pending queue.",
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

  const [showCandidates, setShowCandidates] = useState(false);
  const link = useLinkStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Linked",
          description: "Tied to an existing gift — no new gift was created.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Link failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  // The server matches candidates against the SAVED donor on the row, so only
  // fetch once a donor is persisted (matchStatus flips to "matched" on save).
  const candidates = useListStagedPaymentGiftCandidates(row.id, {
    query: {
      enabled: showCandidates,
      queryKey: getListStagedPaymentGiftCandidatesQueryKey(row.id),
    },
  });

  const busy =
    resolve.isPending ||
    approve.isPending ||
    reject.isPending ||
    reInclude.isPending ||
    link.isPending;
  const hasDonor = donorId != null;
  // A donor persisted on the row (not just picked locally) is required for the
  // candidate search, since the server reads the saved donor FKs.
  const hasSavedDonor =
    row.organizationId != null ||
    row.individualGiverPersonId != null ||
    row.householdId != null;

  const handleSaveDonor = () => {
    resolve.mutate({
      id: row.id,
      data: donorBodyFor(donorType, donorId),
    });
  };

  const donorLabel =
    row.organizationName ??
    row.individualGiverPersonName ??
    row.householdName ??
    null;

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
          {excluded && row.exclusionReason ? (
            <Badge variant="secondary">
              {EXCLUSION_REASON_LABELS[row.exclusionReason] ??
                row.exclusionReason}
            </Badge>
          ) : (
            <Badge
              variant={row.matchStatus === "matched" ? "default" : "secondary"}
            >
              {row.matchStatus}
            </Badge>
          )}
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCandidates((v) => !v)}
                disabled={busy || !hasSavedDonor}
                data-testid={`staged-find-gift-${row.id}`}
              >
                {showCandidates ? "Hide existing gifts" : "Find existing gift"}
              </Button>
              <Button
                size="sm"
                onClick={() => approve.mutate({ id: row.id })}
                disabled={busy || !hasDonor}
                data-testid={`staged-approve-${row.id}`}
              >
                {approve.isPending ? "Approving…" : "Approve → create gift"}
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
            </div>
            {!hasDonor ? (
              <p className="text-xs text-muted-foreground">
                Pick a donor before approving.
              </p>
            ) : !hasSavedDonor ? (
              <p className="text-xs text-muted-foreground">
                Save the donor first to search for a matching existing gift.
              </p>
            ) : null}
            {showCandidates ? (
              <GiftCandidates
                row={row}
                query={candidates}
                onLink={(giftId) => link.mutate({ id: row.id, data: { giftId } })}
                linking={link.isPending}
              />
            ) : null}
          </>
        ) : excluded ? (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Auto-excluded as noise
              {row.exclusionReason
                ? ` (${EXCLUSION_REASON_LABELS[row.exclusionReason] ?? row.exclusionReason})`
                : ""}
              . Not deleted — re-include it if this was wrong.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => reInclude.mutate({ id: row.id })}
              disabled={busy}
              data-testid={`staged-re-include-${row.id}`}
            >
              {reInclude.isPending ? "Re-including…" : "Re-include → pending"}
            </Button>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            Donor: {donorLabel ?? "—"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Existing gifts that match this staged payment's donor + amount. Linking ties
// the QuickBooks record to one of these instead of minting a new gift.
function GiftCandidates({
  row,
  query,
  onLink,
  linking,
}: {
  row: StagedPayment;
  query: UseQueryResult<GiftCandidateList>;
  onLink: (giftId: string) => void;
  linking: boolean;
}) {
  const candidates: GiftCandidate[] = query.data?.data ?? [];

  return (
    <div
      className="rounded-md border p-3"
      data-testid={`staged-candidates-${row.id}`}
    >
      <div className="mb-2 text-sm font-medium">
        Existing gifts matching {formatAmount(row.amount)} for this donor
      </div>
      {query.isLoading ? (
        <p className="text-xs text-muted-foreground">Searching…</p>
      ) : query.isError ? (
        <p className="text-xs text-destructive">
          Could not load candidates. Try again.
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No matching gift found. Use “Approve → create gift” to record a new
          one.
        </p>
      ) : (
        <ul className="space-y-2">
          {candidates.map((c) => {
            const alreadyLinked = c.alreadyLinkedStagedPaymentId != null;
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
                    {c.dateReceived ?? "no date"}
                    {c.type ? ` · ${c.type}` : ""}
                    {alreadyLinked ? " · already linked to a QuickBooks payment" : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onLink(c.id)}
                  disabled={linking || alreadyLinked}
                  data-testid={`staged-link-${row.id}-${c.id}`}
                >
                  {alreadyLinked ? "Linked" : "Link"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
