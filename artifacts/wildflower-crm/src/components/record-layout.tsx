import { useState, useEffect, useRef, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronDown, Plus, PanelLeft, X, EyeOff, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSidebarCollapsed } from "@/components/sidebar-collapsed-context";
import { INLINE_EDIT_GROUP } from "@/components/inline-edit";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Shell: highlights bar on top, then responsive 3 → 2 → 1 lane grid   */
/* ------------------------------------------------------------------ */

export interface Highlight {
  label: ReactNode;
  value: ReactNode;
  accent?: boolean;
}

export function RecordLayout({
  backHref,
  backLabel,
  title,
  typeBadge,
  headerBadges,
  subtitle,
  actions,
  highlights,
  left,
  center,
  right,
}: {
  backHref: string;
  backLabel: string;
  title: ReactNode;
  typeBadge?: string;
  headerBadges?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  highlights: Highlight[];
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}) {
  // At laptop (md) widths only two lanes fit, so the details lane collapses
  // into a slide-over drawer toggled by a button. On mobile it stacks; on
  // xl it's a permanent sticky column.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // When the sidebar is collapsed to its rail, widen the cap so the record
  // uses the freed-up horizontal space instead of just recentering.
  const sidebarCollapsed = useSidebarCollapsed();
  return (
    <div
      className={cn(
        "mx-auto",
        sidebarCollapsed ? "max-w-[1600px]" : "max-w-[1400px]",
      )}
    >
      <Link
        href={backHref}
        className="mb-4 inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ChevronLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      {/* Highlights bar */}
      <div className="mb-6 rounded-xl border bg-card shadow-sm">
        <div
          className={cn(
            INLINE_EDIT_GROUP,
            "flex flex-wrap items-start justify-between gap-4 px-5 pt-5",
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-serif text-3xl font-bold leading-tight text-foreground">
                {title}
              </div>
              {typeBadge ? (
                <Badge variant="secondary" className="rounded-full">
                  {typeBadge}
                </Badge>
              ) : null}
              {headerBadges}
            </div>
            {subtitle ? (
              <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>

        {highlights.length > 0 ? (
          <div className="mt-4 grid grid-cols-2 divide-x divide-y border-t sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
            {highlights.map((h, i) => (
              <div key={i} className="px-5 py-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {h.label}
                </div>
                <div
                  className={cn(
                    "mt-0.5 text-sm font-semibold",
                    h.accent && "text-primary",
                  )}
                >
                  {h.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Laptop-only "Details" toggle — opens the left lane as a drawer. */}
      <div className="mb-4 hidden md:flex xl:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDetailsOpen(true)}
          data-testid="button-open-details-drawer"
        >
          <PanelLeft className="mr-1.5 h-4 w-4" />
          Details
        </Button>
      </div>

      {/* 3-lane layout: details / activity / related.
          - mobile (default): single stacked column, activity feed first.
          - laptop (md): two lanes (activity + related); details is a drawer.
          - desktop (xl): three lanes that all grow to their natural height and
            scroll together with the page (no per-lane internal scrolling). */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(300px,360px)]">
        {/* LEFT — record details. Hidden at md (shown via drawer instead). */}
        <div className="order-2 space-y-4 md:hidden xl:order-1 xl:block xl:self-start">
          {left}
        </div>
        {/* CENTER — unified activity feed (widest, primary focus). */}
        <div className="order-1 space-y-4 xl:order-2">{center}</div>
        {/* RIGHT — related records. */}
        <div className="order-3 space-y-4 xl:order-3 xl:self-start">
          {right}
        </div>
      </div>

      {/* Details drawer (laptop widths only). */}
      {detailsOpen ? (
        <div className="fixed inset-0 z-50 xl:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDetailsOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[360px] max-w-[85vw] overflow-y-auto bg-background p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="font-serif text-lg font-semibold">Details</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setDetailsOpen(false)}
                aria-label="Close details"
                data-testid="button-close-details-drawer"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4">{left}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LEFT lane: collapsible field cards                                   */
/* ------------------------------------------------------------------ */

export function FieldCard({
  title,
  defaultOpen = true,
  empty,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /**
   * When true the card holds no actual data (placeholder "—" rows don't
   * count) and starts collapsed on first render. An explicit
   * `defaultOpen={false}` still wins. Default-on-first-render only — there's
   * no persistence, so the user can always click to expand.
   */
  empty?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen && !empty);
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex w-full items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2"
        >
          <span className="font-serif text-base font-semibold">{title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label="Toggle section"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
          </button>
        </div>
      </div>
      {open ? (
        <div className="border-t px-4 py-3 text-sm">{children}</div>
      ) : null}
    </div>
  );
}

export function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RIGHT lane: collapsible related-record cards with count badges      */
/* ------------------------------------------------------------------ */

export function RelatedCard({
  title,
  count,
  empty,
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  count?: number;
  /**
   * Explicit emptiness override. When omitted, emptiness is derived from
   * `count` (a numeric 0 = empty). Pass this for cards that show content
   * beyond the counted list (e.g. "Gives through" suggestions) or that hide
   * the count badge when empty. An explicit `defaultOpen={false}` still wins.
   */
  empty?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  // Resolve emptiness: an explicit `empty` wins; otherwise derive from
  // `count` where a numeric 0 means empty. `undefined` means "not yet known"
  // (async cards pass `count={isLoading ? undefined : total}`).
  const resolvedEmpty = empty ?? (count != null ? count === 0 : undefined);
  const [open, setOpen] = useState(() =>
    resolvedEmpty === undefined ? defaultOpen : defaultOpen && !resolvedEmpty,
  );
  // For async cards emptiness is unknown on first render; once it resolves we
  // collapse it exactly once if it turned out empty. We only ever collapse
  // (never re-open) so a user who toggled the card during loading keeps their
  // choice when the data finally lands.
  const settledRef = useRef(resolvedEmpty !== undefined);
  useEffect(() => {
    if (settledRef.current || resolvedEmpty === undefined) return;
    settledRef.current = true;
    if (resolvedEmpty) setOpen(false);
  }, [resolvedEmpty]);
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex w-full items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span className="font-serif text-base font-semibold">{title}</span>
          {count != null ? (
            <span className="inline-flex min-w-5 justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label="Toggle section"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
          </button>
        </div>
      </div>
      {open ? <div className="border-t px-2 py-2">{children}</div> : null}
    </div>
  );
}

/* "+ New" style action used in card headers. */
export function CardAction({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted"
    >
      <Plus className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/* Header toggle that hides/shows inactive (past) rows in a related card. */
export function HideInactiveToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
    >
      {hidden ? (
        <Eye className="h-3.5 w-3.5" />
      ) : (
        <EyeOff className="h-3.5 w-3.5" />
      )}
      {hidden ? "Show inactive" : "Hide inactive"}
    </button>
  );
}

/* Compact related-record row that links out to the record. */
export function RelatedRow({
  name,
  href,
  sub,
  amount,
  tone,
  badge,
}: {
  name: ReactNode;
  href?: string;
  sub?: ReactNode;
  amount?: ReactNode;
  tone?: "primary";
  /** Optional icon/badge rendered inline after the name+sub block, before the amount. */
  badge?: ReactNode;
}) {
  const body = (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm font-medium",
            tone === "primary" && "text-primary",
          )}
        >
          {name}
        </div>
        {sub ? (
          <div className="truncate text-xs text-muted-foreground">{sub}</div>
        ) : null}
      </div>
      {badge != null ? (
        <div className="shrink-0">{badge}</div>
      ) : null}
      {amount != null ? (
        <div className="shrink-0 text-sm font-semibold tabular-nums">
          {amount}
        </div>
      ) : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/* Clickable affiliation row (person or organization) with active/past status. */
export function AffiliationRow({
  name,
  href,
  role,
  status,
  primary,
  hideStatusBadge,
  action,
}: {
  name: ReactNode;
  href?: string;
  role?: ReactNode;
  status?: "active" | "past";
  primary?: boolean;
  hideStatusBadge?: boolean;
  /** Optional trailing control (e.g. an edit button) rendered after badges. */
  action?: ReactNode;
}) {
  const past = status === "past";
  const nameNode = href ? (
    <Link
      href={href}
      className="block truncate text-sm font-medium text-primary hover:underline"
    >
      {name}
    </Link>
  ) : (
    <span className="block truncate text-sm font-medium text-primary">
      {name}
    </span>
  );
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60",
        past && "opacity-70",
      )}
    >
      <div className="min-w-0">
        {nameNode}
        {role ? (
          <div className="truncate text-xs text-muted-foreground">{role}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {primary ? (
          <Badge variant="outline" className="text-[10px]">
            Primary
          </Badge>
        ) : null}
        {status && !hideStatusBadge ? (
          past ? (
            <Badge variant="outline" className="text-[10px]">
              Past
            </Badge>
          ) : (
            <Badge variant="default" className="text-[10px]">
              Active
            </Badge>
          )
        ) : null}
        {action}
      </div>
    </div>
  );
}
