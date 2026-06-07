import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { allSelectedLoaded } from "@/lib/merge-gate";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  useMergeGiftsAndPayments,
  useMergeGiftsIntoPledge,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type GiftOrPayment,
  type GiftOrPaymentDetail,
} from "@workspace/api-client-react";

/** Donor (type, id) for a gift, or null when the gift has no donor set. */
function donorOf(g: GiftOrPayment): { type: DonorType; id: string } | null {
  if (g.organizationId != null) return { type: "organization", id: g.organizationId };
  if (g.individualGiverPersonId != null)
    return { type: "individual", id: g.individualGiverPersonId };
  if (g.householdId != null) return { type: "household", id: g.householdId };
  return null;
}

function giftLabel(g: GiftOrPayment): string {
  const donorName =
    g.organizationName || g.individualGiverPersonName || g.householdName;
  const parts = [donorName, g.name].filter(Boolean);
  return parts.length ? parts.join(" — ") : g.id;
}

function sumAmounts(gifts: GiftOrPayment[]): number {
  return gifts.reduce((acc, g) => acc + Number(g.amount ?? 0), 0);
}

function donorsAllAgree(gifts: GiftOrPayment[]): boolean {
  const keys = new Set(
    gifts.map((g) => {
      const d = donorOf(g);
      return d ? `${d.type}:${d.id}` : "none";
    }),
  );
  return keys.size === 1;
}

/**
 * Merge several gifts into ONE gift: the survivor absorbs every other gift's
 * allocations, its amount becomes the sum of all selected gifts, and the
 * losers are permanently deleted. The user picks the survivor and the donor
 * to apply (defaults to the survivor's donor — surfaced so a donor mismatch
 * can be resolved).
 */
