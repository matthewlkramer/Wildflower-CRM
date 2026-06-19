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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

  const invalidateDuplicates = () =>
    queryClient.invalidateQueries({ queryKey: [DUP_KEY_PREFIX] });

  const handleDismiss = (pair: DuplicatePair) => {
    dismissMut.mutate(
      { data: { type, idA: pair.a.id, idB: pair.b.id } },
      {
        onSuccess: () => {
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

  const pairs = data?.pairs ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Potential Duplicates
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Likely-duplicate records detected by similar names and shared phone
          numbers. Review each pair, then merge the duplicates into one record or
          dismiss the pair if they're genuinely different.
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
          {pairs.map((pair) => {
            const key = `${pair.a.id}__${pair.b.id}`;
            return (
              <div
                key={key}
                className="rounded-lg border p-4 space-y-3"
                data-testid={`duplicate-pair-${key}`}
              >
                <div className="flex flex-wrap items-center gap-2">
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
                    disabled={dismissMut.isPending}
                    onClick={() => handleDismiss(pair)}
                    data-testid={`button-dismiss-${key}`}
                  >
                    Not a duplicate
                  </Button>
                  <Button
                    size="sm"
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

      {mergePair && type === "organization" && (
        <OrgMergeLauncher ids={mergePair} onClose={() => setMergePair(null)} />
      )}
      {mergePair && type === "person" && (
        <PersonMergeLauncher ids={mergePair} onClose={() => setMergePair(null)} />
      )}
    </div>
  );
}
