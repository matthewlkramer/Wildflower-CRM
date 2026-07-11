import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient, useQueries } from "@tanstack/react-query";
import {
  useListPotentialDuplicates,
  getListPotentialDuplicatesQueryKey,
  useDismissPotentialDuplicate,
  useMergeOrganizations,
  useMergePeople,
  getListOrganizationsQueryKey,
  getListPeopleQueryKey,
  getGetOrganizationQueryOptions,
  getGetOrganizationQueryKey,
  getGetPersonQueryOptions,
  getGetPersonQueryKey,
  type DuplicatePair,
  type DuplicateMergeSuggestion,
  type DuplicatePairSide,
  type Organization,
  type Person,
} from "@workspace/api-client-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useToast } from "@/hooks/use-toast";
import {
  MergeDialog,
  type MergeField,
  type MergeRecord,
} from "@/components/merge-dialog";
import { useUserNameMap } from "@/components/user-picker";
import { useRegionNameMap } from "@/components/region-picker";
import {
  formatCapacity,
  formatDateShort,
  formatEnum,
  formatEnthusiasm,
} from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useRowSelection } from "@/hooks/use-row-selection";
import { X } from "lucide-react";

type DupType = "organization" | "person";

const DUP_KEY_PREFIX = "/api/potential-duplicates";

const SIGNAL_LABEL: Record<string, string> = {
  name: "Similar name",
  phone: "Shared phone",
};

function detailHref(type: DupType, id: string): string {
  return type === "organization" ? `/organizations/${id}` : `/individuals/${id}`;
}

