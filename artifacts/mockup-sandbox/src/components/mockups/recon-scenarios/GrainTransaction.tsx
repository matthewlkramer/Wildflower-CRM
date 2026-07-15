import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, AlertCircle, Plus, Layers, ChevronRight } from "lucide-react";

// GRAIN OPTION B — ONE ROW PER TRANSACTION.
// Every row is exactly one decision: match THIS charge to a donor. Shared
// records (the QB deposit covering 4 charges) SPAN their rows instead of
// repeating. Cluster-level completeness lives inside the shared chip.

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

const StatusPill = ({ kind }: { kind: "ok" | "todo" | "partial" }) => {
  const base = "inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider";
  if (kind === "ok") return <span className={`${base} bg-emerald-100 text-emerald-800`}>Matched</span>;
  if (kind === "partial") return <span className={`${base} bg-blue-100 text-blue-800`}>Partial</span>;
  return <span className={`${base} bg-amber-100 text-amber-800`}>Needs match</span>;
};

export function GrainTransaction() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Grain B — One row per transaction</h1>
          <p className="text-xs text-slate-500 font-medium">Every row is one decision; shared records span their rows</p>
        </div>
      </header>

      <div className="px-6 py-2.5 bg-white border-b border-slate-100 flex items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
          <CheckCircle2 className="w-3 h-3" /> One row = one match decision; per-donor status is first-class
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">
          <AlertCircle className="w-3 h-3" /> List inflates; "is the whole deposit settled?" lives in the margin of a spanning cell
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
                <TableHead className="text-right text-xs font-semibold text-slate-600">Row</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Simple 1:1:1 — identical to grain A */}
              <TableRow className="hover:bg-slate-50">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="Meadow Fund Commitment" sub="Grant letter on file" ok /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="Wire TR-991" sub="Missing originating bank confirmation" ok={false} /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={150000} label="DEP-8821 · QB Deposit" sub="4010 Grants · Class: National" ok /></TableCell>
                <TableCell className="align-top py-3 text-right"><StatusPill kind="partial" /></TableCell>
              </TableRow>

              {/* THE BIG CLUSTER: 4 rows, deposit spans all 4 */}
              <TableRow className="bg-blue-50/30 hover:bg-blue-50/40">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={500} label="Rivera Family Fund" sub="Recurring monthly gift" ok /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={500} label="ch_9Rvra · Stripe Charge" ok /></TableCell>
                <TableCell rowSpan={4} className="align-top py-3 border-l border-blue-100 bg-blue-50/20">
                  <div className="rounded border border-slate-300 bg-white p-2 sticky top-2">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span className="text-xs font-semibold text-slate-800">{fmt(824.10)} · DEP-3410 · QB Deposit</span>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1 pl-5 leading-snug">
                      Shared by these 4 rows — one deposit covering 4 charges.
                    </div>
                    <div className="mt-2 pl-5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: "75%" }} />
                        </div>
                        <span className="text-[9px] font-bold text-slate-500">3/4 matched</span>
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3 text-right"><StatusPill kind="ok" /></TableCell>
              </TableRow>
              <TableRow className="bg-blue-50/30 hover:bg-blue-50/40">
                <TableCell className="align-top py-3 pr-0"></TableCell>
                <TableCell className="align-top py-3"><Chip amount={200} label="Chen Household" sub="Annual gift" ok /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={200} label="ch_7Chen · Stripe Charge" ok /></TableCell>
                <TableCell className="align-top py-3 text-right"><StatusPill kind="ok" /></TableCell>
              </TableRow>
              <TableRow className="bg-blue-50/30 hover:bg-blue-50/40">
                <TableCell className="align-top py-3 pr-0"></TableCell>
                <TableCell className="align-top py-3"><Chip amount={25} label="Anna Okafor" sub="First-time donor" ok /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={25} label="ch_2Okfr · Stripe Charge" ok /></TableCell>
                <TableCell className="align-top py-3 text-right"><StatusPill kind="ok" /></TableCell>
              </TableRow>
              <TableRow className="bg-blue-50/30 hover:bg-blue-50/40">
                <TableCell className="align-top py-3 pr-0"></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link who & why" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={99.10} label="ch_4Unkn · Stripe Charge" sub="No donor identified" ok={false} /></TableCell>
                <TableCell className="align-top py-3 text-right"><StatusPill kind="todo" /></TableCell>
              </TableRow>

              {/* A stray is still one row */}
              <TableRow className="hover:bg-slate-50">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3"><Chip amount={75000} label="Prairie Sky Fund" sub="Pledge — expected this month" ok /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link transaction" /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link accounting" /></TableCell>
                <TableCell className="align-top py-3 text-right"><StatusPill kind="todo" /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed max-w-3xl px-1">
          <span className="font-semibold text-slate-600">Reading:</span> "16 rows pending" counts match decisions, not
          money events. Each of the deposit's donors gets their own row and status — but the deposit itself has no row,
          so its "am I done?" indicator has to ride inside the spanning chip.
        </div>
      </div>
    </div>
  );
}
