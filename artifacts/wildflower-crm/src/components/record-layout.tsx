import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronDown, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Shell: highlights bar on top, then responsive 3 → 2 → 1 lane grid   */
/* ------------------------------------------------------------------ */

export interface Highlight {
  label: string;
  value: ReactNode;
  accent?: boolean;
}

export function RecordLayout({
  backHref,
  backLabel,
  title,
  typeBadge,
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
  subtitle?: ReactNode;
  actions?: ReactNode;
  highlights: Highlight[];
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1400px]">
      <Link
        href={backHref}
        className="mb-4 inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ChevronLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      {/* Highlights bar */}
      <div className="mb-6 rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-serif text-3xl font-bold leading-tight text-foreground">
                {title}
              </div>
              {typeBadge ? (
                <Badge variant="secondary" className="rounded-full">
                  {typeBadge}
                </Badge>
              ) : null}
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
          <div className="mt-4 grid grid-cols-2 divide-x divide-y border-t sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
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

      {/* 3-lane layout: details / activity / related.
          Responsive: 3 cols (xl) → 2 cols (md, related drops under) → 1 col (mobile). */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(300px,360px)]">
        {/* LEFT — record details */}
        <div className="order-2 space-y-4 md:order-1 xl:order-1">{left}</div>
        {/* CENTER — unified activity feed (widest, primary focus) */}
        <div className="order-1 space-y-4 md:order-3 md:col-span-2 xl:order-2 xl:col-span-1">
          {center}
        </div>
        {/* RIGHT — related records */}
        <div className="order-3 space-y-4 md:order-2 xl:order-3">{right}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LEFT lane: collapsible field cards                                   */
/* ------------------------------------------------------------------ */

export function FieldCard({
  title,
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex w-full items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2"
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

/* Compact related-record row that links out to the record. */
export function RelatedRow({
  name,
  href,
  sub,
  amount,
  tone,
}: {
  name: ReactNode;
  href?: string;
  sub?: ReactNode;
  amount?: ReactNode;
  tone?: "primary";
}) {
  const body = (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
      <div className="min-w-0">
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
}: {
  name: ReactNode;
  href?: string;
  role?: ReactNode;
  status?: "active" | "past";
  primary?: boolean;
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
        {status ? (
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
      </div>
    </div>
  );
}
