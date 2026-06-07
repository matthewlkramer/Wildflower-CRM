import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import {
  useListRegions,
  getListRegionsQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
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
 * Controlled multi-select for `regionIds`, styled to sit inside a form/dialog.
 * A searchable popover picks regions; the current selection renders as
 * removable chips beneath the trigger. Selection-only (no inline create) —
 * use InlineEditMultiRegionPicker on detail rows when create is needed.
 */
export function RegionMultiCombobox({
  value,
  onChange,
  testId,
  placeholder = "Add region…",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  testId?: string;
  placeholder?: string;
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
    // Pin any selected id missing from the fetched list (edge case) so a
    // re-save doesn't silently drop it.
    for (const id of value) {
      if (!lbl.has(id)) {
        lbl.set(id, `${id} (unknown)`);
        opts.unshift({ value: id, label: `${id} (unknown)` });
      }
    }
    return { options: opts, labelById: lbl };
  }, [data, value]);

  const term = query.trim().toLowerCase();
  const visibleOptions = term
    ? options.filter((o) => o.label.toLowerCase().includes(term))
    : options;

  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  };

  const triggerLabel =
    value.length === 0 ? placeholder : `${value.length} selected`;

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            size="sm"
            className="h-8 w-full justify-between font-normal"
            data-testid={testId}
          >
            <span
              className={cn("truncate", value.length === 0 && "text-muted-foreground")}
            >
              {triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search regions…"
              data-testid={testId ? `${testId}-search` : undefined}
            />
            <CommandList className="max-h-[300px]">
              {visibleOptions.length === 0 ? (
                <CommandEmpty>No regions match.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {visibleOptions.map((opt) => {
                    const checked = value.includes(opt.value);
                    return (
                      <CommandItem
                        key={opt.value}
                        value={opt.value}
                        onSelect={() => toggle(opt.value)}
                        data-testid={
                          testId ? `option-${testId}-${opt.value}` : undefined
                        }
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
            {value.length > 0 && (
              <div className="border-t p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={() => onChange([])}
                  data-testid={testId ? `${testId}-clear` : undefined}
                >
                  <X className="mr-1 h-3 w-3" />
                  Clear ({value.length})
                </Button>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1 font-normal">
              <span className="truncate max-w-[12rem]">
                {labelById.get(id) ?? id}
              </span>
              <button
                type="button"
                aria-label="Remove region"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((x) => x !== id))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
