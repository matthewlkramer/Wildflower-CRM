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
  MapPin,
  Globe,
  Linkedin,
  Activity,
  Heart,
  Signal
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
        <button className="rr-text-primary mb-4 inline-flex items-center gap-1 text-sm hover:underline">
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </button>

        <div className="rr-bg-card rr-border mb-6 rounded-xl border shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 pb-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-serif text-3xl font-bold leading-tight">
                  {title}
                </h1>
                <span className="rr-bg-secondary rr-text-muted inline-flex rounded-md px-2 py-1 text-xs font-medium uppercase tracking-wider">
                  {typeBadge}
                </span>
              </div>
              {subtitle ? (
                <div className="rr-text-muted mt-1.5 flex items-center gap-2 text-sm">
                  {subtitle}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button className="rr-border inline-flex items-center gap-1.5 rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            </div>
          </div>

          <div className="rr-border grid grid-cols-2 divide-x divide-y border-t sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
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

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(300px,360px)]">
          <div className="order-2 space-y-4 md:order-1 xl:order-1">{left}</div>
          <div className="order-1 md:order-3 md:col-span-2 xl:order-2 xl:col-span-1">
            {center}
          </div>
          <div className="order-3 space-y-4 md:order-2 xl:order-3">{right}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LEFT lane: collapsible field cards & contact icons                  */
/* ------------------------------------------------------------------ */

export function FieldCard({
  title,
  children,
  defaultOpen = true,
  className = "",
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rr-bg-card rr-border rounded-xl border shadow-sm ${className}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 hover:bg-black/[0.01] transition-colors rounded-t-xl"
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
        <div className="rr-border space-y-4 border-t px-4 py-3.5 text-sm">
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
      <span className="flex items-center gap-1.5 text-right font-medium">
        {children}
        <Pencil className="rr-text-muted h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60 cursor-pointer" />
      </span>
    </div>
  );
}

export function Badge({
  children,
  tone = "secondary",
  icon: Icon,
}: {
  children: ReactNode;
  tone?: "secondary" | "primary" | "outline" | "success" | "warning";
  icon?: any;
}) {
  let cls = "rr-bg-secondary rr-text-muted";
  if (tone === "primary") cls = "rr-bg-primary rr-text-pfg";
  if (tone === "outline") cls = "rr-border border bg-transparent text-slate-700";
  if (tone === "success") cls = "bg-green-100 text-green-800";
  if (tone === "warning") cls = "bg-amber-100 text-amber-800";

  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium " +
        cls
      }
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function AttributeBadges({ attributes }: { attributes: { label: string; value: string; icon?: any; tone?: any }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {attributes.map((attr, i) => (
        <div key={i} className="group relative cursor-default">
          <Badge tone={attr.tone} icon={attr.icon}>{attr.value}</Badge>
          <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 z-10">
            <span className="text-slate-300 font-medium">{attr.label}:</span> <span className="font-semibold">{attr.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TagRow({ label, tags }: { label: string; tags: string[] }) {
  return (
    <div>
      <div className="rr-text-muted mb-1.5 text-xs font-medium">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <Badge key={t} tone="outline">{t}</Badge>
        ))}
      </div>
    </div>
  );
}

export function ContactIconRow({
  contacts,
  demoOpenIndex = -1
}: {
  contacts: { icon: any; label: string; value: string; href?: string }[];
  demoOpenIndex?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {contacts.map((c, i) => {
          const Icon = c.icon;
          const isDemoOpen = i === demoOpenIndex;
          return (
            <div key={i} className="group relative">
              <a
                href={c.href}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 transition-all"
              >
                <Icon className="h-4 w-4" />
              </a>
              <div className={`pointer-events-none absolute -top-12 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-white border border-slate-200 px-3 py-1.5 shadow-md transition-opacity z-10 ${isDemoOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-0.5">{c.label}</div>
                <div className="text-sm font-semibold text-slate-900">{c.value}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[10px] font-medium text-slate-400 italic">Hover icons for details</div>
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
    <div className="rr-border rr-bg-card rounded-xl border shadow-sm p-4">
      <div className="flex items-start gap-3">
        <div className="rr-bg-primary rr-text-pfg flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
          KD
        </div>
        <div className="flex-1">
          <div className="rr-border rr-bg-accent rounded-lg border px-3 py-2.5 text-sm rr-text-muted hover:bg-white transition-colors cursor-text">
            Add a note or log an activity…
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {COMPOSER_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  className="rr-border inline-flex items-center gap-1.5 rounded-md border bg-transparent px-2.5 py-1.5 text-xs font-medium hover:bg-black/[0.03]"
                >
                  <a.icon className="h-3.5 w-3.5 text-slate-500" /> {a.label}
                </button>
              ))}
            </div>
            <button className="rr-bg-primary rr-text-pfg inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold hover:opacity-90">
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
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (isActive
                ? "rr-bg-primary rr-text-pfg border-transparent"
                : "rr-border rr-bg-card rr-text-muted hover:bg-slate-50")
            }
          >
            <span>{c.label}</span>
            <span
              className={
                "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums leading-none " +
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
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="rr-bg-card rr-border rounded-xl border shadow-sm">
      <div className="rr-border flex items-center justify-between border-b px-5 py-3.5">
        <span className="font-serif text-lg font-semibold">Activity</span>
        <span className="rr-text-muted text-xs font-medium">All times in your timezone</span>
      </div>
      <div className="space-y-4 px-5 py-5">{children}</div>
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
        "rr-border space-y-2 rounded-lg border p-4 text-sm transition-colors hover:bg-slate-50/50 " +
        (intel ? "bg-amber-50/40 hover:bg-amber-50/80 border-amber-100" : "")
      }
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <div className={`flex h-6 w-6 items-center justify-center rounded-full ${intel ? 'bg-amber-100' : 'bg-slate-100'}`}>
          <Icon className={"h-3.5 w-3.5 " + (intel ? "text-amber-600" : "rr-text-muted")} />
        </div>
        {m.badge}
        {privateFlag ? (
          <Badge>
            <Lock className="mr-1 h-3 w-3" /> Private
          </Badge>
        ) : null}
        {attachment ? (
          <Paperclip className="rr-text-muted h-3.5 w-3.5" />
        ) : null}
        <span className="rr-text-muted text-xs font-medium ml-1">{when}</span>
        {kind === "calendar" || intel ? (
          <span className="rr-text-primary ml-auto inline-flex items-center gap-1 text-xs font-medium hover:underline cursor-pointer">
            {intel ? "Review" : "Open"} <ExternalLink className="h-3 w-3" />
          </span>
        ) : null}
      </div>
      <div className="font-semibold text-base mt-1">{title}</div>
      {meta ? <div className="rr-text-muted text-xs font-medium">{meta}</div> : null}
      {body ? <p className="rr-text-muted whitespace-pre-wrap leading-relaxed">{body}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RIGHT lane: collapsible related-record cards & Giving module        */
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
    <div className="rr-bg-card rr-border rounded-xl border shadow-sm">
      <div className="flex w-full items-center justify-between px-4 py-3.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2"
        >
          <span className="font-serif text-base font-semibold">{title}</span>
          {count !== undefined && (
             <span className="rr-bg-accent rr-border border rr-text-muted inline-flex min-w-[22px] justify-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
               {count}
             </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {action}
          <button onClick={() => setOpen((o) => !o)} aria-label="Toggle section" className="p-1 hover:bg-slate-100 rounded">
            <ChevronDown
              className={
                "rr-text-muted h-4 w-4 transition-transform " +
                (open ? "" : "-rotate-90")
              }
            />
          </button>
        </div>
      </div>
      {open ? (
        <div className="rr-border border-t px-2.5 py-2.5 space-y-0.5">{children}</div>
      ) : null}
    </div>
  );
}

export function CardAction({ label }: { label: string }) {
  return (
    <button className="rr-text-primary inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold hover:bg-slate-100 transition-colors border border-transparent hover:border-slate-200">
      <Plus className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function AffiliationRow({
  name,
  role,
  status,
  primary,
}: {
  name: string;
  role?: string;
  status: "active" | "past";
  primary?: boolean;
}) {
  const past = status === "past";
  return (
    <div
      className={
        "flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 hover:bg-slate-50 transition-colors " +
        (past ? "opacity-70" : "")
      }
    >
      <div className="min-w-0">
        <a className="rr-text-primary block cursor-pointer truncate text-sm font-semibold hover:underline">
          {name}
        </a>
        {role ? <div className="rr-text-muted truncate text-xs mt-0.5">{role}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {primary ? <Badge tone="outline">Primary</Badge> : null}
        {past ? (
          <Badge tone="secondary">Past</Badge>
        ) : (
          <Badge tone="success">Active</Badge>
        )}
      </div>
    </div>
  );
}

/* Compact "Giving" rows */
export function GivingSection({ title, children }: { title: string, children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-1">
      <div className="px-2 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
      <div className="space-y-0.5">
        {children}
      </div>
    </div>
  );
}

export function GivingRow({
  name,
  date,
  amount,
  stage,
  tone,
  isChild = false
}: {
  name: string;
  date: string;
  amount: string;
  stage: string;
  tone?: "primary" | "success" | "muted" | "warning";
  isChild?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg px-2.5 py-2 hover:bg-slate-50 transition-colors ${isChild ? 'ml-3 border-l-2 border-slate-100 pl-3' : ''}`}>
      <div className="min-w-0">
        <div className={`truncate text-sm font-semibold ${tone === "primary" ? "text-slate-900" : tone === "muted" ? "text-slate-500" : "text-slate-800"}`}>
          {name}
        </div>
        <div className="rr-text-muted flex items-center gap-2 truncate text-xs mt-0.5 font-medium">
           {date}
           {stage && (
             <>
               <span className="w-1 h-1 rounded-full bg-slate-300" />
               <span className={
                 tone === 'success' ? 'text-green-600' : 
                 tone === 'warning' ? 'text-amber-600' : 
                 tone === 'primary' ? 'text-blue-600' : ''
               }>{stage}</span>
             </>
           )}
        </div>
      </div>
      <div className="shrink-0 text-sm font-bold tabular-nums text-right">
        {amount}
      </div>
    </div>
  );
}
