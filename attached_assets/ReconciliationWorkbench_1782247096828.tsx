/**
 * ReconciliationWorkbench.tsx
 * ---------------------------------------------------------------------------
 * Drop-in reconciliation view for the WF Fundraising CRM.
 *
 * Renders inside the app's main content area (the 256px left nav is provided
 * by the app shell — this component owns no nav of its own). Themed entirely
 * with the existing shadcn/Tailwind tokens (bg-card, text-muted-foreground,
 * bg-primary, border-border, …) so it inherits the app's look automatically.
 *
 * Required shadcn/ui components (add with `npx shadcn@latest add ...`):
 *   button card badge input label textarea select dropdown-menu dialog
 * Also uses: lucide-react, and `cn` from "@/lib/utils".
 *
 * Data model note: a match is a row in `payment_applications`
 * (payment_id, gift_id, applied_amount, match_method, match_status, …).
 * Splits/groups/partials are just patterns of those rows; the balance meter
 * enforces sum(applied) === payment. Cross-processor lineage
 * (deposit↔payout↔charge↔donation) belongs in a separate `settlement_links`
 * join, surfaced here as the read-only "Settlement lineage" strip.
 *
 * Nothing is written to QuickBooks/CRM until the user clicks "Apply" in the
 * pending tray. Wire `onApply(changes)` to your mutation endpoint.
 * ---------------------------------------------------------------------------
 */
import { useMemo, useState } from "react";
import {
  Check, X, ChevronDown, Plus, Trash2, ArrowRightLeft, ArrowRight, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/* ----------------------------- types ----------------------------- */
export type AxisId = "all" | "qg" | "qs" | "qd" | "ds";
export type QueueId =
  | "review" | "qbo" | "crm" | "split" | "bundle" | "sync" | "research"
  | "confirmed" | "excluded";
export type Confidence = "high" | "med" | "low" | "weak" | null;
export type EditorKind = "split" | "merge" | "partial";
export type ActionKind =
  | "confirm" | "reject" | "retarget" | "create" | "exclude" | "donor"
  | "merge" | "split" | "group" | "partial" | "pledge" | "explode"
  | "sync" | "dup" | "research";

export interface RecordSide {
  src: string; type: string; name: string; amount: number; meta: string;
}
export interface AppRow { name: string; amount: number; status: "prop" | "conf"; }
export interface ChainNode { label: string; sub: string; done: boolean; }

export interface ReconItem {
  id: string;
  queue: QueueId;
  axis: AxisId;
  conf: Confidence;
  status: "open" | "staged";
  left: RecordSide | null;
  right: RecordSide | null;
  evidence: string[];
  note?: string;
  editor?: EditorKind;
  apps?: AppRow[];
  chain?: ChainNode[];
}
export interface StagedChange { kind: StageKind; label: string; itemId: string; }
export type StageKind =
  | "MATCH" | "UNMATCH" | "RETARGET" | "CREATE GIFT" | "EXCLUDE" | "DONOR"
  | "MERGE" | "PLEDGE" | "SPLIT" | "GROUP" | "PARTIAL" | "EXPLODE"
  | "SYNC GAP" | "DUPLICATE" | "RESEARCH";

/* ----------------------------- constants ----------------------------- */
const QUEUES: { id: QueueId; name: string; dot: string }[] = [
  { id: "review", name: "Needs review", dot: "#9a6b00" },
  { id: "qbo", name: "QBO-only", dot: "#b23b2e" },
  { id: "crm", name: "CRM-only", dot: "#b23b2e" },
  { id: "split", name: "Splits & pledges", dot: "#6c4ea3" },
  { id: "bundle", name: "Stripe/Donorbox bundles", dot: "#1a7a8c" },
  { id: "sync", name: "Sync gaps", dot: "#b8601c" },
  { id: "research", name: "Research", dot: "#857b73" },
  { id: "confirmed", name: "Confirmed", dot: "#2f7d57" },
  { id: "excluded", name: "Excluded", dot: "#6c4ea3" },
];

const AXES: { id: AxisId; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "qg", label: "QuickBooks ⇄ Gift" },
  { id: "qs", label: "QuickBooks ⇄ Stripe" },
  { id: "qd", label: "QuickBooks ⇄ Donorbox" },
  { id: "ds", label: "Donorbox ⇄ Stripe" },
];

