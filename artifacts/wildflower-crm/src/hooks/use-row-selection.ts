import { useCallback, useMemo, useState } from "react";

/**
 * Tiny selection-set hook used by the list pages that opt into bulk
 * editing. Persists across pagination by design — list pages should
 * clear it themselves whenever filters/search change (selection over
 * a different result set is rarely what the user wants).
 *
 * State is a plain Set behind useState. The setter always passes a
 * fresh Set so React picks up the change.
 */
export function useRowSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Toggle the "select all rows currently on screen" header checkbox.
   * If every visible id is already selected, deselect them all;
   * otherwise add the missing ones. Selections from other pages are
   * preserved.
   */
  const toggleVisible = useCallback((ids: ReadonlyArray<string>) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = ids.length > 0 && ids.every((id) => next.has(id));
      if (allOn) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  return {
    selectedIds,
    count: selected.size,
    isSelected,
    toggle,
    toggleVisible,
    clear,
  };
}
