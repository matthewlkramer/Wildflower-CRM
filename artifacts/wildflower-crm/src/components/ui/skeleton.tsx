import { cn } from "@/lib/utils"
import { TableCell, TableRow } from "@/components/ui/table"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      {...props}
    />
  )
}

/**
 * Placeholder table rows shown while a list-page fetch is in flight. Renders
 * `rows` table rows, each with `cols` cells holding a shimmering bar, so the
 * table looks populated instantly instead of flashing a "Loading…" word.
 */
function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((_, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export { Skeleton, SkeletonRows }