const CONF_CLASS: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200",
  med: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-orange-50 text-orange-700 border-orange-200",
  weak: "bg-red-50 text-red-700 border-red-200",
};
const CONF_LABEL: Record<string, string> = {
  high: "High confidence", med: "Medium", low: "Low", weak: "Weak — coincidence",
};
const KIND_DOT: Record<StageKind, string> = {
  MATCH: "bg-emerald-600", UNMATCH: "bg-red-600", RETARGET: "bg-primary",
  "CREATE GIFT": "bg-primary", EXCLUDE: "bg-violet-600", DONOR: "bg-primary",
  MERGE: "bg-violet-600", PLEDGE: "bg-violet-600", SPLIT: "bg-violet-600",
  GROUP: "bg-violet-600", PARTIAL: "bg-violet-600", EXPLODE: "bg-teal-600",
  "SYNC GAP": "bg-orange-600", DUPLICATE: "bg-orange-600",
  RESEARCH: "bg-muted-foreground",
};

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ----------------------------- seed data ----------------------------- */
const SEED: ReconItem[] = [
  { id: "i1", queue: "review", axis: "qg", conf: "high", status: "open",
    left: { src: "QBO", type: "Payment", name: "OMIDYAR NETWORK FUND INC", amount: 500000, meta: "2019-11-19 · deposit dep_8841" },
    right: { src: "Gift", type: "Gift", name: "Omidyar FY21", amount: 500000, meta: "pledge_payment · Gen Ops" },
    evidence: ["Linked by matched_gift_id", "Amount agrees exactly", "Payer = linked donor entity"] },
  { id: "i2", queue: "review", axis: "qd", conf: "high", status: "open",
    left: { src: "QBO", type: "Payment", name: "Stripe payout py_4471", amount: 486.5, meta: "2024-03-02 · net of fees" },
    right: { src: "Gift", type: "Gift", name: "Donorbox — A. Kuthart recurring", amount: 500, meta: "gross $500.00" },
    evidence: ["Amount delta $13.50 (2.7%) = processor fee", "Date matches payout", "Donorbox campaign linked"],
    chain: [
      { label: "Donorbox", sub: "$500.00 ApplePay", done: true },
      { label: "Stripe charge", sub: "$500.00 / $13.50 fee", done: false },
      { label: "Payout py_4471", sub: "$486.50 net", done: true },
      { label: "QBO deposit", sub: "matches", done: false },
      { label: "Gift", sub: "this", done: false },
    ] },
  { id: "i3", queue: "review", axis: "qg", conf: "med", status: "open",
    left: { src: "QBO", type: "Payment", name: "William Penn Foundation", amount: 480, meta: "2023-05-11 · check 20551" },
    right: { src: "Gift", type: "Gift", name: "Kellie Brown — matching gift", amount: 480, meta: "CRM-only · individual" },
    evidence: ["Same amount & timeframe", "William Penn is Kellie Brown’s employer", "Likely employer match — payer ≠ donor"],
    note: "Resolve with “Change donor / payer” → set matching_employer, not by renaming the donor." },
  { id: "i4", queue: "review", axis: "qg", conf: "weak", status: "open",
    left: { src: "QBO", type: "Payment", name: "Stripe deposit (BWF)", amount: 300, meta: "2024-09-08" },
    right: { src: "Gift", type: "Gift", name: "Anonymous $300 — BWF", amount: 300, meta: "CRM-only" },
    evidence: ["Amount coincidence only", "Shared deposit, but it holds 11 donors", "No payer / name evidence"],
    note: "Flagged weak — round-number coincidence. Excluded from bulk-approve; needs a human call." },
  { id: "i5", queue: "qbo", axis: "qg", conf: null, status: "open",
    left: { src: "QBO", type: "Payment", name: "Excellent Schools New Mexico", amount: 1292.57, meta: "2023-08-14 · memo “reimb”" },
    right: null, evidence: ["No CRM gift", "Memo + account suggest expense reimbursement", "Allowable grant expenses"] },
  { id: "i6", queue: "qbo", axis: "qg", conf: null, status: "open",
    left: { src: "QBO", type: "Payment", name: "Future Focused Solutions", amount: 14000, meta: "2022-11-30" },
    right: null, evidence: ["No CRM gift", "Counterparty is a vendor", "Not inbound philanthropy"] },
  { id: "i7", queue: "qbo", axis: "qg", conf: null, status: "open",
    left: { src: "QBO", type: "Payment", name: "Blue Cross Blue Shield", amount: 70000, meta: "2021-07-06" },
    right: null, evidence: ["No linked gift in export", "CRM shows BCBS Healthy Start $70k (summer 2021)", "Likely sync gap, else create gift"] },
  { id: "i8", queue: "qbo", axis: "qg", conf: null, status: "open",
    left: { src: "QBO", type: "Payment", name: "Fidelity Charitable", amount: 50000, meta: "2022-02-18 · DAF" },
    right: null, evidence: ["Payer is a DAF intermediary", "Should link to “Rick & Molly Klau — Flame Lily Startup”", "That gift not in export — sync gap"] },
  { id: "i9", queue: "review", axis: "qg", conf: "med", status: "open",
    left: { src: "QBO", type: "Payment", name: "Mardag Foundation", amount: 75000, meta: "2022-06-30 · 2nd payment" },
    right: { src: "Gift", type: "Gift", name: "Mardag — St Paul & Minneapolis", amount: 75000, meta: "currently mis-linked" },
    evidence: ["Currently linked to the wrong Mardag gift", "Should re-target to the 2nd Mardag gift", "Frees the other for QBO-only"],
    note: "Use “Re-target match” to point at the correct gift." },
  { id: "i10", queue: "split", axis: "qg", conf: null, status: "open", editor: "split",
    left: { src: "QBO", type: "Payment", name: "OMIDYAR NETWORK FUND INC", amount: 1000000, meta: "2017-12-12 · single wire" },
    right: { src: "Gift", type: "2 gifts", name: "Omidyar FY18 + FY19 ($500k each)", amount: 1000000, meta: "pledge recL1lu…" },
    evidence: ["One payment covers 2 annual gifts", "Both are pledge installments", "Link to pledge; apply $1M across two"],
    apps: [
      { name: "Omidyar FY18 (pledge installment)", amount: 500000, status: "prop" },
      { name: "Omidyar FY19 (pledge installment)", amount: 500000, status: "prop" },
    ] },
  { id: "i11", queue: "split", axis: "qg", conf: null, status: "open", editor: "merge",
    left: { src: "QBO", type: "Payment", name: "Avi and Sandra Nash", amount: 200000, meta: "2021-01-05" },
    right: { src: "Gift", type: "3 gifts", name: "Avi Nash $118k + Nash FY21 $75k + Goldenrod $7k", amount: 200000, meta: "same date, one funder" },
    evidence: ["One payment recorded as 3 separate gifts", "Really one $200k grant", "Merge → single gift with 4 allocations"],
    apps: [
      { name: "Avi Nash — Gen Ops", amount: 118000, status: "prop" },
      { name: "Nash FY21 — Bay Area", amount: 25000, status: "prop" },
      { name: "Nash FY21 — Colorado", amount: 20000, status: "prop" },
      { name: "Nash FY21 — Massachusetts", amount: 30000, status: "prop" },
      { name: "Goldenrod hub grant", amount: 7000, status: "prop" },
    ] },
  { id: "i12", queue: "split", axis: "qg", conf: null, status: "open", editor: "partial",
    left: { src: "QBO", type: "Payment", name: "Stranahan Foundation", amount: 300000, meta: "2020-11-16 · 1 of 2" },
    right: { src: "Gift", type: "Gift", name: "Stranahan Foundation 2021 (9 allocations)", amount: 225000, meta: "amount ≠ payment" },
    evidence: ["$600k pledge paid as 2×$300k", "Gift already carries 9 allocation rows", "Attach to pledge; reconcile amount"],
    apps: [{ name: "Stranahan 2021 gift (this installment)", amount: 225000, status: "prop" }] },
  { id: "i13", queue: "bundle", axis: "qs", conf: null, status: "open",
    left: { src: "QBO", type: "Deposit", name: "QBO deposit — single line", amount: 3199.32, meta: "2024-04-30" },
    right: { src: "Stripe", type: "Payout", name: "Stripe payout py_pyhf — 17 charges", amount: 3199.32, meta: "net matches exactly" },
    evidence: ["Deposit = payout net (exact)", "Bundles 17 separate donors", "Split deposit → per-donor gifts"],
    chain: [
      { label: "QBO deposit", sub: "$3,199.32 one line", done: false },
      { label: "Payout py_pyhf", sub: "17 charges", done: true },
      { label: "17 donations", sub: "distinct donors", done: false },
    ] },
  { id: "i14", queue: "bundle", axis: "ds", conf: "high", status: "open",
    left: { src: "Donorbox", type: "Donation", name: "M. Downey — $875 (ApplePay)", amount: 875, meta: "2025-02-04 · campaign BWF" },
    right: { src: "Stripe", type: "Charge", name: "ch_AOL_38f", amount: 875, meta: "processor=stripe via wallet" },
    evidence: ["ApplePay settles through Stripe", "Charge id + amount + date match", "Confirms Donorbox ⇄ Stripe link"] },
];

