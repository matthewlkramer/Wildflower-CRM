import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPendingStagedMoneyForDonorQueryKey,
  getSearchReconciliationQbStagedQueryKey,
  getGetGiftOrPaymentQueryKey,
  getGetOpportunityOrPledgeQueryKey,
  getListGiftsAndPaymentsQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  useApproveReconciliationCard,
  useCreateGiftFromStagedPayment,
  useCreateGiftFromStripeStagedCharge,
  useGetPendingStagedMoneyForDonor,
  useLinkStripeChargeToGift,
  useReconcileStagedPayment,
  useResolveStagedPayment,
  useResolveStripeStagedCharge,
  useSearchReconciliationQbStaged,
  type PendingDonorMoneyItem,
  type ReconciliationCandidate,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDateShort } from "@/lib/format";
import type { DonorType } from "@/components/entity-picker";

export type PaymentEvidenceDonor = {
  type: DonorType;
  id: string;
  name?: string | null;
};

export type PaymentEvidenceAction =
  | { kind: "create-standalone-gift" }
  | {
      kind: "create-from-opportunity";
      opportunityId: string;
      recordKind: "opportunity" | "pledge";
    }
  | { kind: "link-existing-gift"; giftId: string };

type EvidenceRow = {
  key: string;
  id: string;
  source: "quickbooks" | "stripe";
  amount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  description: string | null;
  paymentIntermediaryId?: string | null;
  conflictReason?: string | null;
  alreadyLinkedGiftId?: string | null;
  exactDonorMatch: boolean;
};

function pendingRow(item: PendingDonorMoneyItem): EvidenceRow {
  return {
    key: `${item.source}:${item.id}`,
    id: item.id,
    source: item.source,
    amount: item.amount ?? null,
    dateReceived: item.dateReceived ?? null,
    payerName: item.payerName ?? null,
    description: item.description ?? null,
    paymentIntermediaryId: item.paymentIntermediaryId ?? null,
    exactDonorMatch: true,
  };
}

function searchRow(item: ReconciliationCandidate): EvidenceRow | null {
  if (item.nodeType !== "qb" && item.nodeType !== "stripe") return null;
  return {
    key: `${item.nodeType === "qb" ? "quickbooks" : "stripe"}:${item.id}`,
    id: item.id,
    source: item.nodeType === "qb" ? "quickbooks" : "stripe",
    amount: item.amount ?? null,
    dateReceived: item.date ?? null,
    payerName: item.label ?? null,
    description: item.sublabel ?? null,
    conflictReason: item.conflictReason ?? null,
    alreadyLinkedGiftId: item.alreadyLinkedGiftId ?? null,
    exactDonorMatch: false,
  };
}

function donorBody(donor: PaymentEvidenceDonor) {
  return {
    organizationId: donor.type === "organization" ? donor.id : null,
    individualGiverPersonId: donor.type === "individual" ? donor.id : null,
    householdId: donor.type === "household" ? donor.id : null,
  };
}

function titleFor(action: PaymentEvidenceAction): string {
  if (action.kind === "link-existing-gift") return "Link payment evidence";
  if (action.kind === "create-from-opportunity") {
    return action.recordKind === "pledge"
      ? "Link a received payment"
      : "Record received gift";
  }
  return "Record received gift";
}

function descriptionFor(
  action: PaymentEvidenceAction,
  donorName: string,
): string {
  if (action.kind === "link-existing-gift") {
    return `Select the actual QuickBooks payment or Stripe charge that proves this gift from ${donorName} was received.`;
  }
  if (action.kind === "create-from-opportunity") {
    return action.recordKind === "pledge"
      ? `Select the actual payment received from ${donorName}. The payment evidence will create a pledge-payment gift; no payment can be created without received money.`
      : `Select the actual payment received from ${donorName}. The evidence will create the stand-alone gift and close the opportunity as a gift outcome.`;
  }
  return `Select the actual QuickBooks payment or Stripe charge received from ${donorName}. The evidence itself will create the gift.`;
}

