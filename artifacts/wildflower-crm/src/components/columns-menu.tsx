import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  defaultColumnsState,
  isDefaultColumnsState,
  type ColumnDef,
  type ColumnsState,
} from "@/lib/columns";

interface Props<R> {
  /** The full registry for the page, in canonical order. */
  registry: readonly ColumnDef<R>[];
  /** Current state, or null when the user hasn't customized anything. */
  state: ColumnsState | null;
  /** Persist a new state. Pass null to clear back to the default. */
  onChange: (next: ColumnsState | null) => void;
}

// Lightweight columns picker. Renders as a popover with one row per
// column: visibility checkbox + label + up/down reorder buttons.
// We deliberately avoid drag-and-drop (no new dep, no touch fiddliness)
// — up/down arrows handle the rare reorder case well enough.
export function ColumnsMenu<R>({ registry, state, onChange }: Props<R>) {
  const [open, setOpen] = useState(false);

  // Materialize the effective ordered list for rendering. We start from
  // the saved order (if any) then append any registry columns the user
  // hasn't seen yet — same logic as `resolveColumns` but without the
  // visibility filter so hidden columns are still listed/toggleable.
  const orderedKeys = useMemo<string[]>(() => {
    const registryKeys = registry.map((c) => c.key);
    if (!state?.order || state.order.length === 0) return registryKeys;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of state.order) {
      if (registry.some((c) => c.key === k) && !seen.has(k)) {
        out.push(k);
        seen.add(k);
      }
    }
    for (const k of registryKeys) {
      if (!seen.has(k)) out.push(k);
    }
    return out;
  }, [registry, state]);

  const hiddenSet = useMemo<Set<string>>(() => {
    // No explicit state → derive from registry defaults so the
    // checkboxes show the right initial state on first open.
    if (!state?.hidden) {
      return new Set(
        registry
          .filter((c) => c.defaultVisible === false && !c.required)
          .map((c) => c.key),
      );
    }
    // Explicit state: start from the saved hidden list, but a column the
    // saved state predates (absent from `order`) follows its registry
    // default — keeping the checkbox in sync with `resolveColumns` so a
    // newly-introduced opt-in column reads as hidden until toggled.
    const orderSet = new Set(state.order ?? []);
    const set = new Set(state.hidden);
    for (const c of registry) {
      if (!c.required && c.defaultVisible === false && !orderSet.has(c.key)) {
        set.add(c.key);
      }
    }
    return set;
  }, [registry, state]);

  const byKey = useMemo(
    () => new Map(registry.map((c) => [c.key, c])),
    [registry],
  );

  // Helper that emits a new state, collapsing to `null` when the
  // resulting config matches the registry defaults. This keeps saved-
  // view JSON comparisons stable: a user who toggles a column off and
  // then back on lands back on `null`, not on a structurally-equal but
  // distinct object.
  function emit(order: string[], hidden: string[]) {
    const next: ColumnsState = { order, hidden };
    if (isDefaultColumnsState(registry, next)) {
      onChange(null);
    } else {
      onChange(next);
    }
  }

  function toggleHidden(key: string) {
    const def = byKey.get(key);
    if (!def || def.required) return;
    const nextHidden = hiddenSet.has(key)
      ? [...hiddenSet].filter((k) => k !== key)
      : [...hiddenSet, key];
    emit(orderedKeys, nextHidden);
  }

  function move(key: string, dir: -1 | 1) {
    const idx = orderedKeys.indexOf(key);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= orderedKeys.length) return;
    const next = [...orderedKeys];
    [next[idx], next[target]] = [next[target], next[idx]];
    emit(next, [...hiddenSet]);
  }

  function reset() {
    onChange(null);
  }

  const isCustomized = !isDefaultColumnsState(registry, state);
  const defaultHiddenCount = defaultColumnsState(registry).hidden.length;
  const visibleCount = orderedKeys.filter((k) => !hiddenSet.has(k)).length;
  const totalToggleable = registry.filter((c) => !c.required).length;
  const hiddenToggleableCount = totalToggleable - (visibleCount - registry.filter((c) => c.required).length);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-3 text-xs"
          data-testid="columns-menu-trigger"
          aria-label="Configure columns"
        >
          <Columns3 className="h-3.5 w-3.5 mr-1.5" />
          Columns
          {isCustomized ? (
            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary px-1.5 text-[10px] font-medium">
              {hiddenToggleableCount > 0
                ? `${visibleCount}/${orderedKeys.length}`
                : "•"}
            </span>
          ) : defaultHiddenCount > 0 ? (
            <span className="ml-1.5 text-muted-foreground">
              {visibleCount}/{orderedKeys.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[280px] p-2"
        align="end"
        data-testid="columns-menu"
      >
        <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b">
          <span className="text-xs font-medium text-muted-foreground">
            Columns
          </span>
          {isCustomized ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={reset}
              data-testid="columns-menu-reset"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
          ) : null}
        </div>
        <div className="max-h-[360px] overflow-y-auto space-y-0.5">
          {orderedKeys.map((key, idx) => {
            const def = byKey.get(key);
            if (!def) return null;
            const hidden = hiddenSet.has(key) && !def.required;
            return (
              <div
                key={key}
                className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-muted text-sm"
                data-testid={`columns-menu-row-${key}`}
              >
                <Checkbox
                  checked={!hidden}
                  disabled={def.required}
                  onCheckedChange={() => toggleHidden(key)}
                  aria-label={`Show ${def.label}`}
                  data-testid={`columns-menu-toggle-${key}`}
                />
                <span
                  className={
                    def.required
                      ? "flex-1 truncate text-muted-foreground"
                      : hidden
                        ? "flex-1 truncate text-muted-foreground"
                        : "flex-1 truncate"
                  }
                  title={def.required ? `${def.label} (always shown)` : def.label}
                >
                  {def.label}
                </span>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  onClick={() => move(key, -1)}
                  disabled={idx === 0}
                  aria-label={`Move ${def.label} up`}
                  data-testid={`columns-menu-up-${key}`}
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  onClick={() => move(key, 1)}
                  disabled={idx === orderedKeys.length - 1}
                  aria-label={`Move ${def.label} down`}
                  data-testid={`columns-menu-down-${key}`}
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
