import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  type GiftOrPayment,
  type ListGiftsAndPaymentsParams,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";

/** Donor display name for a gift list row (org / household / individual). */
export function giftDonorName(g: GiftOrPayment): string {
  return (
    g.organizationName ||
    g.householdName ||
    g.individualGiverPersonName ||
    g.name ||
    "Unknown donor"
  );
}

/**
 * Reusable BROAD gift-search dialog — searches across ALL gifts by donor name /
 * record name / reference (free text), exact amount, and a date-received window.
 * Returns the picked gift row to `onPick`; the caller decides what to do with it
 * (match a staged payment to it, or link it as a "matching gift"). It does NOT
 * itself mutate anything.
 */
export function GiftSearchDialog({
  open,
  onOpenChange,
  onPick,
  excludeGiftId,
  title = "Search for a gift",
  description = "Find any existing gift by donor, amount, or date.",
  busy = false,
  footnote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (gift: GiftOrPayment) => void;
  /** Hide this gift from the results (e.g. the gift being edited itself). */
  excludeGiftId?: string | null;
  title?: string;
  description?: string;
  /** Disable picking while a mutation from a prior pick is in flight. */
  busy?: boolean;
  /** Optional helper line under the results (e.g. an action reminder). */
  footnote?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [debouncedText, setDebouncedText] = useState("");
  const [amount, setAmount] = useState("");
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");

  // Reset the form whenever the dialog is (re)opened so a prior search doesn't
  // leak into the next use.
  useEffect(() => {
    if (open) {
      setText("");
      setDebouncedText("");
      setAmount("");
      setDebouncedAmount("");
      setDateAfter("");
      setDateBefore("");
    }
  }, [open]);

  // Debounce the free-text + amount inputs so we don't refetch on every keypress.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedText(text);
      setDebouncedAmount(amount);
    }, 300);
    return () => clearTimeout(t);
  }, [text, amount]);

  const params: ListGiftsAndPaymentsParams = useMemo(
    () => ({
      ...(debouncedText.trim() ? { search: debouncedText.trim() } : {}),
      ...(debouncedAmount.trim() ? { amount: debouncedAmount.trim() } : {}),
      ...(dateAfter ? { dateAfter } : {}),
      ...(dateBefore ? { dateBefore } : {}),
      sort: "date_desc",
      limit: 25,
    }),
    [debouncedText, debouncedAmount, dateAfter, dateBefore],
  );

  const { data, isFetching } = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params), enabled: open },
  });

  const rows = useMemo(
    () => (data?.data ?? []).filter((g) => g.id !== excludeGiftId),
    [data, excludeGiftId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Donor, name or reference
            </Label>
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. William Penn, Kellie Brown…"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Amount</Label>
              <Input
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 480"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From date</Label>
              <Input
                type="date"
                value={dateAfter}
                onChange={(e) => setDateAfter(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To date</Label>
              <Input
                type="date"
                value={dateBefore}
                onChange={(e) => setDateBefore(e.target.value)}
              />
            </div>
          </div>
        </div>
        <Separator />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {isFetching && rows.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No gifts match — adjust the search above.
            </p>
          ) : (
            rows.map((g) => (
              <button
                key={g.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(g)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  busy ? "cursor-not-allowed opacity-50" : "hover:bg-muted",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {giftDonorName(g)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      g.dateReceived ? formatDateShort(g.dateReceived) : null,
                      g.type ? formatEnum(g.type) : null,
                      g.name && g.name !== giftDonorName(g) ? g.name : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Gift"}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCurrency(g.amount ?? "0")}
                </span>
              </button>
            ))
          )}
        </div>
        {footnote && (
          <p className="text-[11px] text-muted-foreground">{footnote}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
