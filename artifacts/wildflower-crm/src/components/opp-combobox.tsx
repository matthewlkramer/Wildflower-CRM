import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Link2, X } from "lucide-react";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledge,
} from "@workspace/api-client-react";
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
import { cn } from "@/lib/utils";
import { formatEnum } from "@/lib/format";

function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function OppStatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const variant: "default" | "secondary" | "outline" =
    status === "open"
      ? "default"
      : status === "pledge"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className="shrink-0 text-xs font-normal">
      {formatEnum(status)}
    </Badge>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Opportunity combobox (searchable, scope-filtered)

   Shared by the gift form (link a new gift to an opportunity/pledge) and the
   reconciliation workbench ("Record as a payment on a pledge"). An empty
   `scopeParams` searches ALL opportunities & pledges by name. `testIdPrefix`
   namespaces the data-testids so two instances on one page don't collide.
   ────────────────────────────────────────────────────────────────────────── */

export function OppCombobox({
  scopeParams,
  selected,
  onSelect,
  onSkip,
  disabled,
  placeholder = "Search opportunities & pledges…",
  showSkip = true,
  skipLabel = "No linked opportunity",
  testIdPrefix = "select-new-gift-opp",
}: {
  scopeParams: Record<string, string>;
  selected: OpportunityOrPledge | null;
  onSelect: (opp: OpportunityOrPledge) => void;
  onSkip: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Show the "clear / no linked opportunity" affordances (off for a required pick). */
  showSkip?: boolean;
  skipLabel?: string;
  testIdPrefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const params = useMemo(
    () => ({
      ...scopeParams,
      ...(debounced ? { search: debounced } : {}),
      limit: 30,
      page: 1,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(scopeParams), debounced],
  );

  const { data: oppsResp, isLoading } = useListOpportunitiesAndPledges(params, {
    query: {
      queryKey: getListOpportunitiesAndPledgesQueryKey(params),
      staleTime: 15_000,
    },
  });

  const rows = oppsResp?.data ?? [];

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="h-8 justify-between min-w-0 flex-1 font-normal"
            data-testid={testIdPrefix}
          >
            {selected ? (
              <span className="flex items-center gap-2 min-w-0 flex-1">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{selected.name ?? selected.id}</span>
                <OppStatusBadge status={selected.status} />
              </span>
            ) : (
              <span className="text-muted-foreground truncate">
                {placeholder}
              </span>
            )}
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
              data-testid={`${testIdPrefix}-search`}
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
              {showSkip ? (
                <CommandGroup>
                  <CommandItem
                    value="__skip__"
                    onSelect={() => {
                      onSkip();
                      setOpen(false);
                    }}
                    data-testid={`${testIdPrefix}-skip`}
                  >
                    <X className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    {skipLabel}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {rows.length > 0 ? (
                <>
                  {showSkip ? <CommandSeparator /> : null}
                  <CommandGroup heading="Opportunities &amp; pledges">
                    {rows.map((opp) => (
                      <CommandItem
                        key={opp.id}
                        value={opp.id}
                        onSelect={() => {
                          onSelect(opp);
                          setOpen(false);
                        }}
                        data-testid={`${testIdPrefix}-option-${opp.id}`}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4 shrink-0",
                            selected?.id === opp.id
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="truncate">{opp.name ?? opp.id}</span>
                          <OppStatusBadge status={opp.status} />
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
      {selected && showSkip ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onSkip}
          aria-label="Clear linked opportunity"
          data-testid={`${testIdPrefix}-clear`}
          disabled={disabled}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
