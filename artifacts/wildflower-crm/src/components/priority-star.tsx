import { Star } from "lucide-react";
import type { Priority } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

type Props = {
  priority: Priority | null | undefined;
  /** Visual size — `sm` for inline next to a name, `md` for table cells. */
  size?: "sm" | "md";
  className?: string;
};

/**
 * Renders a filled star when `priority === 'top'`, nothing otherwise.
 * Read-only — clicking is not supported; edit the priority tier from
 * the funder/person detail page or via bulk-edit instead.
 */
export function PriorityStar({ priority, size = "md", className }: Props) {
  if (priority !== "top") return null;
  const dimensions = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <span
      aria-label="Top priority"
      title="Top priority"
      className="inline-flex shrink-0 align-middle"
    >
      <Star
        className={cn(dimensions, "fill-amber-400 text-amber-500", className)}
      />
    </span>
  );
}