/* ----------------------------- small UI bits ----------------------------- */
function ConfChip({ conf }: { conf: Confidence }) {
  if (!conf)
    return <Badge variant="outline" className="bg-muted text-muted-foreground border-transparent font-normal">needs action</Badge>;
  return (
    <Badge variant="outline" className={cn("font-semibold", CONF_CLASS[conf])}>
      {conf === "high" ? "✓ " : conf === "weak" ? "⚠ " : ""}{CONF_LABEL[conf]}
    </Badge>
  );
}

function BalanceMeter({ applied, total }: { applied: number; total: number }) {
  const rem = +(total - applied).toFixed(2);
  const pct = total ? Math.min(100, (applied / total) * 100) : 0;
  const balanced = Math.abs(rem) < 0.005;
  const over = rem < -0.005;
  return (
    <div className={cn(
      "mt-2.5 rounded-lg border p-3 text-[12.5px]",
      balanced ? "border-emerald-200 bg-emerald-50"
        : over ? "border-red-200 bg-red-50" : "border-border bg-background",
    )}>
      <div className="flex justify-between tabular-nums"><span>Applied</span><b>{money(applied)}</b></div>
      <div className="my-1.5 h-2 overflow-hidden rounded bg-muted">
        <div className="h-full transition-all"
          style={{ width: `${pct}%`, background: over ? "#b23b2e" : balanced ? "#2f7d57" : "hsl(var(--primary))" }} />
      </div>
      <div className="flex justify-between tabular-nums"><span>Payment total</span><b>{money(total)}</b></div>
      <div className={cn("mt-1 font-semibold",
        balanced ? "text-emerald-700" : over ? "text-red-700" : "text-amber-700")}>
        {balanced ? "● balances — applied = payment"
          : over ? `▲ over-applied by ${money(-rem)}`
            : `○ ${money(rem)} unapplied — route the remainder`}
      </div>
    </div>
  );
}

function RecordCol({ side, className }: { side: RecordSide | null; className?: string }) {
  if (!side)
    return <div className={cn("flex items-center p-3.5 text-[12.5px] italic text-muted-foreground", className)}>— no counterpart —</div>;
  return (
    <div className={cn("p-3.5", className)}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{side.src} · {side.type}</div>
      <div className="text-sm font-semibold leading-tight">{side.name}</div>
      <div className="mt-0.5 text-base font-bold tabular-nums">{money(side.amount)}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{side.meta}</div>
    </div>
  );
}

