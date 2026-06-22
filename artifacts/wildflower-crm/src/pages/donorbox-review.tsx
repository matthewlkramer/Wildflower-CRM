import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDonorboxReview,
  useLinkDonorboxDonationToGift,
  useCreateGiftFromDonorboxDonation,
  useExcludeDonorboxDonation,
  useReIncludeDonorboxDonation,
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  DonorboxReviewQueue,
  DonorboxExclusionReason,
  type DonorboxReviewRow,
  type DonorboxDuplicateCandidate,
  type DonorboxCreateGiftBody,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EntityCombobox,
  useOrganizationSearch,
  useOrganizationName,
  usePersonSearch,
  usePersonName,
  useHouseholdSearch,
  useHouseholdName,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────
 * Donorbox new-money review.
 *
 * Non-Stripe (PayPal/ACH) Donorbox donations land here as human-reviewed
 * candidates. Stripe-type donations NEVER appear — they enrich existing
 * Stripe records instead (see the Donorbox enrichment panel on gifts /
 * reconciliation cards). For each candidate a reviewer can:
 *   • Link to an existing gift (the donation adopts that gift's donor; no
 *     new ledger row is created).
 *   • Create a new gift (Donor XOR enforced; a dedupe guard blocks a
 *     possible double-book unless the reviewer forces it).
 *   • Exclude it (with a reason).
 * Nothing is ever auto-minted and nothing is written to staged_payments.
 * ──────────────────────────────────────────────────────────────────────── */

const QUEUES: { value: DonorboxReviewQueue; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "done", label: "Done" },
  { value: "excluded", label: "Excluded" },
];

const EXCLUSION_REASONS: { value: DonorboxExclusionReason; label: string }[] = [
  { value: "already_booked", label: "Already booked elsewhere" },
  { value: "duplicate", label: "Duplicate donation" },
  { value: "not_a_gift", label: "Not a gift" },
  { value: "other", label: "Other" },
];

type DonorKind = "organization" | "individual" | "household";

function initialDonorKind(row: DonorboxReviewRow): DonorKind {
  if (row.organizationId) return "organization";
  if (row.householdId) return "household";
  // Donorbox donors are people by default.
  return "individual";
}

function initialDonorId(row: DonorboxReviewRow, kind: DonorKind): string | null {
  if (kind === "organization") return row.organizationId ?? null;
  if (kind === "household") return row.householdId ?? null;
  return row.individualGiverPersonId ?? null;
}

/**
 * Read the 409 possible-duplicate candidates off a thrown ApiError without
 * importing the class (the package barrel doesn't re-export it). The error
 * carries `status` + `data` as own properties.
 */
function getDuplicateCandidates(
  err: unknown,
): DonorboxDuplicateCandidate[] | null {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    "data" in err &&
    (err as { status: unknown }).status === 409
  ) {
    const data = (err as { data: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const d = data as {
        error?: string;
        candidates?: DonorboxDuplicateCandidate[];
      };
      if (d.error === "possible_duplicate") return d.candidates ?? [];
    }
  }
  return null;
}

function errMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : "It may already have changed state — refresh and try again.";
}

function donorLabel(row: DonorboxReviewRow): string {
  if (row.anonymous) return "Anonymous";
  return row.donorName?.trim() || row.donorEmail?.trim() || "Unknown donor";
}

