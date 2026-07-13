import { useEffect, useState } from "react";
import { ChevronsUpDown, Check, X } from "lucide-react";
import {
  useSearchReconciliationNode,
  getSearchReconciliationNodeQueryKey,
  type ReconciliationCandidate,
  type ReconciliationMatchNodeType,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { CANDIDATE_SOURCE_LABEL } from "@/lib/reconciliation";

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Cross-filtering typeahead for one reconciliation node (donor / gift /
 * opportunity), anchored to a money event so amount/date windows and the gift
 * pool stay tied to it. Pass EXACTLY ONE anchor: `stagedPaymentId` (a QuickBooks
 * card) or `stripeChargeId` (a settlement-bundle Stripe charge row that has no
 * staged payment — a charge supports only donor/gift). Pass `donorId` to filter
 * gift/opportunity candidates to a chosen donor (the FILTER edge).
 *
 * The selected value is the full candidate (not just an id) so the trigger can
 * render its label even when it isn't in the current search results (e.g. the
 * server's auto-locked guess).
 */
export function ReconciliationNodeTypeahead({
  nodeType,
  stagedPaymentId,
  stripeChargeId,
  donorId,
  value,
  onChange,
  days = 30,
  placeholder = "Search…",
  disabled,
  testId,
}: {
  nodeType: ReconciliationMatchNodeType;
  stagedPaymentId?: string | null;
  stripeChargeId?: string | null;
  donorId?: string | null;
  value: ReconciliationCandidate | null;
  onChange: (next: ReconciliationCandidate | null) => void;
  days?: number;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);

  const searchParams = {
    stagedPaymentId: stagedPaymentId ?? undefined,
    stripeChargeId: stripeChargeId ?? undefined,
    q: debounced.trim() || undefined,
    donorId: donorId ?? undefined,
    days,
    limit: 25,
  };

  const { data, isLoading } = useSearchReconciliationNode(nodeType, searchParams, {
    query: {
      enabled: open,
      queryKey: getSearchReconciliationNodeQueryKey(nodeType, searchParams),
    },
  });

  const candidates = data?.data ?? [];

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            data-testid={testId}
            className="h-9 min-w-0 flex-1 justify-between font-normal"
          >
            <span className="truncate text-left">
              {value ? (
                <>
                  {value.label}
                  {value.sublabel ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {value.sublabel}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">{placeholder}</span>
              )}
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
              placeholder={placeholder}
              data-testid={testId ? `${testId}-search` : undefined}
            />
            <CommandList>
              {isLoading ? (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  Searching…
                </div>
              ) : candidates.length === 0 ? (
                <CommandEmpty>No matches.</CommandEmpty>
              ) : null}
              <CommandGroup>
                {candidates.map((c) => {
                  const alreadyLinked = Boolean(c.alreadyLinkedStagedPaymentId);
                  // The server may return candidates of a DIFFERENT node type
                  // (e.g. pledges/opportunities in a unified gift search).
                  // They stay selectable — a manual pick always wins — and
                  // carry a type badge so the reviewer knows what they're
                  // choosing.
                  const wrongType = c.nodeType !== nodeType;
                  return (
                    <CommandItem
                      key={c.id}
                      value={c.id}
                      disabled={alreadyLinked}
                      onSelect={() => {
                        onChange(c);
                        setOpen(false);
                      }}
                      data-testid={testId ? `${testId}-option-${c.id}` : undefined}
                      className="items-start"
                    >
                      <Check
                        className={cn(
                          "mr-2 mt-0.5 h-4 w-4 shrink-0",
                          value?.id === c.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate font-medium">{c.label}</span>
                        {c.sublabel ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {c.sublabel}
                          </span>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          {c.amount ? (
                            <span className="tabular-nums">
                              {formatCurrency(c.amount)}
                            </span>
                          ) : null}
                          {c.date ? <span>{formatDate(c.date)}</span> : null}
                          {c.source ? (
                            <Badge variant="outline" className="px-1 py-0 text-[10px]">
                              {CANDIDATE_SOURCE_LABEL[c.source]}
                            </Badge>
                          ) : null}
                          {wrongType ? (
                            <Badge variant="outline" className="px-1 py-0 text-[10px]">
                              {c.nodeType === "opportunity"
                                ? "Pledge / opportunity"
                                : c.nodeType}
                            </Badge>
                          ) : null}
                        </div>
                        {c.conflictReason ? (
                          <span className="text-xs text-destructive">
                            {c.conflictReason}
                          </span>
                        ) : null}
                        {alreadyLinked ? (
                          <span className="text-xs text-amber-600">
                            Already linked to another payment.
                          </span>
                        ) : null}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && !disabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 text-muted-foreground"
          aria-label="Clear selection"
          onClick={() => onChange(null)}
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