function Lineage({ chain }: { chain: ChainNode[] }) {
  return (
    <>
      <div className="mb-1.5 mt-2.5 text-[10px] uppercase tracking-wide text-muted-foreground">Settlement lineage</div>
      <div className="flex flex-wrap items-center gap-y-1">
        {chain.map((n, i) => (
          <span key={i} className="flex items-center">
            <span className="flex items-center gap-1.5">
              <span className={cn("h-2.5 w-2.5 rounded-full border-2", n.done ? "border-emerald-600 bg-emerald-600" : "border-primary bg-card")} />
              <span className="text-[11.5px]"><b>{n.label}</b> <span className="text-muted-foreground">{n.sub}</span></span>
            </span>
            {i < chain.length - 1 && <ArrowRight className="mx-2.5 h-3.5 w-3.5 text-muted-foreground" />}
          </span>
        ))}
      </div>
    </>
  );
}

function ApplicationsView({ item }: { item: ReconItem }) {
  if (!item.apps || !item.left) return null;
  const applied = item.apps.reduce((s, a) => s + a.amount, 0);
  const verb = item.editor === "split" ? "one payment → many gifts"
    : item.editor === "merge" ? "many gifts → one gift + allocations"
      : "installment of a larger commitment";
  return (
    <>
      <div className="mb-1.5 mt-2.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        payment_applications · {verb}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {item.apps.map((a, i) => (
          <div key={i} className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-[12.5px] last:border-b-0">
            <span className="flex items-center gap-2">
              <span className={cn("rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide",
                a.status === "conf" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                {a.status === "conf" ? "confirmed" : "proposed"}
              </span>{a.name}
            </span>
            <span className="font-semibold tabular-nums">{money(a.amount)}</span>
          </div>
        ))}
      </div>
      <BalanceMeter applied={applied} total={item.left.amount} />
    </>
  );
}