function suggestedDonorName(row: DonorboxReviewRow): string | null {
  return (
    row.organizationName ||
    row.individualGiverPersonName ||
    row.householdName ||
    null
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

// ── Donor picker (kind selector + combobox) ───────────────────────────────

function DonorPicker({
  kind,
  value,
  onChange,
}: {
  kind: DonorKind;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  // All useSearch / useResolve impls call exactly two hooks, so swapping the
  // function reference by kind keeps EntityCombobox's hook order stable.
  const useSearch =
    kind === "organization"
      ? useOrganizationSearch
      : kind === "individual"
        ? usePersonSearch
        : useHouseholdSearch;
  const useResolve =
    kind === "organization"
      ? useOrganizationName
      : kind === "individual"
        ? usePersonName
        : useHouseholdName;
  return (
    <EntityCombobox
      useSearch={useSearch}
      useResolve={useResolve}
      value={value}
      onChange={onChange}
      allowNull={false}
      placeholder={
        kind === "individual"
          ? "Search people…"
          : kind === "organization"
            ? "Search organizations…"
            : "Search households…"
      }
      testId="donorbox-donor-picker"
    />
  );
}

// ── Link-to-existing-gift dialog ──────────────────────────────────────────

function LinkGiftDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: {
  row: DonorboxReviewRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedGiftId, setSelectedGiftId] = useState<string | null>(null);

  // Seed the search with the donor name when the dialog opens.
  useEffect(() => {
    if (open) {
      const seed = row.donorName?.trim() ?? "";
      setSearch(seed);
      setDebounced(seed);
      setSelectedGiftId(null);
    }
  }, [open, row.donorName]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p: { limit: number; page: number; search?: string } = {
      limit: 20,
      page: 1,
    };
    if (debounced.trim()) p.search = debounced.trim();
    return p;
  }, [debounced]);

  const giftsQ = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });
  const gifts = giftsQ.data?.data ?? [];

  const linkGift = useLinkDonorboxDonationToGift({
    mutation: {
      onSuccess: () => {
        toast({ title: "Donation linked to the existing gift." });
        onDone();
        onOpenChange(false);
      },
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "Couldn't link that gift",
          description: errMessage(err),
        }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link to an existing gift</DialogTitle>
          <DialogDescription>
            The donation adopts the selected gift's donor. No new gift is
            created — use this when the money is already booked in the CRM.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search gifts — name, donor, or intermediary…"
            data-testid="donorbox-link-gift-search"
          />
          <div className="max-h-[40vh] overflow-y-auto pr-1">
            {giftsQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading gifts…</p>
            ) : giftsQ.isError ? (
              <p className="text-sm text-red-700">Failed to load gifts.</p>
            ) : gifts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No matching gifts. Adjust the search.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="donorbox-link-gift-list">
                {gifts.map((g) => {
                  const selected = selectedGiftId === g.id;
                  return (
                    <li key={g.id}>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedGiftId(selected ? null : g.id)
                        }
                        className={`w-full rounded-md border p-3 text-left transition-colors ${
                          selected
                            ? "border-primary bg-primary/5"
                            : "hover:bg-muted/50"
                        }`}
                        data-testid={`donorbox-link-gift-option-${g.id}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-sm font-medium">
                            {g.name?.trim() || g.id}
                          </span>
                          <span className="shrink-0 text-sm tabular-nums">
                            {formatCurrency(g.amount)}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {formatDate(g.dateReceived)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selectedGiftId || linkGift.isPending}
            onClick={() => {
              if (!selectedGiftId) return;
              linkGift.mutate({
                id: row.id,
                data: { giftId: selectedGiftId },
              });
            }}
            data-testid="donorbox-link-gift-confirm"
          >
            {linkGift.isPending ? "Linking…" : "Link gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create-a-new-gift dialog (with dedupe guard) ──────────────────────────

function CreateGiftDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: {
  row: DonorboxReviewRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<DonorKind>(initialDonorKind(row));
  const [donorId, setDonorId] = useState<string | null>(
    initialDonorId(row, initialDonorKind(row)),
  );
  const [candidates, setCandidates] = useState<
    DonorboxDuplicateCandidate[] | null
  >(null);

  useEffect(() => {
    if (open) {
      const k = initialDonorKind(row);
      setKind(k);
      setDonorId(initialDonorId(row, k));
      setCandidates(null);
    }
  }, [open, row]);

  const createGift = useCreateGiftFromDonorboxDonation();

  async function submit(force: boolean) {
    if (!donorId) return;
    const data: DonorboxCreateGiftBody = {
      organizationId: kind === "organization" ? donorId : null,
      individualGiverPersonId: kind === "individual" ? donorId : null,
      householdId: kind === "household" ? donorId : null,
      ...(row.matchedPaymentIntermediaryId
        ? { paymentIntermediaryId: row.matchedPaymentIntermediaryId }
        : {}),
      force,
    };
    try {
      await createGift.mutateAsync({ id: row.id, data });
      toast({ title: "Gift created from the Donorbox donation." });
      onDone();
      onOpenChange(false);
    } catch (err) {
      const dups = getDuplicateCandidates(err);
      if (dups) {
        setCandidates(dups);
        return;
      }
      toast({
        variant: "destructive",
        title: "Couldn't create the gift",
        description: errMessage(err),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a new gift</DialogTitle>
          <DialogDescription>
            Mint a gift for {formatCurrency(row.amount)} from{" "}
            {donorLabel(row)}. Pick the CRM donor this money belongs to.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Donor type</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                const next = v as DonorKind;
                setKind(next);
                setDonorId(initialDonorId(row, next));
                setCandidates(null);
              }}
            >
              <SelectTrigger data-testid="donorbox-create-gift-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="individual">Individual</SelectItem>
                <SelectItem value="organization">Organization</SelectItem>
                <SelectItem value="household">Household</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Donor</Label>
            <DonorPicker
              kind={kind}
              value={donorId}
              onChange={(id) => {
                setDonorId(id);
                setCandidates(null);
              }}
            />
          </div>

          {candidates ? (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 p-3"
              data-testid="donorbox-create-gift-duplicates"
            >
              <p className="text-sm font-medium text-amber-900">
                Possible duplicate{candidates.length === 1 ? "" : "s"} found
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                This money may already be booked. Review the matches, then link
                to one instead, or create anyway if it's genuinely new.
              </p>
              <ul className="mt-2 space-y-1.5">
                {candidates.map((c) => (
                  <li key={`${c.kind}-${c.id}`} className="text-xs">
                    <span className="font-medium capitalize">
                      {c.kind.replace("_", " ")}
                    </span>
                    {": "}
                    {c.name?.trim() || c.id}
                    {c.amount ? ` · ${formatCurrency(c.amount)}` : ""}
                    {c.dateReceived ? ` · ${formatDate(c.dateReceived)}` : ""}
                    {c.reason ? (
                      <span className="text-amber-700"> ({c.reason})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {candidates ? (
            <Button
              variant="destructive"
              disabled={!donorId || createGift.isPending}
              onClick={() => void submit(true)}
              data-testid="donorbox-create-gift-force"
            >
              {createGift.isPending ? "Creating…" : "Create anyway"}
            </Button>
          ) : (
            <Button
              disabled={!donorId || createGift.isPending}
              onClick={() => void submit(false)}
              data-testid="donorbox-create-gift-confirm"
            >
              {createGift.isPending ? "Creating…" : "Create gift"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Exclude dialog ────────────────────────────────────────────────────────

function ExcludeDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: {
  row: DonorboxReviewRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState<DonorboxExclusionReason>("already_booked");

  useEffect(() => {
    if (open) setReason("already_booked");
  }, [open]);

  const exclude = useExcludeDonorboxDonation({
    mutation: {
      onSuccess: () => {
        toast({ title: "Donation excluded from the worklist." });
        onDone();
        onOpenChange(false);
      },
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "Couldn't exclude that donation",
          description: errMessage(err),
        }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Exclude this donation</DialogTitle>
          <DialogDescription>
            File it out of the review worklist. You can re-include it later from
            the Excluded tab.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Reason</Label>
          <Select
            value={reason}
            onValueChange={(v) => setReason(v as DonorboxExclusionReason)}
          >
            <SelectTrigger data-testid="donorbox-exclude-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXCLUSION_REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={exclude.isPending}
            onClick={() =>
              exclude.mutate({ id: row.id, data: { exclusionReason: reason } })
            }
            data-testid="donorbox-exclude-confirm"
          >
            {exclude.isPending ? "Excluding…" : "Exclude"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Candidate card ────────────────────────────────────────────────────────

function CandidateCard({
  row,
  onRefresh,
  reIncluding,
  onReInclude,
}: {
  row: DonorboxReviewRow;
  onRefresh: () => void;
  reIncluding: boolean;
  onReInclude: (id: string) => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);

  const suggested = suggestedDonorName(row);
  const linkedGiftId = row.linkedGiftId;

  return (
    <Card data-testid={`donorbox-candidate-${row.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">
              {donorLabel(row)}
            </CardTitle>
            {row.donorEmail && !row.anonymous ? (
              <CardDescription className="truncate">
                {row.donorEmail}
              </CardDescription>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {row.donationType ? (
              <Badge variant="outline" className="capitalize">
                {row.donationType}
              </Badge>
            ) : null}
            {row.recurring ? <Badge variant="secondary">Recurring</Badge> : null}
            {row.refunded ? (
              <Badge variant="destructive">Refunded</Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact label="Amount" value={formatCurrency(row.amount)} />
          <Fact label="Date" value={formatDate(row.dateReceived)} />
          {row.campaignName ? (
            <Fact label="Campaign" value={row.campaignName} />
          ) : null}
          {row.designation ? (
            <Fact label="Designation" value={row.designation} />
          ) : null}
        </div>

        {row.comment ? (
          <p className="rounded bg-muted/50 p-2 text-sm text-muted-foreground">
            {row.comment}
          </p>
        ) : null}

        {row.queue === "needs_review" ? (
          <>
            {suggested ? (
              <p className="text-xs text-muted-foreground">
                Suggested donor:{" "}
                <span className="font-medium text-foreground">{suggested}</span>
                {row.matchMethod ? ` (${row.matchMethod})` : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLinkOpen(true)}
                data-testid={`donorbox-action-link-${row.id}`}
              >
                Link to gift
              </Button>
              <Button
                size="sm"
                onClick={() => setCreateOpen(true)}
                data-testid={`donorbox-action-create-${row.id}`}
              >
                Create gift
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setExcludeOpen(true)}
                data-testid={`donorbox-action-exclude-${row.id}`}
              >
                Exclude
              </Button>
            </div>
          </>
        ) : null}

        {row.queue === "done" ? (
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="default">
              {row.createdGiftId ? "Gift created" : "Linked to gift"}
            </Badge>
            {linkedGiftId ? (
              <Link
                href={`/gifts/${linkedGiftId}`}
                className="text-primary underline-offset-4 hover:underline"
                data-testid={`donorbox-linked-gift-${row.id}`}
              >
                {row.linkedGiftName?.trim() || "View gift"}
                {row.linkedGiftAmount
                  ? ` · ${formatCurrency(row.linkedGiftAmount)}`
                  : ""}
              </Link>
            ) : null}
          </div>
        ) : null}

        {row.queue === "excluded" ? (
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary">
              Excluded
              {row.exclusionReason
                ? ` · ${row.exclusionReason.replace("_", " ")}`
                : ""}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={reIncluding}
              onClick={() => onReInclude(row.id)}
              data-testid={`donorbox-action-reinclude-${row.id}`}
            >
              {reIncluding ? "Re-including…" : "Re-include"}
            </Button>
          </div>
        ) : null}
      </CardContent>

      {linkOpen ? (
        <LinkGiftDialog
          row={row}
          open={linkOpen}
          onOpenChange={setLinkOpen}
          onDone={onRefresh}
        />
      ) : null}
      {createOpen ? (
        <CreateGiftDialog
          row={row}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onDone={onRefresh}
        />
      ) : null}
      {excludeOpen ? (
        <ExcludeDialog
          row={row}
          open={excludeOpen}
          onOpenChange={setExcludeOpen}
          onDone={onRefresh}
        />
      ) : null}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function DonorboxReview() {
  const [queue, setQueue] = useState<DonorboxReviewQueue>("needs_review");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reIncludingIds, setReIncludingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p: { queue: DonorboxReviewQueue; limit: number; search?: string } = {
      queue,
      limit: 100,
    };
    if (debounced.trim()) p.search = debounced.trim();
    return p;
  }, [queue, debounced]);

  const { data, isLoading, isError } = useListDonorboxReview(params);
  const rows = data?.data ?? [];

  function refresh() {
    void queryClient.invalidateQueries({
      queryKey: ["/api/donorbox/review"],
    });
    // Creating / linking a gift mutates the gifts list + aggregates.
    void queryClient.invalidateQueries({
      queryKey: ["/api/gifts-and-payments"],
    });
  }

  const reInclude = useReIncludeDonorboxDonation({
    mutation: {
      onSuccess: () => {
        toast({ title: "Donation moved back to needs-review." });
        refresh();
      },
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "Couldn't re-include that donation",
          description: errMessage(err),
        }),
    },
  });

  function onReInclude(id: string) {
    setReIncludingIds((prev) => new Set(prev).add(id));
    reInclude.mutate(
      { id },
      {
        onSettled: () =>
          setReIncludingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Donorbox Review</h1>
        <p className="text-sm text-muted-foreground">
          Non-Stripe (PayPal/ACH) Donorbox donations awaiting a decision. Link
          each to an existing gift, create a new gift, or exclude it. Stripe-type
          donations don't appear here — they enrich existing records instead.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {QUEUES.map((q) => (
            <Button
              key={q.value}
              size="sm"
              variant={queue === q.value ? "default" : "outline"}
              onClick={() => setQueue(q.value)}
              data-testid={`donorbox-queue-${q.value}`}
            >
              {q.label}
            </Button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search donor name, email, campaign…"
          className="h-9 max-w-xs"
          data-testid="donorbox-review-search"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading donations…</p>
      ) : isError ? (
        <p className="text-sm text-red-700">Failed to load donations.</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {queue === "needs_review"
              ? "Nothing to review — all Donorbox new-money donations are handled."
              : "No donations in this list."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="donorbox-review-list">
          {rows.map((row) => (
            <CandidateCard
              key={row.id}
              row={row}
              onRefresh={refresh}
              reIncluding={reIncludingIds.has(row.id)}
              onReInclude={onReInclude}
            />
          ))}
        </div>
      )}
    </div>
  );
}
