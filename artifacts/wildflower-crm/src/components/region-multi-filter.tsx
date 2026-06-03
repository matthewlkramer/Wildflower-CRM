import { useMemo, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import {
  useListRegions,
  getListRegionsQueryKey,
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
import { cn } from "@/lib/utils";
import { buildRegionIndex, regionDisplayName } from "@/components/region-picker";

const QUERY_PARAMS = { limit: 1000 } as const;

/**
 * Searchable multi-select dropdown for filtering by `regionIds` (array overlap).
 *
 * The user types part of a region name to narrow the list, then clicks/checks
 * one or more regions. Selected regions are shown as badges on the trigger.
 * Filtering is done client-side over the full ~568-region list so no extra
 * round-trips are needed.
 */
export function RegionMultiFilter({
  selected,
  onChange,
  testId,
  label = "Region",
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  testId: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { data } = useListRegions(QUERY_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(QUERY_PARAMS),
      staleTime: 5 * 60_000,
    },
  });

  const { options, labelById } = useMemo(() => {
    const regions = data?.data ?? [];
    const byId = buildRegionIndex(regions);
    const opts = regions.map((r) => ({
      value: r.id,
      label: regionDisplayName(r, byId),
    }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    const lbl = new Map<string, string>(opts.map((o) => [o.value, o.label]));
    // Pin any selected id that's missing from the fetched list (edge case).
    for (const id of selected) {
      if (!lbl.has(id)) {
        lbl.set(id, `${id} (unknown)`);
        opts.unshift({ value: id, label: `${id} (unknown)` });
      }
    }
    return { options: opts, labelById: lbl };
  }, [data, selected]);

  const term = query.trim().toLowerCase();
  const visibleOptions = term
    ? options.filter((o) => o.label.toLowerCase().includes(term))
    : options;

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  const triggerLabel =
    selected.length === 0
      ? "Any"
      : selected.length === 1
        ? (labelById.get(selected[0]) ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label={label}
            className="w-[200px] justify-between font-normal"
            data-testid={testId}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[280px]" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search regions…"
              data-testid={`${testId}-search`}
            />
            <CommandList className="max-h-[300px]">
              {visibleOptions.length === 0 ? (
                <CommandEmpty>No regions match.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {visibleOptions.map((opt) => {
                    const checked = selected.includes(opt.value);
                    return (
                      <CommandItem
                        key={opt.value}
                        value={opt.value}
                        onSelect={() => toggle(opt.value)}
                        data-testid={`option-${testId}-${opt.value}`}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4 shrink-0",
                            checked ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="truncate">{opt.label}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
            {selected.length > 0 && (
              <div className="border-t p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={() => { onChange([]); setOpen(false); }}
                  data-testid={`${testId}-clear`}
                >
                  <X className="mr-1 h-3 w-3" />
                  Clear ({selected.length})
                </Button>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