/* ----------------------------- resolve menu ----------------------------- */
function ResolveMenu({ item, onPick }: { item: ReconItem; onPick: (k: ActionKind) => void }) {
  const has = !!item.right;
  const qboOnly = !!item.left && !item.right;
  const MI = (k: ActionKind, t: string, d: string) => (
    <DropdownMenuItem onClick={() => onPick(k)} className="flex-col items-start gap-0">
      <span className="font-medium">{t}</span>
      <span className="text-[11px] text-muted-foreground">{d}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="h-8 gap-1">Resolve <ChevronDown className="h-3.5 w-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Matching</DropdownMenuLabel>
        {has && MI("confirm", "Confirm match", "approve this link")}
        {has && MI("reject", "Reject match", "these are not the same")}
        {has && MI("retarget", "Re-target match", "link to a different gift")}
        {qboOnly && MI("create", "Create gift", "build a gift from this payment")}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Classify</DropdownMenuLabel>
        {MI("exclude", "Exclude payment", "reason: vendor, reimbursement, loan…")}
        {MI("donor", "Change donor / payer", "payer-vehicle → donor; DAF / employer")}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Restructure</DropdownMenuLabel>
        {MI("merge", "Merge → single gift + allocations", "combine several gifts into one")}
        {MI("pledge", "Link / convert to pledge", "attach installment to a pledge")}
        {MI("split", "Split payment across gifts", "one payment → many application rows")}
        {MI("group", "Group payments → one gift", "many payments → one gift")}
        {has && MI("partial", "Apply as partial / installment", "applied_amount < payment")}
        {item.queue === "bundle" && MI("explode", "Split deposit → per-donor gifts", "explode a Stripe/Donorbox payout")}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Flag</DropdownMenuLabel>
        {MI("sync", "Flag as sync gap", "exists in CRM, missing from export")}
        {MI("dup", "Mark duplicate", "point at the canonical record")}
        {MI("research", "Send to research", "park with a note + assignee")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ----------------------------- card ----------------------------- */
function ReconCard({
  item, selected, onSelect, onConfirm, onReject, onPick, onUndo,
}: {
  item: ReconItem; selected: boolean;
  onSelect: () => void; onConfirm: () => void; onReject: () => void;
  onPick: (k: ActionKind) => void; onUndo: () => void;
}) {
  const staged = item.status !== "open";
  return (
    <div className={cn("mb-3 overflow-visible rounded-xl border bg-card",
      selected ? "border-primary shadow-[0_3px_16px_rgba(41,92,74,0.12)]" : "border-border")}>
      <div className="grid cursor-pointer grid-cols-[1fr_38px_1fr]" onClick={onSelect}>
        <RecordCol side={item.left} className="border-r border-border/60" />
        <div className="flex items-center justify-center text-muted-foreground"><ArrowRightLeft className="h-4 w-4" /></div>
        <RecordCol side={item.right} />
      </div>

      <div className="flex flex-wrap items-start gap-2.5 border-t border-border/60 px-4 py-2.5">
        <ConfChip conf={item.conf} />
        <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
          {item.evidence.map((e, i) => <span key={i} className="text-xs text-foreground/75">• {e}</span>)}
        </div>
      </div>

      {item.note && (
        <div className="mx-4 mb-2.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary">💡 {item.note}</div>
      )}

      {(item.apps || item.chain) && (
        <div className="px-4 pb-3">
          {item.chain && <Lineage chain={item.chain} />}
          {item.apps && <ApplicationsView item={item} />}
        </div>
      )}

      <div className="flex items-center gap-2 rounded-b-xl border-t border-border/60 bg-muted/30 px-4 py-2.5">
        {staged ? (
          <>
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-700">
              <Check className="h-4 w-4" /> staged — in the pending tray
            </span>
            <div className="ml-auto">
              <Button size="sm" variant="outline" className="h-8 gap-1" onClick={onUndo}><Undo2 className="h-3.5 w-3.5" /> Undo</Button>
            </div>
          </>
        ) : (
          <div className="ml-auto flex gap-2">
            {item.right && (
              <Button size="sm" className="h-8 gap-1 bg-emerald-600 text-white hover:bg-emerald-700" onClick={onConfirm}>
                <Check className="h-3.5 w-3.5" /> Approve
              </Button>
            )}
            {item.right && (
              <Button size="sm" variant="outline" className="h-8 gap-1 border-red-200 text-red-700 hover:bg-red-50" onClick={onReject}>
                <X className="h-3.5 w-3.5" /> Reject
              </Button>
            )}
            <ResolveMenu item={item} onPick={onPick} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- dialogs ----------------------------- */
type Field = {
  id: string; label: string; kind: "input" | "select" | "textarea";
  options?: string[]; default?: string; placeholder?: string; disabled?: boolean;
};

function SimpleDialog({
  title, hint, warn, fields, confirmLabel, makeLabel, onStage, onClose,
}: {
  title: string; hint?: string; warn?: string; fields: Field[];
  confirmLabel: string; makeLabel: (vals: Record<string, string>) => string;
  onStage: (label: string) => void; onClose: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.id, f.default ?? ""])),
  );
  const set = (id: string, v: string) => setVals((s) => ({ ...s, [id]: v }));
  return (
    <>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <div className="space-y-3 py-1">
        {hint && <div className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary">💡 {hint}</div>}
        {warn && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">⚠ {warn}</div>}
        {fields.map((f) => (
          <div key={f.id} className="space-y-1">
            <Label className="text-[11.5px] text-muted-foreground">{f.label}</Label>
            {f.kind === "input" && (
              <Input value={vals[f.id]} disabled={f.disabled} placeholder={f.placeholder}
                onChange={(e) => set(f.id, e.target.value)} />
            )}
            {f.kind === "textarea" && (
              <Textarea rows={2} value={vals[f.id]} placeholder={f.placeholder}
                onChange={(e) => set(f.id, e.target.value)} />
            )}
            {f.kind === "select" && (
              <Select value={vals[f.id]} onValueChange={(v) => set(f.id, v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {f.options!.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onStage(makeLabel(vals))}>{confirmLabel}</Button>
      </DialogFooter>
    </>
  );
}

function ApplicationsEditor({
  title, help, total, initialRows, extra, confirmLabel, onStage, onClose,
}: {
  title: string; help: string; total: number; initialRows: AppRow[];
  extra?: Field[]; confirmLabel: string;
  onStage: () => void; onClose: () => void;
}) {
  const [rows, setRows] = useState(
    initialRows.length ? initialRows.map((r) => ({ name: r.name, amount: String(r.amount || "") }))
      : [{ name: "", amount: "" }],
  );
  const applied = rows.reduce((s, r) => s + (parseFloat(r.amount.replace(/[^0-9.\-]/g, "")) || 0), 0);
  const balanced = Math.abs(total - applied) < 0.005;
  const upd = (i: number, k: "name" | "amount", v: string) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <div className="space-y-3 py-1">
        <div className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary">💡 {help}</div>
        {extra?.map((f) => (
          <div key={f.id} className="space-y-1">
            <Label className="text-[11.5px] text-muted-foreground">{f.label}</Label>
            {f.kind === "select"
              ? (
                <Select defaultValue={f.default ?? f.options?.[0]}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{f.options!.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                </Select>
              )
              : <Input defaultValue={f.default} placeholder={f.placeholder} />}
          </div>
        ))}
        <div className="grid grid-cols-[1.9fr_120px_30px] gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Application row (→ gift)</span><span className="text-right">applied_amount</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1.9fr_120px_30px] items-center gap-2">
            <Input value={r.name} placeholder="gift / application name" onChange={(e) => upd(i, "name", e.target.value)} />
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-2 text-xs text-muted-foreground">$</span>
              <Input className="pl-4 text-right tabular-nums" value={r.amount} placeholder="0"
                onChange={(e) => upd(i, "amount", e.target.value)} />
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="gap-1"
          onClick={() => setRows((rs) => [...rs, { name: "", amount: "" }])}>
          <Plus className="h-3.5 w-3.5" /> Add application row
        </Button>
        <BalanceMeter applied={applied} total={total} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!balanced} onClick={onStage}>
          {balanced ? confirmLabel : "Balance to enable"}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ----------------------------- main component ----------------------------- */
export default function ReconciliationWorkbench({
  initialItems = SEED,
  onApply,
}: {
  initialItems?: ReconItem[];
  onApply?: (changes: StagedChange[]) => void;
}) {
  const [items, setItems] = useState<ReconItem[]>(initialItems);
  const [queue, setQueue] = useState<QueueId>("review");
  const [axis, setAxis] = useState<AxisId>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [tray, setTray] = useState<StagedChange[]>([]);
  const [dialog, setDialog] = useState<{ itemId: string; kind: ActionKind } | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    items.forEach((i) => (c[i.queue] = (c[i.queue] || 0) + 1));
    return c;
  }, [items]);

  const visible = items.filter((i) => i.queue === queue && (axis === "all" || i.axis === axis));
  const openCount = items.filter((i) => i.status === "open").length;
  const resolved = 560 + tray.length;

  function stage(kind: StageKind, label: string, itemId: string, quiet = false) {
    setTray((t) => [...t, { kind, label, itemId }]);
    setItems((arr) => arr.map((i) => {
      if (i.id !== itemId) return i;
      const nextQ: QueueId =
        kind === "EXCLUDE" ? "excluded" : kind === "MATCH" ? "confirmed"
          : kind === "SYNC GAP" ? "sync" : kind === "RESEARCH" ? "research" : i.queue;
      return { ...i, status: "staged", queue: nextQ };
    }));
    if (!quiet) setDialog(null);
  }
  function unstageAt(idx: number) {
    const t = tray[idx];
    if (!t) return;
    setItems((arr) => arr.map((i) => (i.id === t.itemId ? { ...i, status: "open" } : i)));
    setTray((arr) => arr.filter((_, j) => j !== idx));
  }
  function undoItem(itemId: string) {
    const idx = tray.findIndex((t) => t.itemId === itemId);
    if (idx >= 0) unstageAt(idx);
  }
  function discardAll() {
    setItems((arr) => arr.map((i) => (i.status === "staged" ? { ...i, status: "open" } : i)));
    setTray([]);
  }
  function applyAll() {
    onApply?.(tray);
    setTray([]);
  }

  function pick(item: ReconItem, kind: ActionKind) {
    const L = item.left?.name ?? "";
    const R = item.right?.name ?? "";
    if (kind === "confirm") return stage("MATCH", `Confirm: ${L} ⇄ ${R}`, item.id);
    if (kind === "reject") return stage("UNMATCH", `Reject link: ${L} ⇄ ${R}`, item.id);
    setDialog({ itemId: item.id, kind });
  }
  function bulkApproveHigh() {
    visible.filter((i) => i.status === "open" && i.conf === "high")
      .forEach((i) => stage("MATCH", `Confirm: ${i.left?.name} ⇄ ${i.right?.name}`, i.id, true));
  }

  const dialogItem = dialog ? items.find((i) => i.id === dialog.itemId) ?? null : null;

  return (
    <div className="mx-auto max-w-[1080px] px-6 py-6 pb-32 text-foreground">
      {/* header */}
      <div className="mb-1 flex items-baseline gap-3">
        <span className="text-[12.5px] text-muted-foreground">CRM ›</span>
        <h1 className="text-xl font-bold tracking-tight">Reconciliation</h1>
      </div>
      <p className="mb-4 text-[12.5px] text-muted-foreground">
        Match QuickBooks payments to gifts, Stripe, and Donorbox — and resolve the issues that surface along
        the way. Staged changes are held until you apply them; nothing is written automatically.
      </p>

      {/* metrics */}
      <div className="mb-4 flex flex-wrap gap-2.5">
        <Stat label="Gifts resolved" value={`${resolved}`} sub="/ 707" pct={(resolved / 707) * 100} />
        <Stat label="Open items" value={`${openCount}`} />
        <Stat label="Staged" value={`${tray.length}`} />
        <Stat label="Tie-out" value="● $76,530,594" tie />
      </div>

      {/* toolbar */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <div className="flex flex-wrap gap-1.5">
          {QUEUES.map((q) => {
            const active = q.id === queue;
            return (
              <button key={q.id} onClick={() => { setQueue(q.id); setSelected(null); }}
                className={cn("inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px]",
                  active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent")}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: q.dot }} />
                {q.name}
                <span className={cn("rounded-full px-1.5 text-[11px]",
                  active ? "bg-white/20" : "bg-muted text-muted-foreground")}>{counts[q.id] || 0}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select value={axis} onValueChange={(v) => setAxis(v as AxisId)}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue /></SelectTrigger>
            <SelectContent>{AXES.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9" onClick={bulkApproveHigh}>✓ Approve all high-confidence</Button>
        </div>
      </div>

      {/* list */}
      {visible.length ? (
        visible.map((item) => (
          <ReconCard key={item.id} item={item} selected={selected === item.id}
            onSelect={() => setSelected(item.id)}
            onConfirm={() => pick(item, "confirm")}
            onReject={() => pick(item, "reject")}
            onPick={(k) => pick(item, k)}
            onUndo={() => undoItem(item.id)} />
        ))
      ) : (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Nothing in this queue. 🎉
        </div>
      )}

      {/* pending tray */}
      <div className="fixed bottom-4 right-4 z-40 w-[340px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground">
          ⤓ Pending changes
          <span className="rounded-full bg-white/20 px-2 text-[11.5px]">{tray.length}</span>
          <span className="text-[11px] font-normal opacity-90">(staged — not written)</span>
        </div>
        <div className="max-h-[220px] overflow-y-auto">
          {tray.length ? tray.map((t, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-border/60 px-3.5 py-2 text-xs">
              <span className={cn("mt-px shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white", KIND_DOT[t.kind])}>{t.kind}</span>
              <span>{t.label}</span>
              <button className="ml-auto text-muted-foreground" onClick={() => unstageAt(i)}><X className="h-3.5 w-3.5" /></button>
            </div>
          )) : <div className="px-3.5 py-6 text-center text-xs text-muted-foreground">No staged changes.</div>}
        </div>
        <div className="flex gap-2 border-t border-border bg-muted/30 px-3.5 py-2.5">
          <Button variant="outline" size="sm" onClick={discardAll}>Discard all</Button>
          <Button size="sm" className="ml-auto" onClick={applyAll}>Apply to QuickBooks &amp; CRM →</Button>
        </div>
      </div>

      {/* action dialog */}
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-[560px]">
          {dialogItem && dialog && (
            <ActionDialogBody item={dialogItem} kind={dialog.kind}
              onStage={(kind, label) => stage(kind, label, dialogItem.id)}
              onClose={() => setDialog(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, sub, pct, tie }: { label: string; value: string; sub?: string; pct?: number; tie?: boolean }) {
  return (
    <div className="min-w-[150px] rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-bold tabular-nums", tie ? "text-[15px] text-emerald-700" : "text-lg")}>
        {value}{sub && <small className="ml-1 text-[11px] font-medium text-muted-foreground">{sub}</small>}
      </div>
      {pct != null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

/* maps an action to the right dialog body */
function ActionDialogBody({
  item, kind, onStage, onClose,
}: {
  item: ReconItem; kind: ActionKind;
  onStage: (k: StageKind, label: string) => void; onClose: () => void;
}) {
  const L = item.left?.name ?? "";
  const isPenn = /penn/i.test(L), isFid = /fidelity/i.test(L), isBlue = /blue/i.test(L);

  switch (kind) {
    case "retarget":
      return <SimpleDialog title="Re-target match" confirmLabel="Stage change"
        hint="Break the current link and point this payment at the correct gift."
        fields={[
          { id: "gift", label: "Search gifts", kind: "input", default: "Mardag — 2nd gift FY22" },
          { id: "amt", label: "Applied amount", kind: "input", default: item.left ? money(item.left.amount) : "" },
        ]}
        makeLabel={(v) => `Re-link ${L} → ${v.gift}`}
        onStage={(label) => onStage("RETARGET", label)} onClose={onClose} />;
    case "create":
      return <SimpleDialog title="Create gift from payment" confirmLabel="Stage change"
        hint="Pre-filled from the QuickBooks payment. Nothing is written until you Apply."
        fields={[
          { id: "name", label: "Gift name", kind: "input", default: `${L} — 2026` },
          { id: "amount", label: "Amount", kind: "input", default: item.left ? money(item.left.amount) : "" },
          { id: "type", label: "Gift type", kind: "select", options: ["standard_gift", "pledge_payment", "directed_gift"], default: "standard_gift" },
          { id: "donor", label: "Donor", kind: "input", placeholder: "search organizations / people" },
        ]}
        makeLabel={() => `Create gift for ${L} (${item.left ? money(item.left.amount) : ""})`}
        onStage={(label) => onStage("CREATE GIFT", label)} onClose={onClose} />;
    case "exclude":
      return <SimpleDialog title="Exclude payment" confirmLabel="Stage change"
        fields={[
          { id: "reason", label: "Reason (required)", kind: "select", default: "Vendor payment — not a gift",
            options: ["Vendor payment — not a gift", "Expense reimbursement — allowable grant expenses",
              "Earned / service income", "Loan capital / PRI", "Government reimbursement",
              "Credit-card payable", "Intercompany transfer", "Tax refund", "Fiscally-sponsored pass-through"] },
          { id: "note", label: "Note", kind: "textarea", placeholder: "optional supporting detail" },
        ]}
        makeLabel={(v) => `Exclude ${L}: ${v.reason}`}
        onStage={(label) => onStage("EXCLUDE", label)} onClose={onClose} />;
    case "donor":
      return <SimpleDialog title="Change donor / payer" confirmLabel="Stage change"
        hint="Use when the payer isn’t the real donor — a DAF, employer match, or fiscal intermediary."
        fields={[
          { id: "kind", label: "This is…", kind: "select",
            options: ["A DAF / giving vehicle (set advised_by)", "An employer match (set matching_employer)", "A fiscal intermediary (set true donor)"],
            default: isPenn ? "An employer match (set matching_employer)" : "A DAF / giving vehicle (set advised_by)" },
          { id: "donor", label: "Real donor", kind: "input", default: isPenn ? "Kellie Brown" : isFid ? "Rick & Molly Klau" : "", placeholder: "search people / orgs" },
          { id: "payer", label: "Keep payer as", kind: "input", default: L, disabled: true },
        ]}
        makeLabel={() => `Reassign ${L} → real donor / vehicle`}
        onStage={(label) => onStage("DONOR", label)} onClose={onClose} />;
    case "pledge":
      return <SimpleDialog title="Link / convert to pledge" confirmLabel="Stage change"
        hint="Attach this gift to a multi-year pledge; one payment can satisfy several installments."
        fields={[
          { id: "pledge", label: "Pledge", kind: "select", options: ["Existing — Omidyar (recL1lu…)", "Existing — Frey renewal", "＋ Create new pledge"], default: "Existing — Omidyar (recL1lu…)" },
          { id: "total", label: "Pledge total", kind: "input", default: "$2,000,000" },
        ]}
        makeLabel={() => `Link ${item.right?.name ?? L} to pledge`}
        onStage={(label) => onStage("PLEDGE", label)} onClose={onClose} />;
    case "explode":
      return <SimpleDialog title="Split deposit into per-donor gifts" confirmLabel="Stage change"
        warn="This deposit bundles many different donors. Do NOT merge — explode it into separate gifts."
        fields={[
          { id: "mode", label: "Action", kind: "select", options: ["Create 17 gifts from charges & auto-match to Donorbox", "Review each charge first"], default: "Create 17 gifts from charges & auto-match to Donorbox" },
        ]}
        makeLabel={() => `Explode deposit ${L} → 17 per-donor gifts`}
        onStage={(label) => onStage("EXPLODE", label)} onClose={onClose} />;
    case "sync":
      return <SimpleDialog title="Flag as sync gap" confirmLabel="Stage change"
        hint="The matching gift exists in the CRM but is missing from the export. Flag for re-import rather than creating a duplicate."
        fields={[
          { id: "gift", label: "CRM gift it should match", kind: "input", default: isBlue ? "BCBS Healthy Start $70k (2021)" : isFid ? "Rick & Molly Klau — Flame Lily" : "", placeholder: "search CRM" },
          { id: "note", label: "Note", kind: "textarea", default: "Present in CRM, absent from export — re-sync." },
        ]}
        makeLabel={() => `Flag sync gap: ${L}`}
        onStage={(label) => onStage("SYNC GAP", label)} onClose={onClose} />;
    case "dup":
      return <SimpleDialog title="Mark duplicate" confirmLabel="Stage change"
        fields={[{ id: "canon", label: "Canonical record to merge into", kind: "input", placeholder: "search gifts" }]}
        makeLabel={() => `Mark ${L || item.right?.name} as duplicate`}
        onStage={(label) => onStage("DUPLICATE", label)} onClose={onClose} />;
    case "research":
      return <SimpleDialog title="Send to research" confirmLabel="Stage change"
        fields={[
          { id: "who", label: "Assignee", kind: "input", default: "Matt K." },
          { id: "q", label: "Question", kind: "textarea", placeholder: "what needs to be verified?" },
        ]}
        makeLabel={() => `Research: ${L || item.right?.name}`}
        onStage={(label) => onStage("RESEARCH", label)} onClose={onClose} />;
    case "merge":
      return <ApplicationsEditor title="Merge into single gift with allocations"
        help="Combine the gift rows one payment covers into a single gift; each line becomes an allocation. Lines must sum to the payment."
        total={item.left?.amount ?? 0} initialRows={item.apps ?? []}
        extra={[{ id: "parent", label: "Parent gift name", kind: "input", default: `${item.right ? item.right.name.split(" + ")[0] : L} (consolidated)` }]}
        confirmLabel="Stage application rows"
        onStage={() => onStage("MERGE", `Merge ${(item.apps ?? []).length} gifts → 1 gift + allocations`)} onClose={onClose} />;
    case "split":
      return <ApplicationsEditor title="Split payment across gifts"
        help="Allocate one payment to several gifts as application rows; route any remainder to a new gift. Lines must sum to the payment."
        total={item.left?.amount ?? 0}
        initialRows={item.apps ?? [{ name: "Sep FY21", amount: 337224, status: "prop" }, { name: "Sep NJ FY21 (remainder · create)", amount: 141436, status: "prop" }]}
        confirmLabel="Stage application rows"
        onStage={() => onStage("SPLIT", `Split ${L} into application rows`)} onClose={onClose} />;
    case "group":
      return <ApplicationsEditor title="Group payments → one gift"
        help="Several payments satisfy one gift; each becomes an application row. Rows sum to the gift amount."
        total={item.right?.amount ?? 0}
        initialRows={item.apps ?? [{ name: "Payment 1", amount: 0, status: "prop" }, { name: "Payment 2", amount: 0, status: "prop" }]}
        extra={[{ id: "gift", label: "Target gift", kind: "input", default: item.right?.name ?? "", placeholder: "search gifts" }]}
        confirmLabel="Stage application rows"
        onStage={() => onStage("GROUP", `Group payments → ${item.right?.name ?? "gift"}`)} onClose={onClose} />;
    case "partial":
      return <ApplicationsEditor title="Apply as partial / installment"
        help="This payment covers part of a larger commitment. Apply what it satisfies; the balance stays open on the pledge."
        total={item.left?.amount ?? 0}
        initialRows={item.apps ?? [{ name: item.right?.name ?? "this gift", amount: item.right?.amount ?? 0, status: "prop" }]}
        extra={[{ id: "pledge", label: "Against pledge", kind: "select", options: ["Existing — Stranahan $600k (2 installments)", "＋ Create new pledge"], default: "Existing — Stranahan $600k (2 installments)" }]}
        confirmLabel="Stage application rows"
        onStage={() => onStage("PARTIAL", `Apply ${L} as installment`)} onClose={onClose} />;
    default:
      return null;
  }
}
