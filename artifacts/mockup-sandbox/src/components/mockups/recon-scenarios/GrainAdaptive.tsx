import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, AlertCircle, Plus, Layers, ChevronRight, ChevronDown, CornerDownRight } from "lucide-react";

// GRAIN OPTION C — ADAPTIVE: browse at cluster grain, work at transaction grain.
// The list is one row per cluster (like A). A multi-transaction cluster shows a
// compact rollup; expanding it reveals per-transaction sub-rows (like B) where
// the actual matching happens. Status rolls up from sub-rows.

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const Chip = ({ amount, label, sub, ok }: { amount: number; label: string; sub?: string; ok: boolean }) => (
  <div className={`w-full rounded border p-2 ${ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
    <div className="flex items-center gap-1.5">
      {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
      <span className={`text-xs font-semibold ${ok ? "text-emerald-900" : "text-amber-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${ok ? "text-emerald-800" : "text-amber-800"}`}>{label}</span>
    </div>
    {sub && <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${ok ? "text-emerald-700/80" : "text-amber-700"}`}>{sub}</div>}
  </div>
);

const Ghost = ({ label }: { label: string }) => (
  <div className="flex items-center justify-center gap-1 min-h-10 w-full rounded border border-dashed border-slate-200 bg-slate-50/30 text-slate-300">
    <Plus className="w-3 h-3" />
    <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
  </div>
);

const Pill = ({ kind, children }: { kind: "ok" | "todo" | "partial"; children: React.ReactNode }) => {
  const base = "inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider";
  const tone = kind === "ok" ? "bg-emerald-100 text-emerald-800" : kind === "partial" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800";
  return <span className={`${base} ${tone}`}>{children}</span>;
};

const SubRow = ({ who, whoOk, charge, chargeOk, chargeSub, status }: {
  who?: { amount: number; label: string; sub?: string };
  whoOk?: boolean;
  charge: { amount: number; label: string };
  chargeOk: boolean;
  chargeSub?: string;
  status: "ok" | "todo";
}) => (
  <TableRow className="bg-slate-50/70 hover:bg-slate-100/70 border-l-2 border-l-blue-200">
    <TableCell className="align-top py-2 pr-0 pl-6"><CornerDownRight className="w-3.5 h-3.5 text-slate-300 mt-2.5" /></TableCell>
    <TableCell className="align-top py-2">
      {who ? <Chip amount={who.amount} label={who.label} sub={who.sub} ok={whoOk ?? true} /> : <Ghost label="Link who & why" />}
    </TableCell>
    <TableCell className="align-top py-2"><Chip amount={charge.amount} label={charge.label} sub={chargeSub} ok={chargeOk} /></TableCell>
    <TableCell className="align-top py-2">
      <div className="flex items-center h-10 px-2 text-[10px] text-slate-400 font-medium">↳ part of DEP-3410</div>
    </TableCell>
    <TableCell className="align-top py-2 text-right"><Pill kind={status}>{status === "ok" ? "Matched" : "Needs match"}</Pill></TableCell>
  </TableRow>
);

export function GrainAdaptive() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Grain C — Adaptive (cluster ▸ transaction)</h1>
          <p className="text-xs text-slate-500 font-medium">Browse one row per cluster; expand to work one row per transaction</p>
        </div>
      </header>

      <div className="px-6 py-2.5 bg-white border-b border-slate-100 flex items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
          <CheckCircle2 className="w-3 h-3" /> Scan at money-event grain, act at decision grain — both counts stay honest
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">
          <AlertCircle className="w-3 h-3" /> Two levels of UI — expand/collapse state, indented sub-rows
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="border border-slate-200 rounded-lg shadow-sm overflow-hidden bg-white">
          <Table>
            <TableHeader className="bg-slate-50 border-b border-slate-200">
              <TableRow className="hover:bg-slate-50">
                <TableHead className="w-[28px]"></TableHead>
                <TableHead className="w-[280px] text-xs font-semibold text-slate-600">WHO &amp; WHY (CRM)</TableHead>
                <TableHead className="w-[280px] text-xs font-semibold text-slate-600">TRANSACTION (Proof)</TableHead>
                <TableHead className="w-[280px] text-xs font-semibold text-slate-600">ACCOUNTING (QB)</TableHead>
                <TableHead className="text-right text-xs font-semibold text-slate-600">Cluster</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Simple 1:1:1 cluster: no second level exists — renders exactly like A/B */}
              <TableRow className="hover:bg-slate-50">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="Meadow Fund Commitment" sub="Grant letter on file" ok /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="Wire TR-991" sub="Missing originating bank confirmation" ok={false} /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="DEP-8821 · QB Deposit" sub="4010 Grants · Class: National" ok /></TableCell>
                <TableCell className="align-top py-3 text-right"><Pill kind="partial">Partial</Pill></TableCell>
              </TableRow>

              {/* BIG CLUSTER — collapsed view is a compact rollup row */}
              <TableRow className="bg-blue-50/40 hover:bg-blue-50/50 border-t border-blue-100">
                <TableCell className="align-top py-3 pr-0"><ChevronDown className="w-4 h-4 text-blue-500 mt-2" /></TableCell>
                <TableCell className="align-top py-3">
                  <div className="flex items-center h-10 px-2.5 rounded border border-slate-200 bg-white">
                    <span className="text-xs font-medium text-slate-700">3 of 4 matched</span>
                    <span className="ml-2 text-[10px] text-amber-600 font-semibold">1 open</span>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <div className="flex items-center h-10 px-2.5 rounded border border-slate-200 bg-white">
                    <span className="text-xs font-medium text-slate-700">4 Stripe charges · {fmt(824.10)}</span>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3"><Chip amount={824.10} label="DEP-3410 · QB Deposit" sub="Payout deposit" ok /></TableCell>
                <TableCell className="align-top py-3 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <Pill kind="partial">Partial</Pill>
                    <span className="text-[9px] text-slate-400 font-medium">rolls up from 4 sub-rows</span>
                  </div>
                </TableCell>
              </TableRow>

              {/* …expanded into transaction-grain sub-rows where the work happens */}
              <SubRow who={{ amount: 500, label: "Rivera Family Fund", sub: "Recurring monthly gift" }} charge={{ amount: 500, label: "ch_9Rvra · Stripe" }} chargeOk status="ok" />
              <SubRow who={{ amount: 200, label: "Chen Household", sub: "Annual gift" }} charge={{ amount: 200, label: "ch_7Chen · Stripe" }} chargeOk status="ok" />
              <SubRow who={{ amount: 25, label: "Anna Okafor", sub: "First-time donor" }} charge={{ amount: 25, label: "ch_2Okfr · Stripe" }} chargeOk status="ok" />
              <SubRow charge={{ amount: 99.10, label: "ch_4Unkn · Stripe" }} chargeOk={false} chargeSub="No donor identified" status="todo" />

              {/* A stray is still one row, no second level */}
              <TableRow className="hover:bg-slate-50 border-t border-slate-100">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={75000} label="Prairie Sky Fund" sub="Pledge — expected this month" ok /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link transaction" /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link accounting" /></TableCell>
                <TableCell className="align-top py-3 text-right"><Pill kind="todo">Unlinked</Pill></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed max-w-3xl px-1">
          <span className="font-semibold text-slate-600">Reading:</span> the list says "12 clusters, 3 with open sub-work."
          Simple clusters never grow a second level, so most rows look exactly like option A — the hierarchy only appears
          when a cluster genuinely contains multiple decisions.
        </div>
      </div>
    </div>
  );
}
