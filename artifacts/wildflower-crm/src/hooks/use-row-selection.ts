import { useCallback, useMemo, useState } from "react";

/**
 * Tiny selection-set hook used by the list pages that opt into bulk
 * editing. Persists across pagination by design — list pages should
 * clear it themselves whenever filters/search change (selection over
 * a different result set is rarely what the user wants).
 *
 * State is a plain Set behind useState. Setters pass a fresh Set when
 * (and ONLY when) the contents actually change; when a call is a no-op
 * (clearing an already-empty selection, removing ids that aren't
 * selected, …) they return the previous Set unchanged so React's
 * Object.is bailout stops the update. This no-op guard is load-bearing:
 * an effect that both depends on the returned selection object and
 * calls a setter would otherwise loop forever (new Set → new object →
 * effect re-fires), which React aborts with "Maximum update depth
 * exceeded" and blanks the page.
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
      // No-op when there is nothing to toggle (empty page) so state —
      // and the memoized selection object — keep their identity.
      if (ids.length === 0) return prev;
      const allOn = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allOn) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(
    () => setSelected((prev) => (prev.size === 0 ? prev : new Set())),
    [],
  );

  /**
   * Remove a specific set of ids from the selection. Used after bulk
   * submit so successfully-updated rows drop out while failed rows
   * stay selected for the user to retry / inspect.
   */
  const removeMany = useCallback((ids: ReadonlyArray<string>) => {
    if (ids.length === 0) return;
    setSelected((prev) => {
      // No-op when none of the ids are actually selected — keep the
      // previous Set's identity so dependent effects reach a fixed point.
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  // Memoize the returned object so its identity is stable across renders
  // (it only changes when `selected` does). Pages depend on this object in
  // their effect deps; an unmemoized object churns every render and, when
  // those effects also call selection setters, produces an infinite update
  // loop that blanks the page.
  return useMemo(
    () => ({
      selectedIds,
      count: selected.size,
      isSelected,
      toggle,
      toggleVisible,
      clear,
      removeMany,
    }),
    [selectedIds, selected.size, isSelected, toggle, toggleVisible, clear, removeMany],
  );
}
