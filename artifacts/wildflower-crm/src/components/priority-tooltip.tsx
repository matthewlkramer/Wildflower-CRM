import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const PRIORITY_TIERS: { label: string; desc: string }[] = [
  {
    label: "Top",
    desc: "One of the very most promising prospects for significant support in the next 1–2 years.",
  },
  {
    label: "High",
    desc: "A strong prospect for a moderate to high level of support over the next 1–4 years.",
  },
  {
    label: "Medium (default)",
    desc: "Could be strategic misalignment that might shift at some point, or limited capacity.",
  },
  {
    label: "Low",
    desc: "Significant and hard-to-change strategic misalignment, or a clear signal of disinterest from the donor.",
  },
];

/**
 * Info icon that explains what each priority tier means. Used next to the
 * priority column header in list views and the priority field in detail views.
 * The trigger stops click propagation so it can sit inside sortable table
 * headers without triggering a sort.
 */
export function PriorityTooltip({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Plain, non-focusable span: this can render inside a sortable <th>
            button, so it must not be a button or an independently focusable
            interactive descendant. It's purely informational and shows on
            hover/pointer. stopPropagation keeps a click from triggering the
            column sort. */}
        <span
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex shrink-0 cursor-help text-muted-foreground hover:text-foreground",
            className,
          )}
          aria-label="Priority tier definitions"
          data-testid="tooltip-priority"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1.5 p-3 text-left normal-case">
        {PRIORITY_TIERS.map((t) => (
          <div key={t.label} className="leading-snug">
            <span className="font-semibold">{t.label}</span>
            <span className="opacity-90"> — {t.desc}</span>
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
