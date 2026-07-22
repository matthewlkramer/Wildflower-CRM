import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
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
import { useIsAdmin } from "@/hooks/use-is-admin";
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
 * Controlled multi-select for `regionIds`, styled to sit inside a form/dialog.
 * Search-first (matches name, path, state abbreviation, and aliases),
 * type-grouped with context-aware ordering, recents on top, type badges, and
 * advisory-disabled redundant rows ("Already included through X") on
 * candidates already contained in a selected region — labeled and visible,
 * never hidden or auto-removed. Selection-only — creation lives in the
 * admin-only structured dialog, not here.
 */
export function RegionMultiCombobox({
  value,
  onChange,
  testId,
  placeholder = "Add region…",
  context = "generic",
  showRedundancyHints = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  testId?: string;
  placeholder?: string;
  context?: RegionPickerContext;
  showRedundancyHints?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { options, byId } = useRegionOptions();
  const { recents, recordRecent } = useRegionRecents(context);
  const { coveredBy } = useRegionContainmentInfo(showRedundancyHints ? value : []);
  const isAdmin = useIsAdmin();

  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.id, o.label);
    for (const id of value) if (!m.has(id)) m.set(id, `${id} (unknown)`);
    return m;
  }, [options, value]);

  const term = query.trim();
  const visible = term ? options.filter((o) => matchesRegionQuery(o, term)) : options;
  const groups = groupRegionOptions(visible, context);
  const recentOptions = term
    ? []
    : recents.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o);

  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else {
      onChange([...value, id]);
      recordRecent(id);
    }
  };

  const triggerLabel = value.length === 0 ? placeholder : `${value.length} selected`;

  const renderItem = (opt: { id: string; label: string; type: string | null }) => {
    const checked = value.includes(opt.id);
    const container = showRedundancyHints && !checked ? coveredBy.get(opt.id) : undefined;
    return (
      <CommandItem
        key={opt.id}
        value={opt.id}
        onSelect={() => toggle(opt.id)}
        disabled={!!container}
        className={cn(container && "opacity-60")}
        data-testid={testId ? `option-${testId}-${opt.id}` : undefined}
      >
        <Check
          className={cn("mr-2 h-4 w-4 shrink-0", checked ? "opacity-100" : "opacity-0")}
        />
        <span className="truncate">{opt.label}</span>
        {container ? (
          <Badge
            variant="outline"
            className="ml-auto max-w-[14rem] shrink-0 truncate px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
          >
            Already included through {labelById.get(container) ?? container}
          </Badge>
        ) : (
          <RegionTypeBadge type={opt.type} />
        )}
      </CommandItem>
    );
  };

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
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 w-[--radix-popover-trigger-width] min-w-[280px]"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search name, state, or alias…"
              data-testid={testId ? `${testId}-search` : undefined}
            />
            <CommandList className="max-h-[300px]">
              {visible.length === 0 ? (
                <CommandEmpty>
                  No regions match.
                  {!isAdmin && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Can't find this region? Ask an admin to add it.
                    </span>
                  )}
                </CommandEmpty>
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
              <span className="truncate max-w-[12rem]">{labelById.get(id) ?? id}</span>
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