export function PaymentEvidencePickerDialog({
  open,
  onOpenChange,
  donor,
  action,
  expectedAmount,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  donor: PaymentEvidenceDonor;
  action: PaymentEvidenceAction;
  expectedAmount?: string | null;
  onComplete?: (giftId: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 250);

  const donorParams = { donorType: donor.type, donorId: donor.id } as const;
  const pending = useGetPendingStagedMoneyForDonor(donorParams, {
    query: {
      enabled: open,
      queryKey: getGetPendingStagedMoneyForDonorQueryKey(donorParams),
    },
  });
  const broadSearch = useSearchReconciliationQbStaged(
    {
      q: debouncedSearch || undefined,
      amount: expectedAmount || undefined,
      includeStripe: true,
      limit: 50,
    },
    {
      query: {
        enabled: open && debouncedSearch.length >= 2,
        queryKey: getSearchReconciliationQbStagedQueryKey({
          q: debouncedSearch || undefined,
          amount: expectedAmount || undefined,
          includeStripe: true,
          limit: 50,
        }),
      },
    },
  );

  const exactRows = useMemo(
    () => (pending.data?.items ?? []).map(pendingRow),
    [pending.data?.items],
  );
  const searchRows = useMemo(
    () =>
      (broadSearch.data?.data ?? [])
        .map(searchRow)
        .filter((row): row is EvidenceRow => row !== null),
    [broadSearch.data?.data],
  );
  const rows = debouncedSearch.length >= 2 ? searchRows : exactRows;
  const selected = rows.find((row) => row.key === selectedKey) ?? null;

  useEffect(() => {
    if (!open) {
      setSelectedKey("");
      setSearch("");
    }
  }, [open]);

  useEffect(() => {
    if (selectedKey && !rows.some((row) => row.key === selectedKey)) {
      setSelectedKey("");
    }
  }, [rows, selectedKey]);

  const resolveQb = useResolveStagedPayment();
  const resolveStripe = useResolveStripeStagedCharge();
  const createQb = useCreateGiftFromStagedPayment();
  const createStripe = useCreateGiftFromStripeStagedCharge();
  const approveQb = useApproveReconciliationCard();
  const linkQb = useReconcileStagedPayment();
  const linkStripe = useLinkStripeChargeToGift();

  const busy =
    resolveQb.isPending ||
    resolveStripe.isPending ||
    createQb.isPending ||
    createStripe.isPending ||
    approveQb.isPending ||
    linkQb.isPending ||
    linkStripe.isPending;

  const refresh = async (giftId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetPendingStagedMoneyForDonorQueryKey(donorParams),
      }),
      queryClient.invalidateQueries({
        queryKey: getListGiftsAndPaymentsQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: getGetGiftOrPaymentQueryKey(giftId),
      }),
      action.kind === "create-from-opportunity"
        ? queryClient.invalidateQueries({
            queryKey: getGetOpportunityOrPledgeQueryKey(action.opportunityId),
          })
        : Promise.resolve(),
      queryClient.invalidateQueries({
        queryKey: getListOpportunitiesAndPledgesQueryKey(),
      }),
    ]);
  };

  const submit = async () => {
    if (!selected || selected.conflictReason || selected.alreadyLinkedGiftId)
      return;
    try {
      // The record-local action is also the donor-resolution decision for the
      // selected evidence. This keeps broad-search results and unresolved payer
      // rows aligned to the donor on the gift/opportunity before the unit is
      // linked or used to mint a gift. Omitting the intermediary preserves any
      // existing source-side intermediary resolution.
      const resolvedDonor = donorBody(donor);
      if (selected.source === "quickbooks") {
        await resolveQb.mutateAsync({
          id: selected.id,
          data: {
            ...resolvedDonor,
            ...(selected.paymentIntermediaryId !== undefined
              ? { paymentIntermediaryId: selected.paymentIntermediaryId }
              : {}),
          },
        });
      } else {
        await resolveStripe.mutateAsync({
          id: selected.id,
          data: {
            ...resolvedDonor,
            ...(selected.paymentIntermediaryId !== undefined
              ? { paymentIntermediaryId: selected.paymentIntermediaryId }
              : {}),
          },
        });
      }

      let giftId: string;
      if (action.kind === "link-existing-gift") {
        if (selected.source === "quickbooks") {
          const result = await linkQb.mutateAsync({
            id: selected.id,
            data: { giftId: action.giftId },
          });
          giftId = result.gift.id;
        } else {
          await linkStripe.mutateAsync({
            id: selected.id,
            data: { giftId: action.giftId },
          });
          giftId = action.giftId;
        }
      } else if (action.kind === "create-from-opportunity") {
        if (selected.source === "quickbooks") {
          const result = await approveQb.mutateAsync({
            stagedPaymentId: selected.id,
            data: {
              outcome: "create_gift_from_opportunity",
              opportunityId: action.opportunityId,
            },
          });
          giftId = result.giftId;
        } else {
          const result = await createStripe.mutateAsync({
            id: selected.id,
            data: { opportunityId: action.opportunityId },
          });
          giftId = result.gift.id;
        }
      } else if (selected.source === "quickbooks") {
        const result = await createQb.mutateAsync({
          id: selected.id,
          data: {},
        });
        giftId = result.gift.id;
      } else {
        const result = await createStripe.mutateAsync({
          id: selected.id,
          data: {},
        });
        giftId = result.gift.id;
      }

      await refresh(giftId);
      onOpenChange(false);
      toast({
        title:
          action.kind === "link-existing-gift"
            ? "Payment evidence linked"
            : action.kind === "create-from-opportunity" &&
                action.recordKind === "pledge"
              ? "Pledge payment linked"
              : "Gift recorded",
      });
      onComplete?.(giftId);
    } catch (error) {
      toast({
        title: "Could not use this payment",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  const donorName = donor.name?.trim() || "this donor";
  const loading =
    debouncedSearch.length >= 2 ? broadSearch.isLoading : pending.isLoading;
  const error =
    debouncedSearch.length >= 2 ? broadSearch.isError : pending.isError;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{titleFor(action)}</DialogTitle>
          <DialogDescription>
            {descriptionFor(action, donorName)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="payment-evidence-search">Find a payment</Label>
            <Input
              id="payment-evidence-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search payer, memo, reference, or document number…"
              disabled={busy}
              data-testid="input-payment-evidence-search"
            />
            <p className="text-xs text-muted-foreground">
              The default list shows unresolved money already matched to this
              donor. Search to find any other unresolved QuickBooks payment or
              Stripe charge without leaving this record.
            </p>
          </div>

          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading received payments…
            </p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">
              Payment evidence could not be loaded.
            </p>
          ) : rows.length === 0 ? (
            <p className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
              {debouncedSearch.length >= 2
                ? "No unresolved payments match this search."
                : "No unresolved payment is currently matched to this donor. Search by payer, memo, amount, or reference."}
            </p>
          ) : (
            <RadioGroup
              value={selectedKey}
              onValueChange={setSelectedKey}
              className="max-h-[420px] gap-2 overflow-y-auto pr-1"
              data-testid="list-payment-evidence"
            >
              {rows.map((row) => {
                const blocked =
                  !!row.conflictReason || !!row.alreadyLinkedGiftId;
                return (
                  <label
                    key={row.key}
                    htmlFor={`payment-evidence-${row.key}`}
                    className={`flex gap-3 rounded-md border p-3 text-sm ${
                      blocked
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer hover:bg-muted/50"
                    }`}
                    data-testid={`payment-evidence-${row.source}-${row.id}`}
                  >
                    <RadioGroupItem
                      id={`payment-evidence-${row.key}`}
                      value={row.key}
                      disabled={blocked || busy}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {row.payerName || "Unidentified payer"}
                        </span>
                        <Badge variant="outline">
                          {row.source === "quickbooks"
                            ? "QuickBooks"
                            : "Stripe"}
                        </Badge>
                        {!row.exactDonorMatch ? (
                          <Badge variant="secondary">Search result</Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                        <span>{formatCurrency(row.amount)}</span>
                        <span>{formatDateShort(row.dateReceived)}</span>
                      </div>
                      {row.description ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {row.description}
                        </p>
                      ) : null}
                      {row.conflictReason ? (
                        <p className="text-xs text-destructive">
                          {row.conflictReason}
                        </p>
                      ) : row.alreadyLinkedGiftId ? (
                        <p className="text-xs text-destructive">
                          Already linked to gift {row.alreadyLinkedGiftId}.
                        </p>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </RadioGroup>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              !selected ||
              !!selected.conflictReason ||
              !!selected.alreadyLinkedGiftId ||
              busy
            }
            data-testid="button-confirm-payment-evidence"
          >
            {busy
              ? "Working…"
              : action.kind === "link-existing-gift"
                ? "Link payment"
                : action.kind === "create-from-opportunity" &&
                    action.recordKind === "pledge"
                  ? "Link payment"
                  : "Record gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
