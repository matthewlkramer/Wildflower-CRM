import { useMemo, useState } from "react";
import { ListFilter, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  defaultFiltersState,
  isDefaultFiltersState,
  type FilterDef,
  type FiltersState,
} from "@/lib/filters";

interface Props {
  /** The full registry for the page, in canonical order. */
  registry: readonly FilterDef[];
  /** Current state, or null when the user hasn't customized anything. */
  state: FiltersState | null;
  /** Persist a new state. Pass null to clear back to the default. */
  onChange: (next: FiltersState | null) => void;
}

// Filter chooser — sibling of ColumnsMenu. Renders a popover with one
// checkbox per optional filter so users decide which filter controls
// appear in the toolbar. Required filters (e.g. name search) aren't
// listed because they can never be hidden. Hiding a filter that
// currently holds a value clears that value (via the def's `clear`
// callback) so a hidden filter never silently narrows the results.
export function FiltersMenu({ registry, state, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const byKey = useMemo(
    () => new Map(registry.map((f) => [f.key, f])),
    [registry],
  );

  // Toggleable filters only — required ones are always shown and never
  // appear in the chooser.
  const toggleable = useMemo(
    () => registry.filter((f) => !f.required),
    [registry],
  );

  const hiddenSet = useMemo<Set<string>>(() => {
    if (!state?.known) {
      return new Set(
        registry
          .filter((f) => f.defaultVisible === false && !f.required)
          .map((f) => f.key),
      );
    }
    // Explicit state: start from the saved hidden list, but a filter the
    // saved state predates (absent from `known`) follows its registry
    // default so a newly-introduced opt-in filter reads as hidden until
    // toggled — mirroring resolveFilters.
    const knownSet = new Set(state.known);
    const set = new Set(state.hidden);
    for (const f of registry) {
      if (!f.required && f.defaultVisible === false && !knownSet.has(f.key)) {
        set.add(f.key);
      }
    }
    return set;
  }, [registry, state]);

  // Emit a new state, collapsing to `null` when it matches the registry
  // defaults so saved-view JSON comparisons stay stable.
  function emit(hidden: string[]) {
    const next: FiltersState = { known: registry.map((f) => f.key), hidden };
    onChange(isDefaultFiltersState(registry, next) ? null : next);
  }

  function toggle(key: string) {
    const def = byKey.get(key);
    if (!def || def.required) return;
    if (hiddenSet.has(key)) {
      // Showing the filter again.
      emit([...hiddenSet].filter((k) => k !== key));
    } else {
      // Hiding it — clear any value first so it stops narrowing results.
      if (def.active) def.clear?.();
      emit([...hiddenSet, key]);
    }
  }

  function reset() {
    onChange(null);
  }

  const isCustomized = !isDefaultFiltersState(registry, state);
  const visibleCount = toggleable.filter((f) => !hiddenSet.has(f.key)).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-3 text-xs"
          data-testid="filters-menu-trigger"
          aria-label="Configure filters"
        >
          <ListFilter className="h-3.5 w-3.5 mr-1.5" />
          Filters
          {isCustomized ? (
            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary px-1.5 text-[10px] font-medium">
              {visibleCount}/{toggleable.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[260px] p-2"
        align="end"
        data-testid="filters-menu"
      >
        <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b">
          <span className="text-xs font-medium text-muted-foreground">
            Filters
          </span>
          {isCustomized ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={reset}
              data-testid="filters-menu-reset"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
          ) : null}
        </div>
        <div className="max-h-[360px] overflow-y-auto space-y-0.5">
          {toggleable.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No optional filters.
            </div>
          ) : (
            toggleable.map((def) => {
              const hidden = hiddenSet.has(def.key);
              return (
                <div
                  key={def.key}
                  className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-muted text-sm"
                  data-testid={`filters-menu-row-${def.key}`}
                >
                  <Checkbox
                    checked={!hidden}
                    onCheckedChange={() => toggle(def.key)}
                    aria-label={`Show ${def.label} filter`}
                    data-testid={`filters-menu-toggle-${def.key}`}
                  />
                  <span
                    className={
                      hidden ? "flex-1 truncate text-muted-foreground" : "flex-1 truncate"
                    }
                    title={def.label}
                  >
                    {def.label}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
