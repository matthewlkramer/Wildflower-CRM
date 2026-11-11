import { useState } from "react";
import { Link } from "wouter";
import {
  getSearchReconciliationQbStagedQueryKey,
  useSearchReconciliationQbStaged,
} from "@workspace/api-client-react";
import type {
  AnchorRef,
  CreateGiftPrefill,
} from "@/components/reconciliation-clusters/actions";
import type { EvidencePreview } from "@/components/reconciliation-clusters/dialogs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { PaymentGiftActions } from "./rows";
import type { PaymentMatchMode } from "./gift-column-dialogs";

export function FindReceivedPayment({
  onMatch,
  onCreate,
}: {
  onMatch: (anchor: AnchorRef, mode: PaymentMatchMode) => void;
  onCreate: (
    anchor: AnchorRef,
    preview: EvidencePreview,
    prefill: CreateGiftPrefill,
  ) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounce(search.trim(), 300);
  const numeric = query.replace(/[$,]/g, "");
  const amount =
    query.startsWith("$") && /^\d+(?:\.\d{1,2})?$/.test(numeric)
      ? numeric
      : undefined;
  const enabled = query.length >= 2;
  const searchParams = {
    ...(amount ? { amount } : { q: query }),
    includeStripe: true,
    limit: 15,
  };
  const result = useSearchReconciliationQbStaged(searchParams, {
    query: {
      queryKey: getSearchReconciliationQbStagedQueryKey(searchParams),
      enabled,
    },
  });
  const payments =
    result.data?.data.filter(
      (item) => item.nodeType === "qb" || item.nodeType === "stripe",
    ) ?? [];
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <Label htmlFor="find-received-payment">
        Find a QuickBooks or Stripe payment
      </Label>
      <Input
        id="find-received-payment"
        placeholder="Payer, reference, or $amount"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {enabled && query === search.trim() && (
        <>
          {result.isFetching ? (
            <p role="status" className="text-xs">
              Searching for payments…
            </p>
          ) : result.isError ? (
            <p role="status" className="text-xs text-destructive">
              The payment search could not load. Try again or ask Finance to
              check the sync.
            </p>
          ) : payments.length === 0 ? (
            <p role="status" className="text-xs">
              No payments match this search.
            </p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {payments.map((item) => {
                const anchor: AnchorRef = {
                  kind: item.nodeType === "stripe" ? "charge" : "staged",
                  id: item.id,
                  label: item.label,
                };
                const preview = {
                  amount: formatCurrency(item.amount, { cents: true }),
                  date: formatDateShort(item.date),
                  method:
                    item.nodeType === "stripe"
                      ? "Stripe charge"
                      : "QuickBooks payment",
                  source: item.label,
                  memo: item.sublabel,
                };
                return (
                  <li
                    key={`${item.nodeType}:${item.id}`}
                    className="rounded-md border bg-background px-3 py-2"
                  >
                    <p className="font-medium text-foreground">{item.label}</p>
                    <p className="text-xs">
                      {preview.method} · {preview.date} · {preview.amount}
                    </p>
                    {item.sublabel && (
                      <p className="text-xs">{item.sublabel}</p>
                    )}
                    {item.alreadyLinkedGiftId ? (
                      <Link
                        href={`/gifts/${item.alreadyLinkedGiftId}`}
                        className="text-xs text-primary underline"
                      >
                        Open linked gift
                      </Link>
                    ) : item.conflictReason ? (
                      <p className="text-xs text-destructive">
                        {item.conflictReason}
                      </p>
                    ) : (
                      <PaymentGiftActions
                        actions={{
                          openLinkEvidence: onMatch,
                          openCreateGift: onCreate,
                        }}
                        anchor={anchor}
                        preview={preview}
                        prefill={{
                          name: item.label,
                          dateReceived: item.date ?? null,
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
