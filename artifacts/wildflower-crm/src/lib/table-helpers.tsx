import * as React from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";
export type SortState = { key: string | null; dir: SortDir };

const MIN_COL_WIDTH = 60;
const MAX_COL_WIDTH = 900;

function readJSON<T>(k: string, fallback: T): T {
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(k);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(k: string, v: unknown) {
  try {
    if (typeof window === "undefined") return;
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* quota / disabled — ignore */
  }
}

export function useTableState(
  tableId: string,
  initialSort?: { key: string; dir?: SortDir },
) {
  const wkey = `wf.tablew.${tableId}`;
  const skey = `wf.tables.${tableId}`;

  const [widths, setWidths] = React.useState<Record<string, number>>(() =>
    readJSON<Record<string, number>>(wkey, {}),
  );
  const [sort, setSort] = React.useState<SortState>(() =>
    readJSON<SortState>(
      skey,
      initialSort
        ? { key: initialSort.key, dir: initialSort.dir ?? "asc" }
        : { key: null, dir: "asc" },
    ),
  );

  React.useEffect(() => writeJSON(wkey, widths), [wkey, widths]);
  React.useEffect(() => writeJSON(skey, sort), [skey, sort]);

  const toggleSort = React.useCallback((key: string) => {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const setWidth = React.useCallback((key: string, w: number) => {
    setWidths((cur) => ({
      ...cur,
      [key]: Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(w))),
    }));
  }, []);

  return { widths, setWidth, sort, toggleSort };
}

export type TableStateProps = ReturnType<typeof useTableState>;

export function sortRows<T>(
  rows: readonly T[],
  accessors: Record<string, (r: T) => unknown>,
  sort: SortState,
): T[] {
  if (!sort.key || !accessors[sort.key]) return rows as T[];
  const acc = accessors[sort.key];
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = acc(a);
    const vb = acc(b);
    const ea = va == null || va === "";
    const eb = vb == null || vb === "";
    // Nulls / blanks always sort last regardless of direction so the
    // interesting rows stay at the top when toggling.
    if (ea && eb) return 0;
    if (ea) return 1;
    if (eb) return -1;
    if (va instanceof Date && vb instanceof Date) {
      return (va.getTime() - vb.getTime()) * mul;
    }
    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * mul;
    }
    // Detect numeric strings (decimals from the DB come as strings).
    const sa = String(va);
    const sb = String(vb);
    const na = Number(sa);
    const nb = Number(sb);
    if (
      !Number.isNaN(na) &&
      !Number.isNaN(nb) &&
      /^-?\d/.test(sa.trim()) &&
      /^-?\d/.test(sb.trim())
    ) {
      return (na - nb) * mul;
    }
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" }) * mul;
  });
}

type SortableTHProps = {
  colKey: string;
  widths: Record<string, number>;
  setWidth: (k: string, w: number) => void;
  sort: SortState;
  toggleSort: (k: string) => void;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
  children: React.ReactNode;
};

/**
 * Drop-in replacement for `<TableHead>` that:
 *  - Shows a sort indicator and toggles asc/desc on click (set `sortable={false}` to skip).
 *  - Renders a draggable right-edge handle that resizes the column. Width is persisted
 *    via the `widths` map that the parent passes in (backed by localStorage in
 *    `useTableState`).
 */
export function SortableTH({
  colKey,
  widths,
  setWidth,
  sort,
  toggleSort,
  sortable = true,
  align = "left",
  className,
  children,
}: SortableTHProps) {
  const thRef = React.useRef<HTMLTableCellElement>(null);
  const width = widths[colKey];

  const onResizeDown = React.useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      // Don't let the click bubble into the sort button or the row.
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = thRef.current?.getBoundingClientRect().width ?? 100;
      const handle = e.currentTarget;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers throw for synthetic events — safe to ignore */
      }
      const onMove = (ev: PointerEvent) => {
        setWidth(colKey, startW + (ev.clientX - startX));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [colKey, setWidth],
  );

  const isSorted = sortable && sort.key === colKey;
  const arrow = !sortable ? null : isSorted ? (
    sort.dir === "asc" ? (
      <ChevronUp className="ml-1 h-3 w-3 shrink-0" />
    ) : (
      <ChevronDown className="ml-1 h-3 w-3 shrink-0" />
    )
  ) : (
    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-30 group-hover:opacity-60" />
  );

  const justify =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  const textAlign =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";

  return (
    <TableHead
      ref={thRef}
      className={cn("relative select-none", textAlign, className)}
      style={width ? { width, minWidth: width, maxWidth: width } : undefined}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => toggleSort(colKey)}
          className={cn(
            "group flex items-center w-full hover:text-foreground transition-colors",
            justify,
          )}
          data-testid={`sort-${colKey}`}
        >
          <span className="truncate">{children}</span>
          {arrow}
        </button>
      ) : (
        <div className={cn("flex items-center w-full", justify)}>
          <span className="truncate">{children}</span>
        </div>
      )}
      <span
        onPointerDown={onResizeDown}
        onClick={(e) => e.stopPropagation()}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${colKey} column`}
        data-testid={`resize-${colKey}`}
      />
    </TableHead>
  );
}
