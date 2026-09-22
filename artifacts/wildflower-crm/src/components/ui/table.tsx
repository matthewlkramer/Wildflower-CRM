import * as React from "react"

import { cn } from "@/lib/utils"

const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 1600;
const MIN_TABLE_WIDTH = 320;
const MAX_TABLE_WIDTH = 6000;
const KEYBOARD_RESIZE_STEP = 24;

type HorizontalResizeOptions<T extends HTMLElement> = {
  elementRef: React.RefObject<T | null>;
  min: number;
  max: number;
  onResize: (width: number) => void;
};

function clampWidth(width: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(width)));
}

function useHorizontalResize<T extends HTMLElement>({
  elementRef,
  min,
  max,
  onResize,
}: HorizontalResizeOptions<T>) {
  const cleanupRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) return;

      event.preventDefault();
      event.stopPropagation();
      cleanupRef.current?.();

      const startX = event.clientX;
      const startWidth =
        elementRef.current?.getBoundingClientRect().width ?? min;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Synthetic events and older browsers may not support pointer capture.
      }

      let active = true;
      const cleanup = () => {
        if (!active) return;
        active = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        cleanupRef.current = null;
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // Safe when capture was unavailable or already released.
        }
      };
      const onMove = (moveEvent: PointerEvent) => {
        onResize(clampWidth(startWidth + moveEvent.clientX - startX, min, max));
      };

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [elementRef, max, min, onResize],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const currentWidth =
        elementRef.current?.getBoundingClientRect().width ?? min;
      const delta =
        event.key === "ArrowLeft"
          ? -KEYBOARD_RESIZE_STEP
          : KEYBOARD_RESIZE_STEP;
      onResize(clampWidth(currentWidth + delta, min, max));
    },
    [elementRef, max, min, onResize],
  );

  return { onPointerDown, onKeyDown };
}

type TableProps = React.HTMLAttributes<HTMLTableElement> & {
  containerClassName?: string;
  resizable?: boolean;
  minResizeWidth?: number;
  maxResizeWidth?: number;
};

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  (
    {
      className,
      containerClassName,
      resizable = true,
      minResizeWidth = MIN_TABLE_WIDTH,
      maxResizeWidth = MAX_TABLE_WIDTH,
      ...props
    },
    ref,
  ) => {
    const frameRef = React.useRef<HTMLDivElement>(null);
    const [resizedWidth, setResizedWidth] = React.useState<
      number | undefined
    >();
    const resize = useHorizontalResize({
      elementRef: frameRef,
      min: minResizeWidth,
      max: maxResizeWidth,
      onResize: setResizedWidth,
    });

    return (
      <div className={cn("relative w-full overflow-auto", containerClassName)}>
        <div
          ref={frameRef}
          className="relative w-full"
          style={
            resizedWidth === undefined
              ? undefined
              : { width: resizedWidth, minWidth: resizedWidth }
          }
          data-table-resize-frame
        >
          <table
            ref={ref}
            className={cn("w-full caption-bottom text-sm", className)}
            {...props}
          />
          {resizable ? (
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize table width"
              aria-valuemin={minResizeWidth}
              aria-valuemax={maxResizeWidth}
              aria-valuenow={resizedWidth}
              tabIndex={0}
              title="Drag to resize the table; double-click to reset"
              className="absolute bottom-0 right-0 z-20 h-4 w-4 cursor-col-resize rounded-tl border-l border-t border-primary/30 bg-background/90 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={resize.onPointerDown}
              onKeyDown={resize.onKeyDown}
              onDoubleClick={() => setResizedWidth(undefined)}
              data-testid="resize-table-width"
            />
          ) : null}
        </div>
      </div>
    );
  },
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
      className
    )}
    {...props}
  />
))
TableFooter.displayName = "TableFooter"

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      className
    )}
    {...props}
  />
))
TableRow.displayName = "TableRow"

type TableHeadProps = React.ThHTMLAttributes<HTMLTableCellElement> & {
  resizable?: boolean;
  minResizeWidth?: number;
  maxResizeWidth?: number;
  resizeLabel?: string;
};

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  (
    {
      className,
      children,
      style,
      colSpan,
      resizable = true,
      minResizeWidth = MIN_COLUMN_WIDTH,
      maxResizeWidth = MAX_COLUMN_WIDTH,
      resizeLabel,
      ...props
    },
    forwardedRef,
  ) => {
    const headRef = React.useRef<HTMLTableCellElement>(null);
    const [resizedWidth, setResizedWidth] = React.useState<
      number | undefined
    >();
    const resize = useHorizontalResize({
      elementRef: headRef,
      min: minResizeWidth,
      max: maxResizeWidth,
      onResize: setResizedWidth,
    });
    const canResize = resizable && (colSpan === undefined || colSpan === 1);
    const resolvedResizeLabel =
      resizeLabel ??
      (typeof children === "string" || typeof children === "number"
        ? `Resize ${children} column`
        : "Resize column");

    const setRefs = React.useCallback(
      (node: HTMLTableCellElement | null) => {
        headRef.current = node;
        if (typeof forwardedRef === "function") {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef],
    );

    return (
      <th
        ref={setRefs}
        className={cn(
          "relative h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
          className,
        )}
        style={
          resizedWidth === undefined
            ? style
            : {
                ...style,
                width: resizedWidth,
                minWidth: resizedWidth,
                maxWidth: resizedWidth,
              }
        }
        colSpan={colSpan}
        {...props}
      >
        {children}
        {canResize ? (
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={resolvedResizeLabel}
            aria-valuemin={minResizeWidth}
            aria-valuemax={maxResizeWidth}
            aria-valuenow={resizedWidth}
            tabIndex={0}
            title="Drag to resize this column; double-click to reset"
            className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/50 focus-visible:bg-primary/30 focus-visible:outline-none"
            onPointerDown={resize.onPointerDown}
            onKeyDown={resize.onKeyDown}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={() => setResizedWidth(undefined)}
          />
        ) : null}
      </th>
    );
  },
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props}
  />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props}
  />
))
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
