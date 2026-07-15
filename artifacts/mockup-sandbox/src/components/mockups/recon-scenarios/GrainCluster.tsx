import React from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, AlertCircle, Plus, Layers, ChevronRight } from "lucide-react";

// GRAIN OPTION A — ONE ROW PER CLUSTER.
// The whole connected cluster is one work item. Cells hold SETS of records;
// the 4-charge payout deposit is a single row with its records stacked inside.

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const Chip = ({ amount, label, sub, ok, compact }: { amount: number; label: string; sub?: string; ok: boolean; compact?: boolean }) => (
  <div className={`w-full rounded border ${ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"} ${compact ? "px-2 py-1" : "p-2"}`}>
    <div className="flex items-center gap-1.5">
      {ok ? <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" /> : <AlertCircle className="w-3 h-3 text-amber-600 shrink-0" />}
      <span className={`font-semibold ${compact ? "text-[11px]" : "text-xs"} ${ok ? "text-emerald-900" : "text-amber-900"}`}>{fmt(amount)}</span>
      <span className={`${compact ? "text-[10px]" : "text-xs"} font-medium truncate ${ok ? "text-emerald-800" : "text-amber-800"}`}>{label}</span>
    </div>
    {sub && <div className={`text-[9px] mt-0.5 pl-4 leading-tight ${ok ? "text-emerald-700/80" : "text-amber-700"}`}>{sub}</div>}
  </div>
);

const Ghost = ({ label, compact }: { label: string; compact?: boolean }) => (
  <div className={`flex items-center justify-center gap-1 w-full rounded border border-dashed border-slate-200 bg-slate-50/30 text-slate-300 ${compact ? "py-1" : "min-h-10"}`}>
    <Plus className="w-3 h-3" />
    <span className="text-[9px] font-medium uppercase tracking-wider">{label}</span>
  </div>
);

export function GrainCluster() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Grain A — One row per cluster</h1>
          <p className="text-xs text-slate-500 font-medium">The whole cluster is one work item; cells hold sets of records</p>
        </div>
      </header>

      <div className="px-6 py-2.5 bg-white border-b border-slate-100 flex items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
          <CheckCircle2 className="w-3 h-3" /> List length = money events to clear; totals sum cleanly
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">
          <AlertCircle className="w-3 h-3" /> Per-donor progress is buried inside the row — a row can be "¾ done"
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
              {/* Simple 1:1:1 cluster — grain choice doesn't matter here */}
              <TableRow className="hover:bg-slate-50">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="Meadow Fund Commitment" sub="Grant letter on file" ok /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="Wire TR-991" sub="Missing originating bank confirmation" ok={false} /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="DEP-8821 · QB Deposit" sub="4010 Grants · Class: National" ok /></TableCell>
                <TableCell className="align-top py-3 text-right">
                  <span className="inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-800">Partial</span>
                </TableCell>
              </TableRow>

              {/* THE BIG CLUSTER: one deposit, 4 charges, 4 donors — ONE ROW */}
              <TableRow className="bg-blue-50/30 hover:bg-blue-50/40">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3">
                  <div className="space-y-1">
                    <Chip compact amount={500} label="Rivera Family Fund" ok />
                    <Chip compact amount={200} label="Chen Household" ok />
                    <Chip compact amount={25} label="Anna Okafor" ok />
                    <Ghost compact label="1 charge unmatched" />
                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider pt-0.5">3 of 4 matched</div>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <div className="space-y-1">
                    <Chip compact amount={500} label="ch_9Rvra · Stripe" ok />
                    <Chip compact amount={200} label="ch_7Chen · Stripe" ok />
                    <Chip compact amount={25} label="ch_2Okfr · Stripe" ok />
                    <Chip compact amount={99.10} label="ch_4Unkn · Stripe" sub="No donor identified" ok={false} />
                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider pt-0.5">4 charges · {fmt(824.10)}</div>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <Chip amount={824.10} label="DEP-3410 · QB Deposit" sub="Payout deposit · covers all 4 charges" ok />
                  <div className="mt-1.5 text-[9px] text-slate-400 leading-snug">
                    Order implies pairing between the two stacks — the row stays one item of work no matter how much is inside it.
                  </div>
                </TableCell>
                <TableCell className="align-top py-3 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <span className="inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-800">Partial</span>
                    <span className="text-[9px] text-slate-400 font-medium">1 charge unmatched</span>
                  </div>
                </TableCell>
              </TableRow>

              {/* A stray is still just a one-record row */}
              <TableRow className="hover:bg-slate-50">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={75000} label="Prairie Sky Fund" sub="Pledge — expected this month" ok /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link transaction" /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link accounting" /></TableCell>
                <TableCell className="align-top py-3 text-right">
                  <span className="inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800">Unlinked</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed max-w-3xl px-1">
          <span className="font-semibold text-slate-600">Reading:</span> "12 clusters pending" means 12 money events to clear.
          The deposit's four donors live inside one row — good for scanning what's outstanding, weaker when four people
          need to do four different matches inside the same row.
        </div>
      </div>
    </div>
  );
}
