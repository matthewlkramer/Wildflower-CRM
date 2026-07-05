import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Compact multi-select toolbar rendered at the top of a reconciliation column.
 * A select-all checkbox + selection count on the left; the bulk-action buttons
 * (passed as children) on the right. Purely presentational — the parent owns
 * the selection set and the action handlers.
 */
export function BulkSelectBar({
  selectedCount,
  allSelected,
  onToggleAll,
  testId = "checkbox-select-all",
  children,
}: {
  selectedCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  /** Distinguishes the select-all checkbox when two bars share a page. */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Checkbox
        checked={allSelected}
        onCheckedChange={onToggleAll}
        aria-label="Select all"
        data-testid={testId}
      />
      <span className="text-xs text-muted-foreground">
        {selectedCount} selected
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}
