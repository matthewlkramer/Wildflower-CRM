import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Pencil, X } from "lucide-react";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useGetOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RelatedRow } from "@/components/record-layout";
import { cn } from "@/lib/utils";
import { opportunityStatusLabel } from "@/lib/opportunity-status";

/**
 * Donor scope for the pledge picker. A gift always has exactly one donor
 * (DB-enforced XOR), so the pledge search is filtered to that donor's
 * opportunities & pledges — you can't accidentally link a payment to a
 * different donor's pledge. Null while the donor is still unset.
 */
export type PledgeDonorScope =
  | { organizationId: string }
  | { householdId: string }
  | { individualGiverPersonId: string }
  | null;

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function scopeToParams(scope: PledgeDonorScope): Record<string, string> {
  if (!scope) return {};
  return { ...scope };
}

function PledgeStatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const variant: "default" | "secondary" | "outline" =
    status === "open" ? "default" : status === "pledge" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className="shrink-0 text-xs font-normal">
      {opportunityStatusLabel(status)}
    </Badge>
  );
}

function PledgeCombobox({
  scope,
  value,
  onChange,
  disabled,
}: {
  scope: PledgeDonorScope;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const params = useMemo(
    () => ({
      ...scopeToParams(scope),
      ...(debounced ? { search: debounced } : {}),
      limit: 30,
      page: 1,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(scope), debounced],
  );

  const { data: resp, isLoading } = useListOpportunitiesAndPledges(params, {
    query: {
      queryKey: getListOpportunitiesAndPledgesQueryKey(params),
      staleTime: 15_000,
    },
  });
  const rows = resp?.data ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-8 justify-between min-w-0 flex-1 font-normal"
          data-testid="select-gift-pledge"
        >
          <span className="text-muted-foreground truncate">
            Search opportunities &amp; pledges…
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[320px]"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search by name…"
            data-testid="select-gift-pledge-search"
          />
          <CommandList>
            {isLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : null}
            {!isLoading && rows.length === 0 ? (
              <CommandEmpty>No results.</CommandEmpty>
            ) : null}
            <CommandGroup>
              <CommandItem
                value="__null__"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                data-testid="select-gift-pledge-clear"
              >
                <X className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                No linked pledge
              </CommandItem>
            </CommandGroup>
            {rows.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Opportunities &amp; pledges">
                  {rows.map((opp) => (
                    <CommandItem
                      key={opp.id}
                      value={opp.id}
                      onSelect={() => {
                        onChange(opp.id);
                        setOpen(false);
                      }}
                      data-testid={`select-gift-pledge-option-${opp.id}`}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          value === opp.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="truncate">{opp.name ?? opp.id}</span>
                        <PledgeStatusBadge status={opp.status} />
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Inline editor + clear link for a gift's "payment on pledge" link. In
 * display mode it renders the linked pledge as a clickable row (resolved
 * name + status, links to the pledge detail). The edit affordance swaps in
 * a donor-scoped opportunities/pledges combobox so a fundraiser can attach,
 * change, or clear the link on an existing gift.
 */
export function GiftPledgeLink({
  value,
  scope,
  onSave,
}: {
  value: string | null;
  scope: PledgeDonorScope;
  onSave: (next: string | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(value);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);

  const linked = useGetOpportunityOrPledge(value ?? "", {
    query: {
      queryKey: getGetOpportunityOrPledgeQueryKey(value ?? ""),
      enabled: !!value,
      staleTime: 60_000,
    },
  });
  const pledgeName = value ? (linked.data?.name ?? value) : null;
  const pledgeStatus = linked.data?.status ?? null;

  const dirty = draft !== value;
  const trySave = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await onSave(draft);
      // The link change recomputes the pledge's server-derived paid total, so
      // refresh the previously- and newly-linked pledge (plus the list) to keep
      // the status badge and any pledge views accurate.
      await Promise.all(
        [value, draft]
          .filter((id): id is string => !!id)
          .map((id) =>
            queryClient.invalidateQueries({
              queryKey: getGetOpportunityOrPledgeQueryKey(id),
            }),
          )
          .concat(
            queryClient.invalidateQueries({
              queryKey: getListOpportunitiesAndPledgesQueryKey(),
            }),
          ),
      );
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1.5">
        <PledgeCombobox
          scope={scope}
          value={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-primary"
          disabled={!dirty || busy}
          onClick={trySave}
          aria-label="Save linked pledge"
          data-testid="button-save-gift-pledge"
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground"
          disabled={busy}
          onClick={() => setEditing(false)}
          aria-label="Cancel editing linked pledge"
          data-testid="button-cancel-gift-pledge"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {value ? (
        <RelatedRow
          name={
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{pledgeName}</span>
              <PledgeStatusBadge status={pledgeStatus} />
            </span>
          }
          href={`/pledges/${value}`}
          tone="primary"
          sub="View pledge"
        />
      ) : (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No linked pledge.
        </div>
      )}
      <div className="px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-primary"
          onClick={() => setEditing(true)}
          data-testid="button-edit-gift-pledge"
        >
          <Pencil className="mr-1 h-3.5 w-3.5" />
          {value ? "Change pledge" : "Link a pledge"}
        </Button>
      </div>
    </div>
  );
}
