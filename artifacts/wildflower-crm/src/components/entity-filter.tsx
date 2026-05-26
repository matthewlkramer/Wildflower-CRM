import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import {
  useListEntities,
  getListEntitiesQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { partitionEntities } from "@/lib/dropdownVisibility";
import { useEntityFilter } from "@/lib/entity-filter-context";

// Header-mounted entity filter. Reads + writes the global EntityFilterContext
// so the selection follows the user across pages. Used in the global header.
export function HeaderEntityFilter() {
  const { selected, setSelected } = useEntityFilter();
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const options = useMemo(
    () =>
      (entitiesQ.data ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        active: e.active,
      })),
    [entitiesQ.data],
  );
  return (
    <EntityMultiSelect
      options={options}
      value={selected}
      onChange={setSelected}
      align="end"
      showChips={false}
    />
  );
}

// Generic multi-select picker for entities. Renders a popover combobox with a
// "Show retired" toggle and an optional chip strip below for explicit removal.
// Kept here (rather than in dashboard.tsx) so Settings can reuse it for
// picking the user's default-entity preference.
export function EntityMultiSelect({
  options,
  value,
  onChange,
  align = "end",
  showChips = true,
  triggerLabelPrefix = "Entities:",
  placeholder = "All entities",
}: {
  options: ReadonlyArray<{ id: string; name: string; active: boolean }>;
  value: string[];
  onChange: (next: string[]) => void;
  align?: "start" | "end";
  showChips?: boolean;
  triggerLabelPrefix?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(value);
  const labelFor = (id: string) =>
    options.find((o) => o.id === id)?.name ?? id;
  const triggerLabel =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? labelFor(value[0])
        : `${value.length} entities`;

  const { active, retired } = useMemo(
    () => partitionEntities(options),
    [options],
  );
  const retiredIds = useMemo(
    () => new Set(retired.map((r) => r.id)),
    [retired],
  );
  const selectionIncludesRetired = value.some((id) => retiredIds.has(id));
  const [showRetired, setShowRetired] = useState(false);
  const effectiveShowRetired = showRetired || selectionIncludesRetired;
  const visibleOptions = effectiveShowRetired ? [...active, ...retired] : active;

  const toggle = (id: string) => {
    onChange(
      selectedSet.has(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };
  const clear = () => onChange([]);

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            size="sm"
            className="h-8 min-w-[12rem] justify-between font-normal"
            data-testid="filter-entities"
          >
            <span className="truncate">
              {triggerLabelPrefix ? (
                <span className="text-muted-foreground mr-1">
                  {triggerLabelPrefix}
                </span>
              ) : null}
              {triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 w-[--radix-popover-trigger-width] min-w-[16rem]"
          align={align}
        >
          <Command>
            <CommandList>
              <CommandGroup>
                {visibleOptions.map((o) => {
                  const isSelected = selectedSet.has(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      value={o.id}
                      onSelect={() => toggle(o.id)}
                      data-testid={`filter-entities-option-${o.id}`}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{o.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {retired.length > 0 && !selectionIncludesRetired ? (
                <CommandGroup>
                  <CommandItem
                    value="__toggle_retired__"
                    onSelect={() => setShowRetired((s) => !s)}
                    data-testid="filter-entities-toggle-retired"
                    className="text-muted-foreground text-xs justify-center"
                  >
                    {effectiveShowRetired
                      ? "Hide retired entities"
                      : `Show retired entities (${retired.length})`}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {value.length > 0 ? (
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    onSelect={clear}
                    data-testid="filter-entities-clear"
                    className="text-muted-foreground"
                  >
                    <X className="mr-2 h-4 w-4" />
                    Clear filter (all entities)
                  </CommandItem>
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {showChips && value.length > 0 ? (
        <div
          className={cn(
            "flex flex-wrap gap-1 max-w-[24rem]",
            align === "end" ? "justify-end" : "justify-start",
          )}
        >
          {value.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 pr-1"
              data-testid={`filter-entities-chip-${id}`}
            >
              {labelFor(id)}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label={`Remove ${labelFor(id)}`}
                className="rounded hover:bg-muted-foreground/10"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
