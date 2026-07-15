import { type ReactNode } from "react";
import { Link2, Plus, Search } from "lucide-react";

// ─── Shared visual primitives for the cluster workbench (V4 layout) ──────────
// Column grid: chevron | donor & purpose | payment evidence | bank & accounting
// | status & next step | row kebab.

export const GRID =
  "grid grid-cols-[26px_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_190px_30px] gap-3 px-4 items-start";

export type Tone = "green" | "amber" | "red" | "blue" | "slate";

const DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-blue-500",
  slate: "bg-slate-400",
};

const WORD: Record<Tone, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  amber: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
  blue: "text-blue-700 dark:text-blue-400",
  slate: "text-slate-500 dark:text-slate-400",
};

/** Calm dot + word status cell with an optional detail line and action. */
export function StatusCell({
  tone,
  word,
  detail,
  action,
  testId,
}: {
  tone: Tone;
  word: string;
  detail?: string | null;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1 items-start" data-testid={testId}>
      <span
        className={`inline-flex items-center gap-1.5 text-xs font-semibold ${WORD[tone]}`}
      >
        <span className={`w-2 h-2 rounded-full ${DOT[tone]} shrink-0`} />
        {word}
      </span>
      {detail ? (
        <span className="text-[10px] text-muted-foreground leading-tight">
          {detail}
        </span>
      ) : null}
      {action}
    </div>
  );
}

const CARD_TONE: Record<"green" | "amber" | "slate", string> = {
  green:
    "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30",
  amber:
    "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30",
  slate: "border-border bg-muted/40",
};

/** A toned facet card: one record (gift / charge / QB row) in one column. */
export function FacetCard({
  tone,
  amount,
  name,
  sub,
  gap,
  badges,
  menu,
  testId,
}: {
  tone: "green" | "amber" | "slate";
  amount?: string | null;
  name: ReactNode;
  sub?: ReactNode;
  gap?: string | null;
  badges?: ReactNode;
  menu?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={`relative rounded-md border px-2.5 py-1.5 ${CARD_TONE[tone]}`}
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {amount ? (
          <span className="text-xs font-bold tabular-nums shrink-0">
            {amount}
          </span>
        ) : null}
        <span className="text-xs font-semibold truncate min-w-0">{name}</span>
        <span className="flex items-center gap-1 ml-auto shrink-0">
          {badges}
          {menu}
        </span>
      </div>
      {sub ? (
        <div className="text-[11px] text-muted-foreground leading-snug">
          {sub}
        </div>
      ) : null}
      {gap ? (
        <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 leading-snug">
          {gap}
        </div>
      ) : null}
    </div>
  );
}

/** Neutral "excluded / not a donation" stand-in card. */
export function ExcludedCard({ reason }: { reason?: string | null }) {
  return (
    <div className="rounded-md border bg-muted/40 px-2.5 py-1.5">
      <div className="text-xs font-medium text-muted-foreground italic">
        Not a donation
      </div>
      {reason ? (
        <div className="text-[11px] text-muted-foreground">{reason}</div>
      ) : null}
    </div>
  );
}

/** Collapsed-bundle summary card (first line bold, rest muted). */
export function SummaryCard({
  lines,
  gap,
  testId,
}: {
  lines: string[];
  gap?: string | null;
  testId?: string;
}) {
  return (
    <div
      className="rounded-md border bg-card px-2.5 py-1.5"
      data-testid={testId}
    >
      {lines.map((l, i) => (
        <div
          key={l}
          className={`text-[11px] leading-snug ${
            i === 0 ? "font-semibold" : "text-muted-foreground"
          }`}
        >
          {l}
        </div>
      ))}
      {gap ? (
        <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 leading-snug">
          {gap}
        </div>
      ) : null}
    </div>
  );
}

/** Dashed "link …" placeholder slot for a facet the cluster doesn't have yet. */
export function LinkSlot({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="w-full rounded-md border border-dashed px-2.5 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide hover:border-foreground/40 hover:text-foreground disabled:hover:border-border disabled:hover:text-muted-foreground flex items-center justify-center gap-1"
      data-testid={testId}
    >
      <Plus className="w-3 h-3" /> {label}
    </button>
  );
}

/** Teal "DB" chip — the gift is backed by a matched Donorbox record. */
export function DbBadge() {
  return (
    <span
      title="Matched to Donorbox record"
      className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-teal-600 text-white text-[7px] font-bold shrink-0"
    >
      DB
    </span>
  );
}

/** The three-action donor slot for evidence with no CRM gift yet. */
export function DonorActions({
  onLink,
  onCreate,
  onIdentify,
  disabled,
  testIdBase,
}: {
  onLink: () => void;
  onCreate: () => void;
  onIdentify: () => void;
  disabled?: boolean;
  testIdBase: string;
}) {
  const actions = [
    {
      icon: <Link2 className="w-3 h-3" />,
      label: "Link CRM donation record",
      onClick: onLink,
      id: "link",
    },
    {
      icon: <Plus className="w-3 h-3" />,
      label: "Create CRM donation record",
      onClick: onCreate,
      id: "create",
    },
    {
      icon: <Search className="w-3 h-3" />,
      label: "Identify donor",
      onClick: onIdentify,
      id: "identify",
    },
  ];
  return (
    <div className="flex flex-col gap-1">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={disabled}
          onClick={a.onClick}
          className="w-full rounded-md border border-dashed px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:border-foreground/40 hover:text-foreground hover:bg-muted/50 disabled:opacity-50 flex items-center gap-1.5"
          data-testid={`button-${testIdBase}-${a.id}`}
        >
          {a.icon} {a.label}
        </button>
      ))}
    </div>
  );
}