function SideCard({
  type,
  side,
}: {
  type: DupType;
  side: DuplicatePairSide;
}) {
  return (
    <div className="flex-1 rounded-md border bg-card p-3">
      <Link
        href={detailHref(type, side.id)}
        className="font-medium text-primary underline-offset-2 hover:underline break-words"
        data-testid={`link-duplicate-${side.id}`}
      >
        {side.name}
      </Link>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <dt>Owner</dt>
          <dd className="text-right text-foreground">{side.ownerName ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Email</dt>
          <dd className="text-right text-foreground break-all">
            {side.primaryEmail ?? "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Phone</dt>
          <dd className="text-right text-foreground">
            {side.primaryPhone ?? "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Gifts</dt>
          <dd className="text-right text-foreground">
            {side.giftCount.toLocaleString()}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd className="text-right text-foreground">
            {formatDateShort(side.createdAt ?? null)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Loads the two full records for a pair and renders the shared MergeDialog.
 * Kept as a dedicated component so the detail-fetch hooks only mount while a
 * merge is in flight (and so org/person stay on separate hook paths).
 */
function OrgMergeLauncher({
  ids,
  onClose,
}: {
  ids: [string, string];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mergeMut = useMergeOrganizations();
  const userNames = useUserNameMap();
  const queries = useQueries({
    queries: ids.map((id) =>
      getGetOrganizationQueryOptions(id, {
        query: { staleTime: 30_000, queryKey: getGetOrganizationQueryKey(id) },
      }),
    ),
  });
  const loadFailed = queries.some((q) => q.isError);
  useEffect(() => {
    if (loadFailed) {
      toast({
        title: "Couldn't load records",
        description: "Failed to load the records to merge. Please try again.",
        variant: "destructive",
      });
      onClose();
    }
  }, [loadFailed, toast, onClose]);
  const records = useMemo<MergeRecord[]>(
    () =>
      queries
        .map((q) => q.data)
        .filter((d): d is Organization => !!d)
        .map((d) => d as unknown as MergeRecord),
    [queries],
  );
  const fields = useMemo<MergeField[]>(
    () => [
      { key: "name", label: "Name" },
      { key: "entityType", label: "Type", display: (v) => formatEnum(v as string | null) },
      { key: "capacityRating", label: "Capacity", display: (v) => formatCapacity(v as string | null) },
      { key: "activeStatus", label: "Active status", display: (v) => formatEnum(v as string | null) },
      { key: "connectionStatus", label: "Connection", display: (v) => formatEnum(v as string | null) },
      { key: "enthusiasm", label: "Enthusiasm", display: (v) => formatEnthusiasm(v as string | null) },
      { key: "priority", label: "Priority", display: (v) => formatEnum(v as string | null) },
      {
        key: "ownerUserId",
        label: "Owner",
        display: (v) => (v ? (userNames.get(v as string) ?? String(v)) : "—"),
      },
      { key: "lastContacted", label: "Last contacted", display: (v) => formatDateShort(v as string | null) },
      { key: "website", label: "Website" },
      { key: "orgEmail", label: "Org email" },
      { key: "linkedin", label: "LinkedIn" },
    ],
    [userNames],
  );

  if (queries.some((q) => q.isLoading) || records.length < 2) return null;

  return (
    <MergeDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      entityNoun="organization"
      records={records}
      fields={fields}
      recordLabel={(r) =>
        ((r as unknown as Organization).name as string | null) || r.id
      }
      invalidateKeys={[getListOrganizationsQueryKey(), [DUP_KEY_PREFIX]]}
      onSubmit={async ({ primaryId, mergeIds, overrides }) =>
        mergeMut.mutateAsync({ data: { primaryId, mergeIds, overrides } })
      }
      onDone={onClose}
    />
  );
}

function PersonMergeLauncher({
  ids,
  onClose,
}: {
  ids: [string, string];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mergeMut = useMergePeople();
  const userNames = useUserNameMap();
  const regionNames = useRegionNameMap();
  const queries = useQueries({
    queries: ids.map((id) =>
      getGetPersonQueryOptions(id, {
        query: { staleTime: 30_000, queryKey: getGetPersonQueryKey(id) },
      }),
    ),
  });
  const loadFailed = queries.some((q) => q.isError);
  useEffect(() => {
    if (loadFailed) {
      toast({
        title: "Couldn't load records",
        description: "Failed to load the records to merge. Please try again.",
        variant: "destructive",
      });
      onClose();
    }
  }, [loadFailed, toast, onClose]);
  const records = useMemo<MergeRecord[]>(
    () =>
      queries
        .map((q) => q.data)
        .filter((d): d is Person => !!d)
        .map((d) => d as unknown as MergeRecord),
    [queries],
  );
  const fields = useMemo<MergeField[]>(
    () => [
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "fullName", label: "Full name" },
      { key: "nickname", label: "Nickname" },
      { key: "pronouns", label: "Pronouns" },
      { key: "capacityRating", label: "Capacity", display: (v) => formatCapacity(v as string | null) },
      { key: "connectionStatus", label: "Connection", display: (v) => formatEnum(v as string | null) },
      { key: "enthusiasm", label: "Enthusiasm", display: (v) => formatEnthusiasm(v as string | null) },
      { key: "priority", label: "Priority", display: (v) => formatEnum(v as string | null) },
      { key: "deceased", label: "Deceased", display: (v) => (v == null ? "—" : v ? "Yes" : "No") },
      {
        key: "currentHomeRegionId",
        label: "Home region",
        display: (v) => (v ? (regionNames.get(v as string) ?? String(v)) : "—"),
      },
      {
        key: "ownerUserId",
        label: "Owner",
        display: (v) => (v ? (userNames.get(v as string) ?? String(v)) : "—"),
      },
      { key: "lastContacted", label: "Last contacted", display: (v) => formatDateShort(v as string | null) },
      { key: "website", label: "Website" },
      { key: "linkedin", label: "LinkedIn" },
    ],
    [regionNames, userNames],
  );

  if (queries.some((q) => q.isLoading) || records.length < 2) return null;

  return (
    <MergeDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      entityNoun="person"
      records={records}
      fields={fields}
      recordLabel={(r) => {
        const p = r as unknown as Person;
        return (
          (p.fullName as string | null) ||
          [p.firstName, p.lastName].filter(Boolean).join(" ") ||
          p.id
        );
      }}
      invalidateKeys={[getListPeopleQueryKey(), [DUP_KEY_PREFIX]]}
      onSubmit={async ({ primaryId, mergeIds, overrides }) =>
        mergeMut.mutateAsync({ data: { primaryId, mergeIds, overrides } })
      }
      onDone={onClose}
    />
  );
}

type PendingAction =
  | { kind: "merge-all" }
  | { kind: "merge-selected" }
  | { kind: "dismiss-selected" };

const pairKey = (pair: DuplicatePair) => `${pair.a.id}__${pair.b.id}`;

export default function PotentialDuplicatesPage() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [type, setType] = useState<DupType>("organization");
  const [mergePair, setMergePair] = useState<[string, string] | null>(null);

  const params = { type, limit: 100 } as const;
  const { data, isLoading, isError } = useListPotentialDuplicates(params, {
    query: {
      enabled: isAdmin,
      queryKey: getListPotentialDuplicatesQueryKey(params),
    },
  });

  const dismissMut = useDismissPotentialDuplicate();
  const mergeOrgMut = useMergeOrganizations();
  const mergePersonMut = useMergePeople();

  const selection = useRowSelection();
  const [quickBusyKey, setQuickBusyKey] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const invalidateDuplicates = () =>
    queryClient.invalidateQueries({ queryKey: [DUP_KEY_PREFIX] });

  const pairs = useMemo<DuplicatePair[]>(() => data?.pairs ?? [], [data]);

  // Derived selection state. Because this page has no pagination, the
  // selection should only ever reference pairs in the current result set;
  // prune any keys that no longer resolve (e.g. a pair vanished after a
  // merge removed one of its records) so the load-gate below can't get
  // stuck. Don't prune mid-batch — keys are removed explicitly after each
  // operation so failed rows stay selected.
  const visibleKeys = useMemo(() => pairs.map(pairKey), [pairs]);
  const visibleKeySet = useMemo(() => new Set(visibleKeys), [visibleKeys]);

  // Effects below deliberately depend on the selection's STABLE pieces
  // (the memoized callbacks + the selectedIds array) rather than the whole
  // `selection` object. Depending on the whole object while also calling
  // its setters re-fires the effect on every selection change; combined
  // with a setter that always produced a new Set this looped forever
  // ("Maximum update depth exceeded" → blank page). The hook's setters now
  // also bail out on no-op updates, so either layer alone breaks the loop.
  const {
    selectedIds: selectionIds,
    removeMany: selectionRemoveMany,
    clear: selectionClear,
  } = selection;

  useEffect(() => {
    if (batchBusy) return;
    const stale = selectionIds.filter((k) => !visibleKeySet.has(k));
    if (stale.length) selectionRemoveMany(stale);
  }, [visibleKeySet, batchBusy, selectionIds, selectionRemoveMany]);

  // Clear the selection whenever the entity type changes — a selection over
  // a different result set is never what the user wants.
  useEffect(() => {
    selectionClear();
  }, [type, selectionClear]);

  const safePairs = useMemo(
    () => pairs.filter((p) => p.safeMerge && p.mergeSuggestion),
    [pairs],
  );
  const selectedPairs = useMemo(
    () => pairs.filter((p) => selection.isSelected(pairKey(p))),
    [pairs, selection],
  );
  const selectedSafePairs = useMemo(
    () => selectedPairs.filter((p) => p.safeMerge && p.mergeSuggestion),
    [selectedPairs],
  );

  // Load-gate: don't act on a partial selection. Every selected key must
  // resolve to a loaded pair before bulk submit is allowed.
  const selectionLoaded = selectedPairs.length === selection.count;
  const allVisibleSelected =
    pairs.length > 0 && pairs.every((p) => selection.isSelected(pairKey(p)));

  const runMerge = async (s: DuplicateMergeSuggestion) => {
    const body = {
      primaryId: s.primaryId,
      mergeIds: s.mergeIds,
      overrides: s.overrides,
    };
    if (type === "organization") await mergeOrgMut.mutateAsync({ data: body });
    else await mergePersonMut.mutateAsync({ data: body });
  };

  const handleQuickMerge = async (pair: DuplicatePair) => {
    if (!pair.mergeSuggestion) return;
    const key = pairKey(pair);
    setQuickBusyKey(key);
    try {
      await runMerge(pair.mergeSuggestion);
      selection.removeMany([key]);
      void invalidateDuplicates();
      toast({
        title: "Merged",
        description: "The duplicate was merged into one record.",
      });
    } catch (err) {
      toast({
        title: "Couldn't merge",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setQuickBusyKey(null);
    }
  };

  const handleBatchMerge = async (targets: DuplicatePair[]) => {
    setBatchBusy(true);
    let ok = 0;
    let fail = 0;
    const done: string[] = [];
    for (const pair of targets) {
      if (!pair.mergeSuggestion) continue;
      try {
        await runMerge(pair.mergeSuggestion);
        ok += 1;
        done.push(pairKey(pair));
      } catch {
        fail += 1;
      }
    }
    selection.removeMany(done);
    void invalidateDuplicates();
    setBatchBusy(false);
    setPending(null);
    toast({
      title: fail ? "Merged with errors" : "Merged",
      description: fail
        ? `${ok} merged, ${fail} failed.`
        : `${ok} ${ok === 1 ? "pair" : "pairs"} merged.`,
      variant: fail ? "destructive" : undefined,
    });
  };

  const handleBatchDismiss = async (targets: DuplicatePair[]) => {
    setBatchBusy(true);
    let ok = 0;
    let fail = 0;
    const done: string[] = [];
    for (const pair of targets) {
      try {
        await dismissMut.mutateAsync({
          data: { type, idA: pair.a.id, idB: pair.b.id },
        });
        ok += 1;
        done.push(pairKey(pair));
      } catch {
        fail += 1;
      }
    }
    selection.removeMany(done);
    void invalidateDuplicates();
    setBatchBusy(false);
    setPending(null);
    toast({
      title: fail ? "Dismissed with errors" : "Dismissed",
      description: fail
        ? `${ok} dismissed, ${fail} failed.`
        : `${ok} ${ok === 1 ? "pair" : "pairs"} dismissed.`,
      variant: fail ? "destructive" : undefined,
    });
  };

  const runPending = async () => {
    if (!pending) return;
    if (pending.kind === "dismiss-selected") await handleBatchDismiss(selectedPairs);
    else if (pending.kind === "merge-all") await handleBatchMerge(safePairs);
    else await handleBatchMerge(selectedSafePairs);
  };

  const noun = type === "organization" ? "organization" : "person";
  const nounPlural = type === "organization" ? "organizations" : "people";

  const handleDismiss = (pair: DuplicatePair) => {
    dismissMut.mutate(
      { data: { type, idA: pair.a.id, idB: pair.b.id } },
      {
        onSuccess: () => {
          selection.removeMany([pairKey(pair)]);
          void invalidateDuplicates();
          toast({
            title: "Dismissed",
            description: "This pair won't be flagged as a duplicate again.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't dismiss",
            description: err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  if (!isAdmin) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Potential Duplicates
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          The duplicates queue is only available to administrators.
        </p>
      </div>
    );
  }

  const anyBusy = batchBusy || quickBusyKey !== null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Potential Duplicates
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Likely-duplicate records detected by similar names and shared phone
          numbers. Review each pair, then merge the duplicates into one record or
          dismiss the pair if they're genuinely different. Pairs marked{" "}
          <span className="font-medium text-foreground">Safe to merge</span> only
          differ where one record is blank, so they can be merged in one click.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={type} onValueChange={(v) => setType(v as DupType)}>
          <SelectTrigger className="w-48" data-testid="select-duplicate-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="organization">Organizations</SelectItem>
            <SelectItem value="person">People</SelectItem>
          </SelectContent>
        </Select>
        {safePairs.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={anyBusy}
            onClick={() => setPending({ kind: "merge-all" })}
            data-testid="button-merge-all-safe"
          >
            Merge all safe pairs ({safePairs.length})
          </Button>
        ) : null}
        {!isLoading && !isError ? (
          <span className="ml-auto text-sm text-muted-foreground">
            {pairs.length.toLocaleString()}{" "}
            {pairs.length === 1 ? "pair" : "pairs"}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Scanning for duplicates…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to scan for duplicates.
        </p>
      ) : pairs.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No potential duplicates found.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-1">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={() => selection.toggleVisible(visibleKeys)}
              aria-label="Select all pairs"
              data-testid="checkbox-select-all-duplicates"
            />
            <span className="text-sm text-muted-foreground">Select all</span>
          </div>

          {pairs.map((pair) => {
            const key = pairKey(pair);
            return (
              <div
                key={key}
                className="rounded-lg border p-4 space-y-3"
                data-testid={`duplicate-pair-${key}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    checked={selection.isSelected(key)}
                    onCheckedChange={() => selection.toggle(key)}
                    aria-label="Select pair"
                    data-testid={`checkbox-duplicate-${key}`}
                  />
                  {pair.safeMerge ? (
                    <Badge
                      variant="default"
                      data-testid={`badge-safe-merge-${key}`}
                    >
                      Safe to merge
                    </Badge>
                  ) : null}
                  {pair.signals.map((s) => (
                    <Badge key={s} variant="secondary">
                      {SIGNAL_LABEL[s] ?? s}
                    </Badge>
                  ))}
                  <span className="ml-auto text-xs text-muted-foreground">
                    score {pair.score.toFixed(2)}
                  </span>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  <SideCard type={type} side={pair.a} />
                  <SideCard type={type} side={pair.b} />
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={dismissMut.isPending || anyBusy}
                    onClick={() => handleDismiss(pair)}
                    data-testid={`button-dismiss-${key}`}
                  >
                    Not a duplicate
                  </Button>
                  {pair.safeMerge && pair.mergeSuggestion ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={anyBusy}
                      onClick={() => handleQuickMerge(pair)}
                      data-testid={`button-quick-merge-${key}`}
                    >
                      {quickBusyKey === key ? "Merging…" : "Quick merge"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={anyBusy}
                    onClick={() => setMergePair([pair.a.id, pair.b.id])}
                    data-testid={`button-merge-${key}`}
                  >
                    Merge…
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selection.count > 0 ? (
        <div
          className="sticky bottom-4 z-10 mx-auto flex w-fit flex-wrap items-center gap-3 rounded-full border bg-background/95 px-4 py-2 shadow-lg backdrop-blur"
          data-testid="duplicates-selection-bar"
        >
          <span className="text-sm font-medium">
            {selection.count.toLocaleString()} selected
          </span>
          {!selectionLoaded ? (
            <span className="text-xs text-muted-foreground">Loading…</span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={
              batchBusy || !selectionLoaded || selectedSafePairs.length === 0
            }
            onClick={() => setPending({ kind: "merge-selected" })}
            data-testid="button-bulk-merge-safe"
          >
            Merge safe ({selectedSafePairs.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={batchBusy || !selectionLoaded}
            onClick={() => setPending({ kind: "dismiss-selected" })}
            data-testid="button-bulk-dismiss"
          >
            Dismiss ({selection.count})
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={batchBusy}
            onClick={() => selection.clear()}
            aria-label="Clear selection"
            data-testid="button-clear-selection"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o && !batchBusy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "dismiss-selected"
                ? `Dismiss ${selectedPairs.length} ${selectedPairs.length === 1 ? "pair" : "pairs"}?`
                : pending?.kind === "merge-all"
                  ? `Merge all ${safePairs.length} safe ${safePairs.length === 1 ? "pair" : "pairs"}?`
                  : `Merge ${selectedSafePairs.length} safe ${selectedSafePairs.length === 1 ? "pair" : "pairs"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "dismiss-selected"
                ? "These pairs won't be flagged as duplicates again. This can't be undone from here."
                : `Each pair will be combined into a single ${noun}, keeping every filled-in value. This can't be undone. Unsafe pairs in your selection are skipped — only safe pairs are merged. Pairs that differ on a real value are never auto-merged.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={batchBusy}
              onClick={(e) => {
                e.preventDefault();
                void runPending();
              }}
              data-testid="button-confirm-batch"
            >
              {batchBusy
                ? "Working…"
                : pending?.kind === "dismiss-selected"
                  ? "Dismiss"
                  : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {mergePair && type === "organization" && (
        <OrgMergeLauncher ids={mergePair} onClose={() => setMergePair(null)} />
      )}
      {mergePair && type === "person" && (
        <PersonMergeLauncher ids={mergePair} onClose={() => setMergePair(null)} />
      )}
    </div>
  );
}
