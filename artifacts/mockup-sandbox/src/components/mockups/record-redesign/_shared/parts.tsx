import { useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronDown,
  Pencil,
  Plus,
  MessageSquare,
  Phone,
  Users,
  Mail,
  Calendar,
  Sparkles,
  Paperclip,
  ExternalLink,
  Lock,
  StickyNote,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Shell: highlights bar on top, then responsive 3 → 2 → 1 lane grid  */
/* ------------------------------------------------------------------ */

export interface Highlight {
  label: string;
  value: ReactNode;
  accent?: boolean;
}

export function RecordShell({
  backLabel,
  title,
  typeBadge,
  subtitle,
  highlights,
  left,
  center,
  right,
}: {
  backLabel: string;
  title: string;
  typeBadge: string;
  subtitle?: ReactNode;
  highlights: Highlight[];
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="rr-root">
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        {/* Back link */}
        <button className="rr-text-primary mb-4 inline-flex items-center gap-1 text-sm hover:underline">
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </button>

        {/* Highlights bar */}
        <div className="rr-bg-card rr-border mb-6 rounded-xl border shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-serif text-3xl font-bold leading-tight">
                  {title}
                </h1>
                <span className="rr-bg-secondary rr-text-muted inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium">
                  {typeBadge}
                </span>
              </div>
              {subtitle ? (
                <div className="rr-text-muted mt-1 text-sm">{subtitle}</div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button className="rr-border inline-flex items-center gap-1.5 rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-transparent px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50">
                Delete
              </button>
            </div>
          </div>

          {/* Highlight stat strip */}
          <div className="rr-border mt-4 grid grid-cols-2 divide-x divide-y border-t sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
            {highlights.map((h, i) => (
              <div key={i} className="rr-border px-5 py-3">
                <div className="rr-text-muted text-[11px] font-medium uppercase tracking-wide">
                  {h.label}
                </div>
                <div
                  className={
                    "mt-0.5 text-sm font-semibold " +
                    (h.accent ? "rr-text-primary" : "")
                  }
                >
                  {h.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 3-lane layout: details / activity / related.
            Responsive: 3 cols (xl) → 2 cols (md, related drops under) → 1 col (mobile). */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(300px,360px)]">
          {/* LEFT — record details */}
          <div className="order-2 space-y-4 md:order-1 xl:order-1">{left}</div>
          {/* CENTER — unified activity feed (widest, primary focus) */}
          <div className="order-1 md:order-3 md:col-span-2 xl:order-2 xl:col-span-1">
            {center}
          </div>
          {/* RIGHT — related records */}
          <div className="order-3 space-y-4 md:order-2 xl:order-3">{right}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LEFT lane: collapsible field cards                                  */
/* ------------------------------------------------------------------ */

export function FieldCard({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rr-bg-card rr-border rounded-xl border shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3"
      >
        <span className="font-serif text-base font-semibold">{title}</span>
        <ChevronDown
          className={
            "rr-text-muted h-4 w-4 transition-transform " +
            (open ? "" : "-rotate-90")
          }
        />
      </button>
      {open ? (
        <div className="rr-border space-y-2 border-t px-4 py-3 text-sm">
          {children}
        </div>
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
    <div className="group flex items-baseline justify-between gap-3">
      <span className="rr-text-muted shrink-0 text-xs font-medium">{label}</span>
      <span className="flex items-center gap-1.5 text-right">
        {children}
        <Pencil className="rr-text-muted h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
      </span>
    </div>
  );
}

export function Badge({
  children,
  tone = "secondary",
}: {
  children: ReactNode;
  tone?: "secondary" | "primary" | "outline";
}) {
  const cls =
    tone === "primary"
      ? "rr-bg-primary rr-text-pfg"
      : tone === "outline"
        ? "rr-border border bg-transparent"
        : "rr-bg-secondary rr-text-muted";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
        cls
      }
    >
      {children}
    </span>
  );
}

export function TagRow({ label, tags }: { label: string; tags: string[] }) {
  return (
    <div>
      <div className="rr-text-muted mb-1 text-xs font-medium">{label}</div>
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CENTER lane: activity feed with pinned composer + filter chips      */
/* ------------------------------------------------------------------ */

const COMPOSER_ACTIONS = [
  { icon: StickyNote, label: "Note" },
  { icon: Phone, label: "Call" },
  { icon: Users, label: "Meeting" },
  { icon: Mail, label: "Email" },
];

export function ActivityComposer() {
  return (
    <div className="rr-border rr-bg-background rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <div className="rr-bg-primary rr-text-pfg flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
          KD
        </div>
        <div className="flex-1">
          <div className="rr-border rr-bg-card rounded-md border px-3 py-2 text-sm rr-text-muted">
            Add a note or log an activity…
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {COMPOSER_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  className="rr-border inline-flex items-center gap-1 rounded-md border bg-transparent px-2 py-1 text-xs font-medium hover:bg-black/[0.03]"
                >
                  <a.icon className="h-3.5 w-3.5" /> {a.label}
                </button>
              ))}
            </div>
            <button className="rr-bg-primary rr-text-pfg inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold">
              <Plus className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FilterChips({
  chips,
  active = "All",
}: {
  chips: { label: string; count: number }[];
  active?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => {
        const isActive = c.label === active;
        return (
          <button
            key={c.label}
            className={
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors " +
              (isActive
                ? "rr-bg-primary rr-text-pfg border-transparent"
                : "rr-border rr-bg-background rr-text-muted")
            }
          >
            <span>{c.label}</span>
            <span
              className={
                "rounded-full px-1.5 text-[10px] tabular-nums " +
                (isActive ? "bg-white/20" : "rr-bg-muted")
              }
            >
              {c.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ActivityCard({
  highlights,
  children,
}: {
  highlights: Highlight[];
  children: ReactNode;
}) {
  return (
    <div className="rr-bg-card rr-border rounded-xl border shadow-sm">
      <div className="rr-border flex items-center justify-between border-b px-4 py-3">
        <span className="font-serif text-lg font-semibold">Activity</span>
        <span className="rr-text-muted text-xs">All times in your timezone</span>
      </div>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </div>
  );
}

type FeedKind = "note" | "call" | "meeting" | "email" | "calendar" | "intel";

const KIND_META: Record<
  FeedKind,
  { icon: typeof MessageSquare; label: string; badge: ReactNode }
> = {
  note: { icon: MessageSquare, label: "Note", badge: <Badge>Note</Badge> },
  call: { icon: Phone, label: "Phone call", badge: <Badge>Phone call</Badge> },
  meeting: { icon: Users, label: "Meeting", badge: <Badge>Meeting</Badge> },
  email: { icon: Mail, label: "Email", badge: <Badge tone="outline">Email · inbound</Badge> },
  calendar: { icon: Calendar, label: "Calendar", badge: <Badge tone="outline">Calendar</Badge> },
  intel: { icon: Sparkles, label: "Intel", badge: <Badge tone="outline">Grant opportunity</Badge> },
};

export function FeedItem({
  kind,
  when,
  title,
  meta,
  body,
  privateFlag,
  attachment,
}: {
  kind: FeedKind;
  when: string;
  title: string;
  meta?: string;
  body?: string;
  privateFlag?: boolean;
  attachment?: boolean;
}) {
  const m = KIND_META[kind];
  const Icon = m.icon;
  const intel = kind === "intel";
  return (
    <div
      className={
        "rr-border space-y-1 rounded-md border p-3 text-sm " +
        (intel ? "bg-amber-50/60" : "")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          className={"h-4 w-4 " + (intel ? "text-amber-600" : "rr-text-muted")}
        />
        {m.badge}
        {privateFlag ? (
          <Badge>
            <Lock className="mr-1 h-3 w-3" /> Private
          </Badge>
        ) : null}
        {attachment ? (
          <Paperclip className="rr-text-muted h-3 w-3" />
        ) : null}
        <span className="rr-text-muted text-xs">{when}</span>
        {kind === "calendar" || intel ? (
          <span className="rr-text-primary ml-auto inline-flex items-center gap-1 text-xs">
            {intel ? "Review" : "Open"} <ExternalLink className="h-3 w-3" />
          </span>
        ) : null}
      </div>
      <div className="font-medium">{title}</div>
      {meta ? <div className="rr-text-muted text-xs">{meta}</div> : null}
      {body ? <p className="rr-text-muted whitespace-pre-wrap">{body}</p> : null}
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
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rr-bg-card rr-border rounded-xl border shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3"
      >
        <span className="flex items-center gap-2">
          <span className="font-serif text-base font-semibold">{title}</span>
          <span className="rr-bg-muted rr-text-muted inline-flex min-w-5 justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
            {count}
          </span>
        </span>
        <ChevronDown
          className={
            "rr-text-muted h-4 w-4 transition-transform " +
            (open ? "" : "-rotate-90")
          }
        />
      </button>
      {open ? (
        <div className="rr-border border-t px-2 py-2">{children}</div>
      ) : null}
    </div>
  );
}

export function RelatedRow({
  name,
  sub,
  amount,
  tone,
}: {
  name: string;
  sub?: string;
  amount?: string;
  tone?: "primary";
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-black/[0.03]">
      <div className="min-w-0">
        <div
          className={
            "truncate text-sm font-medium " + (tone === "primary" ? "rr-text-primary" : "")
          }
        >
          {name}
        </div>
        {sub ? <div className="rr-text-muted truncate text-xs">{sub}</div> : null}
      </div>
      {amount ? (
        <div className="shrink-0 text-sm font-semibold tabular-nums">{amount}</div>
      ) : null}
    </div>
  );
}
