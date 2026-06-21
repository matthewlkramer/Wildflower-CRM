import { type ReactNode } from "react";

/**
 * Shared list-page header. Lays out the page title with a compact add action
 * ("+") immediately to its right, an optional subtitle below, and a slot on
 * the far right for utility controls (show-archived toggle, view toggle,
 * filters/columns menus). Keeping these controls here frees up the filters
 * row below so it only holds search + active filters.
 */
export function ListPageHeader({
  title,
  subtitle,
  addAction,
  controls,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  addAction?: ReactNode;
  controls?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {title}
          </h1>
          {addAction}
        </div>
        {subtitle != null && (
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        )}
      </div>
      {controls != null && (
        <div className="flex items-center gap-2 shrink-0">{controls}</div>
      )}
    </div>
  );
}
