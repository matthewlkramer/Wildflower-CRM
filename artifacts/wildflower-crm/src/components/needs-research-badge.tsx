import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Passive, read-only "Needs research" badge. Rendered on gift, opportunity/
 * pledge, organization and person DETAIL pages when the record has an OPEN
 * Cleanup Queue item with reason_code='needs_research' (the server derives
 * `flaggedForResearch`). It is never editable here — the Cleanup Queue is the
 * single source of truth; use the "Flag for research" action to set it and the
 * Cleanup Queue to resolve it.
 *
 * Renders nothing unless `flagged` is true.
 */
export function NeedsResearchBadge({ flagged }: { flagged?: boolean | null }) {
  if (!flagged) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1 rounded-full border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      data-testid="badge-needs-research"
    >
      <Search className="h-3 w-3" />
      Needs research
    </Badge>
  );
}
