import type { ComponentType } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface ContactIconItem {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Human-readable value shown in the hover tooltip. */
  value: string;
  href?: string;
}

/**
 * Row of circular quick-access icons (website, email, socials) with a
 * hover tooltip showing the label + value. Display/navigation only —
 * the underlying fields stay editable in their existing cards.
 * Falsy items are skipped so callers can inline `field && {...}` guards.
 */
export function ContactIconRow({
  items,
  testIdBase,
}: {
  items: Array<ContactIconItem | null | undefined | false | "">;
  testIdBase: string;
}) {
  const visible = items.filter((i): i is ContactIconItem => Boolean(i));
  if (visible.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`${testIdBase}-contact-icons`}
    >
      {visible.map((c) => {
        const Icon = c.icon;
        const className =
          "flex h-9 w-9 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
        const isExternal = Boolean(c.href && /^https?:/i.test(c.href));
        return (
          <Tooltip key={c.label}>
            <TooltipTrigger asChild>
              {c.href ? (
                <a
                  href={c.href}
                  target={isExternal ? "_blank" : undefined}
                  rel={isExternal ? "noreferrer" : undefined}
                  className={className}
                  aria-label={c.label}
                  data-testid={`${testIdBase}-contact-${c.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <Icon className="h-4 w-4" />
                </a>
              ) : (
                <span
                  className={className}
                  aria-label={c.label}
                  data-testid={`${testIdBase}-contact-${c.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <Icon className="h-4 w-4" />
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-[10px] font-medium uppercase tracking-wider opacity-70">
                {c.label}
              </div>
              <div className="max-w-64 break-all text-sm font-semibold">
                {c.value}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
