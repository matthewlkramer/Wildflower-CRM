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

/**
 * Card-shaped placeholder shown while a detail-page section fetches. Mimics a
 * card with a title bar and `lines` body rows so a section reads as "loading
 * content" instead of flashing a "Loading…" word.
 */
function SkeletonCard({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-4 space-y-3", className)}>
      <Skeleton className="h-5 w-1/3" />
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  )
}

/**
 * Full detail-page placeholder: a back-link bar, a title/subtitle block, and a
 * grid of card skeletons. Rendered in place of the top-level "Loading…" return
 * on detail pages (person, gift, organization, opportunity, …) so the page
 * keeps its shape while the record fetches.
 */
function DetailSkeleton() {
  return (
    <div className="space-y-4" data-testid="detail-skeleton">
      <Skeleton className="h-4 w-32" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
      </div>
    </div>
  )
}

export { Skeleton, SkeletonRows, SkeletonCard, DetailSkeleton }
