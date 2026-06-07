import { Button } from "@/components/ui/button";
import { Trash2, X } from "lucide-react";

/**
 * Sticky bottom action bar that appears while at least one row is
 * selected. Floats above the page using `sticky bottom-4` so it stays
 * in view while scrolling but doesn't cover the table chrome.
 */
export function BulkActionBar({
  count,
  onEdit,
  onMerge,
  onDelete,
  onClear,
  entityNoun,
  extraActions,
}: {
  count: number;
  onEdit: () => void;
  /** When provided, a "Merge" button appears once 2+ rows are selected. */
  onMerge?: () => void;
  /** When provided, a destructive "Delete" button appears for any selection. */
  onDelete?: () => void;
  onClear: () => void;
  /** Singular noun used in the label, e.g. "person" → "1 person selected". */
  entityNoun: string;
  /**
   * Extra action buttons rendered once 2+ rows are selected (e.g. the gifts
   * page's two merge variants). The caller is responsible for their own
   * disabled/visible logic beyond the 2+ gate.
   */
  extraActions?: React.ReactNode;
}) {
  if (count === 0) return null;
  const label = `${count.toLocaleString()} ${count === 1 ? entityNoun : `${entityNoun}s`} selected`;
  return (
    <div
      className="sticky bottom-4 z-30 mx-auto flex w-fit items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-lg"
      data-testid="bulk-action-bar"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-sm font-medium" data-testid="bulk-selected-count">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onEdit} data-testid="button-bulk-edit">
          Edit selected
        </Button>
        {onMerge && count >= 2 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onMerge}
            data-testid="button-bulk-merge"
          >
            Merge
          </Button>
        )}
        {count >= 2 && extraActions}
        {onDelete && (
          <Button
            size="sm"
            variant="destructive"
            onClick={onDelete}
            data-testid="button-bulk-delete"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          data-testid="button-bulk-clear"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Clear selection</span>
        </Button>
      </div>
    </div>
  );
}