export function MergeGiftsDialog({
  open,
  onOpenChange,
  gifts,
  expectedCount,
  loadError = false,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gifts: GiftOrPaymentDetail[];
  /** Number of selected gifts the dialog must operate on (selection size). */
  expectedCount: number;
  /** True when any selected gift failed to load. */
  loadError?: boolean;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mut = useMergeGiftsAndPayments();
  const [primaryId, setPrimaryId] = useState<string>("");
  const [donorType, setDonorType] = useState<DonorType>("organization");
  const [donorId, setDonorId] = useState<string | null>(null);

  const giftKey = useMemo(() => gifts.map((g) => g.id).join(","), [gifts]);

  // Combined allocation line-items across all selected gifts — these are what
  // roll onto the survivor, shown so the user can verify the money trail before
  // the destructive confirm.
  const combinedAllocations = useMemo(
    () => gifts.flatMap((g) => g.allocations ?? []),
    [gifts],
  );

  // Default the survivor to the first selected gift whenever the set changes.
  useEffect(() => {
    if (gifts.length === 0) return;
    setPrimaryId((prev) =>
      gifts.some((g) => g.id === prev) ? prev : gifts[0].id,
    );
  }, [giftKey, gifts]);

  const primary = gifts.find((g) => g.id === primaryId) ?? null;

  // Reset the donor to the survivor's donor when the survivor changes.
  useEffect(() => {
    if (!primary) return;
    const d = donorOf(primary);
    if (d) {
      setDonorType(d.type);
      setDonorId(d.id);
    } else {
      setDonorId(null);
    }
  }, [primaryId, primary]);

  if (expectedCount < 2) return null;

  // Operate on EVERY selected gift — never a partially loaded subset.
  const allLoaded = allSelectedLoaded(gifts.length, expectedCount, loadError);
  const summed = sumAmounts(gifts);
  const donorMismatch = !donorsAllAgree(gifts);
  const submitting = mut.isPending;
  const canSubmit = allLoaded && !!primary && !!donorId && !submitting;

  const handleMerge = async () => {
    if (!allLoaded || !primary || !donorId) return;
    const mergeIds = gifts.map((g) => g.id).filter((id) => id !== primary.id);
    try {
      await mut.mutateAsync({
        data: {
          primaryId: primary.id,
          mergeIds,
          ...donorBodyFor(donorType, donorId),
        },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() }),
        qc.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        }),
      ]);
      toast({
        title: "Gifts merged",
        description: `${mergeIds.length.toLocaleString()} gift${
          mergeIds.length === 1 ? "" : "s"
        } merged into one (${formatCurrency(String(summed))}).`,
      });
      onOpenChange(false);
      onDone?.();
    } catch (err) {
      toast({
        title: "Merge failed",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge into one gift</DialogTitle>
          <DialogDescription>
            The selected gifts will be combined into the gift you keep. Its
            amount becomes the total ({formatCurrency(String(summed))}) and the
            other gifts&apos; allocations move onto it. The other{" "}
            {gifts.length - 1} gift{gifts.length - 1 === 1 ? "" : "s"} will be{" "}
            <span className="font-medium text-destructive">
              permanently deleted
            </span>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!allLoaded && (
            <p
              className={cn(
                "text-sm",
                loadError ? "text-destructive" : "text-muted-foreground",
              )}
              data-testid="text-merge-gift-load-status"
            >
              {loadError
                ? "Some selected gifts could not be loaded — close and try again."
                : `Loading selected gifts (${gifts.length}/${expectedCount})…`}
            </p>
          )}
          <div className="space-y-2">
            <Label>Keep this gift (survivor)</Label>
            <RadioGroup
              value={primaryId}
              onValueChange={setPrimaryId}
              className="gap-2"
            >
              {gifts.map((g) => (
                <label
                  key={g.id}
                  htmlFor={`merge-gift-primary-${g.id}`}
                  className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm hover:bg-muted/50"
                  data-testid={`radio-merge-gift-primary-${g.id}`}
                >
                  <RadioGroupItem
                    value={g.id}
                    id={`merge-gift-primary-${g.id}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {giftLabel(g)}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCurrency(g.amount ?? "0")}
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>Donor for the merged gift</Label>
            {donorMismatch && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                These gifts have different donors — pick the donor to keep.
              </p>
            )}
            <DonorFieldPicker
              type={donorType}
              id={donorId}
              onChange={(t, id) => {
                setDonorType(t);
                setDonorId(id);
              }}
              testIdBase="merge-gift-donor"
            />
          </div>

          {combinedAllocations.length > 0 && (
            <div className="space-y-2">
              <Label>
                Combined allocations ({combinedAllocations.length})
              </Label>
              <div
                className="max-h-40 divide-y overflow-auto rounded-md border text-sm"
                data-testid="list-merge-gift-allocations"
              >
                {combinedAllocations.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-3 px-2 py-1.5"
                    data-testid={`row-merge-gift-allocation-${a.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {a.displayUsage || "Unspecified allocation"}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatCurrency(a.subAmount ?? "0")}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                All of these line-items move onto the surviving gift.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="button-merge-gift-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleMerge}
            disabled={!canSubmit}
            data-testid="button-merge-gift-confirm"
          >
            {submitting ? "Merging…" : "Merge gifts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Compact picker over existing pledges for the "attach to existing" flow. */
function PledgePicker({
  value,
  onChange,
}: {
  value: { id: string; name: string | null } | null;
  onChange: (pledge: { id: string; name: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const params = {
    pledgeView: "pledges" as const,
    limit: 20,
    ...(query.trim() ? { search: query.trim() } : {}),
  };
  const { data, isLoading } = useListOpportunitiesAndPledges(params, {
    query: {
      queryKey: getListOpportunitiesAndPledgesQueryKey(params),
      staleTime: 15_000,
    },
  });
  const rows = data?.data ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between font-normal"
          data-testid="select-merge-pledge"
        >
          <span className="truncate">
            {value ? (value.name ?? value.id) : "Search pledges…"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] min-w-[320px] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search by name…"
            data-testid="select-merge-pledge-search"
          />
          <CommandList>
            {isLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : null}
            {!isLoading && rows.length === 0 ? (
              <CommandEmpty>No pledges found.</CommandEmpty>
            ) : null}
            <CommandGroup>
              {rows.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onChange({ id: p.id, name: p.name ?? null });
                    setOpen(false);
                  }}
                  data-testid={`select-merge-pledge-option-${p.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value?.id === p.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{p.name ?? p.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Attach several gifts to a pledge as its payments. Either creates a NEW
 * pledge (donor required — defaults to the gifts' shared donor) whose awarded
 * amount is the sum of the gifts, or attaches them to an EXISTING pledge. The
 * gifts are kept (not deleted); each becomes a payment on the pledge.
 */
export function MergeIntoPledgeDialog({
  open,
  onOpenChange,
  gifts,
  expectedCount,
  loadError = false,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gifts: GiftOrPaymentDetail[];
  /** Number of selected gifts the dialog must operate on (selection size). */
  expectedCount: number;
  /** True when any selected gift failed to load. */
  loadError?: boolean;
  onDone?: (pledgeId: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mut = useMergeGiftsIntoPledge();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [donorType, setDonorType] = useState<DonorType>("organization");
  const [donorId, setDonorId] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ id: string; name: string | null } | null>(
    null,
  );

  const giftKey = useMemo(() => gifts.map((g) => g.id).join(","), [gifts]);

  // Reset the form whenever the dialog is (re)opened with a new selection.
  useEffect(() => {
    if (!open || gifts.length === 0) return;
    setMode("new");
    setName("");
    setExisting(null);
    const d = donorOf(gifts[0]);
    if (d) {
      setDonorType(d.type);
      setDonorId(d.id);
    } else {
      setDonorId(null);
    }
  }, [open, giftKey, gifts]);

  if (expectedCount < 1) return null;

  // Operate on EVERY selected gift — never a partially loaded subset.
  const allLoaded = allSelectedLoaded(gifts.length, expectedCount, loadError);
  const summed = sumAmounts(gifts);
  const donorMismatch = !donorsAllAgree(gifts);
  const submitting = mut.isPending;
  const canSubmit =
    allLoaded &&
    !submitting &&
    (mode === "existing" ? !!existing : !!donorId);

  const handleSubmit = async () => {
    if (!allLoaded) return;
    const giftIds = gifts.map((g) => g.id);
    try {
      const result = await mut.mutateAsync({
        data:
          mode === "existing"
            ? { giftIds, pledgeId: existing!.id }
            : {
                giftIds,
                name: name.trim() || null,
                ...donorBodyFor(donorType, donorId),
              },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() }),
        qc.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        }),
      ]);
      toast({
        title: result.created ? "Pledge created" : "Gifts attached to pledge",
        description: `${giftIds.length.toLocaleString()} gift${
          giftIds.length === 1 ? "" : "s"
        } attached as payments.`,
      });
      onOpenChange(false);
      onDone?.(result.pledgeId);
    } catch (err) {
      toast({
        title: "Could not create pledge",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge into a pledge</DialogTitle>
          <DialogDescription>
            The selected {gifts.length} gift{gifts.length === 1 ? "" : "s"} (
            {formatCurrency(String(summed))} total) will become payments on a
            pledge. The gifts are kept — nothing is deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!allLoaded && (
            <p
              className={cn(
                "text-sm",
                loadError ? "text-destructive" : "text-muted-foreground",
              )}
              data-testid="text-merge-pledge-load-status"
            >
              {loadError
                ? "Some selected gifts could not be loaded — close and try again."
                : `Loading selected gifts (${gifts.length}/${expectedCount})…`}
            </p>
          )}
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "new" | "existing")}
            className="gap-2"
          >
            <label
              htmlFor="merge-pledge-mode-new"
              className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm hover:bg-muted/50"
            >
              <RadioGroupItem value="new" id="merge-pledge-mode-new" />
              <span>Create a new pledge</span>
            </label>
            <label
              htmlFor="merge-pledge-mode-existing"
              className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm hover:bg-muted/50"
            >
              <RadioGroupItem value="existing" id="merge-pledge-mode-existing" />
              <span>Attach to an existing pledge</span>
            </label>
          </RadioGroup>

          {mode === "new" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="merge-pledge-name">Pledge name (optional)</Label>
                <Input
                  id="merge-pledge-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. 2026 Multi-year pledge"
                  data-testid="input-merge-pledge-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Pledge donor</Label>
                {donorMismatch && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    These gifts have different donors — pick the donor for the
                    pledge.
                  </p>
                )}
                <DonorFieldPicker
                  type={donorType}
                  id={donorId}
                  onChange={(t, id) => {
                    setDonorType(t);
                    setDonorId(id);
                  }}
                  testIdBase="merge-pledge-donor"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Existing pledge</Label>
              <PledgePicker value={existing} onChange={setExisting} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="button-merge-pledge-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="button-merge-pledge-confirm"
          >
            {submitting
              ? "Working…"
              : mode === "existing"
                ? "Attach to pledge"
                : "Create pledge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
