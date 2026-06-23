import { useState, useMemo, Fragment } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Kanban column layout for the connection/enthusiasm calculated field.
 *
 * Rule: a card's column = connectionStatus, UNLESS connectionStatus is
 * "connected", in which case the column = enthusiasm (or "_connected_blank"
 * when enthusiasm is null).  Records with no connectionStatus fall into
 * "_blank" at the far right.
 *
 * Drag-drop patch logic:
 *   - Drop onto connection column  → { connectionStatus: col, enthusiasm: null }
 *   - Drop onto enthusiasm column  → { connectionStatus: "connected", enthusiasm: col }
 *   - Drop onto _connected_blank   → { connectionStatus: "connected", enthusiasm: null }
 *   - Drop onto _blank             → { connectionStatus: null, enthusiasm: null }
 */

export interface EntityKanbanRow {
  id: string;
  connectionStatus?: string | null;
  enthusiasm?: string | null;
}

export interface EntityKanbanPatch {
  connectionStatus?: string | null;
  enthusiasm?: string | null;
}

type KanbanCol = {
  id: string;
  label: string;
  kind: "connection" | "enthusiasm" | "connected-blank" | "blank";
};

const COLUMNS: KanbanCol[] = [
  { id: "no_connection",     label: "No connection",       kind: "connection" },
  { id: "have_a_connector",  label: "Have a connector",    kind: "connection" },
  { id: "7-advocate",        label: "7 · Advocate",        kind: "enthusiasm" },
  { id: "6-supportive",      label: "6 · Supportive",      kind: "enthusiasm" },
  { id: "5-warm",            label: "5 · Warm",            kind: "enthusiasm" },
  { id: "4-neutral",         label: "4 · Neutral",         kind: "enthusiasm" },
  { id: "3-cool",            label: "3 · Cool",            kind: "enthusiasm" },
  { id: "2-unsupportive",    label: "2 · Unsupportive",    kind: "enthusiasm" },
  { id: "1-hostile",         label: "1 · Hostile",         kind: "enthusiasm" },
  { id: "_connected_blank",  label: "Connected (unrated)", kind: "connected-blank" },
  { id: "_blank",            label: "No status",           kind: "blank" },
];

const COL_COLOR: Record<KanbanCol["kind"], string> = {
  connection:       "bg-slate-100 dark:bg-slate-800/40",
  enthusiasm:       "bg-muted/30",
  "connected-blank":"bg-blue-50 dark:bg-blue-950/30",
  blank:            "bg-muted/20",
};

function getColumnId(connectionStatus: string | null | undefined, enthusiasm: string | null | undefined): string {
  if (!connectionStatus) return "_blank";
  if (connectionStatus === "connected") return enthusiasm ?? "_connected_blank";
  return connectionStatus;
}

function columnToPatch(colId: string): EntityKanbanPatch {
  if (colId === "_blank")            return { connectionStatus: null, enthusiasm: null };
  if (colId === "_connected_blank")  return { connectionStatus: "connected", enthusiasm: null };
  if (colId === "no_connection" || colId === "have_a_connector") {
    return { connectionStatus: colId, enthusiasm: null };
  }
  return { connectionStatus: "connected", enthusiasm: colId };
}

export function EntityKanban<T extends EntityKanbanRow>({
  rows,
  isLoading,
  isError,
  error,
  truncated,
  onMove,
  renderCard,
}: {
  rows: T[];
  isLoading: boolean;
  isError?: boolean;
  error?: unknown;
  truncated?: boolean;
  onMove: (id: string, patch: EntityKanbanPatch) => void;
  renderCard: (row: T, opts: { hidden: boolean; isOverlay: boolean }) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const byColumn = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const col of COLUMNS) map.set(col.id, []);
    for (const r of rows) {
      const colId = getColumnId(r.connectionStatus, r.enthusiasm);
      const bucket = map.get(colId);
      if (bucket) bucket.push(r);
    }
    return map;
  }, [rows]);

  const activeRow = activeId ? rows.find((r) => r.id === activeId) ?? null : null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const rowId = String(e.active.id);
    const targetColId = e.over?.id ? String(e.over.id) : null;
    if (!targetColId || !COLUMNS.some((c) => c.id === targetColId)) return;
    const moved = rows.find((r) => r.id === rowId);
    if (!moved) return;
    const currentColId = getColumnId(moved.connectionStatus, moved.enthusiasm);
    if (currentColId === targetColId) return;
    onMove(rowId, columnToPatch(targetColId));
  }

  if (isError) {
    return (
      <div className="rounded-md border bg-card p-8 text-center text-destructive">
        {error instanceof Error ? error.message : "Failed to load records."}
      </div>
    );
  }

  return (
    <>
      {truncated && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
          Showing first {rows.length.toLocaleString()} records — add filters to narrow the view.
        </p>
      )}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-3">
          {COLUMNS.map((col) => (
            <EntityColumn
              key={col.id}
              col={col}
              rows={byColumn.get(col.id) ?? []}
              loading={isLoading}
              draggingId={activeId}
              renderCard={renderCard}
            />
          ))}
        </div>
        <DragOverlay>
          {activeRow ? renderCard(activeRow, { hidden: false, isOverlay: true }) : null}
        </DragOverlay>
      </DndContext>
    </>
  );
}

function EntityColumn<T extends EntityKanbanRow>({
  col,
  rows,
  loading,
  draggingId,
  renderCard,
}: {
  col: KanbanCol;
  rows: T[];
  loading: boolean;
  draggingId: string | null;
  renderCard: (row: T, opts: { hidden: boolean; isOverlay: boolean }) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });

  return (
    <div
      ref={setNodeRef}
      className={`flex w-[230px] shrink-0 flex-col rounded-md border transition-colors ${COL_COLOR[col.kind]} ${
        isOver ? "border-primary ring-1 ring-primary/30" : ""
      }`}
    >
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold text-foreground truncate">{col.label}</h2>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{rows.length}</span>
        </div>
      </div>
      <div className="flex-1 space-y-2 p-2 min-h-[100px]">
        {loading ? (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-6">—</div>
        ) : (
          rows.map((r) => (
            <Fragment key={r.id}>
              {renderCard(r, { hidden: draggingId === r.id, isOverlay: false })}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Drag-handle wrapper — wrap your card content in this so the dnd-kit
 * listeners are attached correctly. Pass the dragging state as `hidden`.
 */
export function DraggableCard({
  id,
  hidden,
  isOverlay,
  children,
}: {
  id: string;
  hidden: boolean;
  isOverlay: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: isOverlay,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-2.5 text-sm shadow-sm transition-shadow hover:shadow-md select-none ${
        hidden || isDragging ? "opacity-30" : ""
      } ${isOverlay ? "cursor-grabbing shadow-lg" : "cursor-grab"}`}
    >
      {children}
    </div>
  );
}
