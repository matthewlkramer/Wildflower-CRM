import { useMemo, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
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
import {
  RegionTypeBadge,
  groupRegionOptions,
  matchesRegionQuery,
  useRegionContainmentInfo,
  useRegionOptions,
  useRegionRecents,
  type RegionPickerContext,
} from "@/components/region-picker-core";

/**
 * Searchable multi-select dropdown for filtering by `regionIds`.
 *
 * The server applies containment-aware matching: filtering by a state or
 * grouping also matches records tagged with any contained region. The
 * indicator under the trigger makes that expansion visible ("also matches N
 * regions inside the selection"). Search covers name, path, state
 * abbreviation, and aliases; results are type-grouped with recents on top.
 */
export function RegionMultiFilter({
  selected,
  onChange,
  testId,
  label = "Region",
  context = "generic",
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  testId: string;
  label?: string;
  context?: RegionPickerContext;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { options, byId } = useRegionOptions();
  const { recents, recordRecent } = useRegionRecents(context);
  const { containedCount } = useRegionContainmentInfo(selected);

  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.id, o.label);
    for (const id of selected) if (!m.has(id)) m.set(id, `${id} (unknown)`);
    return m;
  }, [options, selected]);

  const term = query.trim();
  const visible = term ? options.filter((o) => matchesRegionQuery(o, term)) : options;
  const groups = groupRegionOptions(visible, context);
  const recentOptions = term
    ? []
    : recents.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else {
      onChange([...selected, id]);
      recordRecent(id);
    }
  };

  const triggerLabel =
    selected.length === 0
      ? "Any"
      : selected.length === 1
        ? (labelById.get(selected[0]) ?? selected[0])
        : `${selected.length} selected`;

  const renderItem = (opt: { id: string; label: string; type: string | null }) => {
    const checked = selected.includes(opt.id);
    return (
      <CommandItem
        key={opt.id}
        value={opt.id}
        onSelect={() => toggle(opt.id)}
        data-testid={`option-${testId}-${opt.id}`}
      >
        <Check className={cn("mr-2 h-4 w-4 shrink-0", checked ? "opacity-100" : "opacity-0")} />
        <span className="truncate">{opt.label}</span>
        <RegionTypeBadge type={opt.type} />
      </CommandItem>
    );
  };

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
        <PopoverContent className="p-0 w-[300px]" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search name, state, or alias…"
              data-testid={`${testId}-search`}
            />
            <CommandList className="max-h-[300px]">
              {visible.length === 0 ? (
                <CommandEmpty>No regions match.</CommandEmpty>
              ) : (
                <>
                  {recentOptions.length > 0 && (
                    <CommandGroup heading="Recent">
                      {recentOptions.map((o) => renderItem(o))}
                    </CommandGroup>
                  )}
                  {groups.map((g) => (
                    <CommandGroup key={g.key} heading={g.heading}>
                      {g.options.map((o) => renderItem(o))}
                    </CommandGroup>
                  ))}
                </>
              )}
            </CommandList>
            {selected.length > 0 && (
              <div className="border-t p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={() => {
                    onChange([]);
                    setOpen(false);
                  }}
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
      {selected.length > 0 && containedCount > 0 && (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid={`${testId}-expansion-note`}
        >
          Also matches {containedCount} region{containedCount === 1 ? "" : "s"} inside the
          selection
        </p>
      )}
    </div>
  );
}
