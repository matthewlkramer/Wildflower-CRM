import React from "react";
import {
  CheckCircle2, AlertCircle, AlertTriangle, Layers, MoreHorizontal, Undo2,
  ClipboardList, FileText, ChevronDown, ChevronRight,
} from "lucide-react";

// WORKBENCH V2 — ratified Grain C + owner's synthesis:
// - Right rail: lenses (All unresolved / Needs donor or gift / Needs accounting /
//   Settlement gaps / Conflicts / Refunds / Excluded / Completed) + recent
//   changes with one-click Undo.
// - Cluster header always answers: what money event, how much, is it balanced,
//   how many decisions remain. Metrics strip: Gross · Fees · Bank · Gap · n/m
//   resolved. Never inferred from child rows.
// - TWO independent header indicators: Money (BALANCED/MISMATCH) and
//   Attribution (n/m complete) — "balanced but incomplete" vs "complete but
//   mismatched" are different conditions.
// - Columns: DONOR & PURPOSE · PAYMENT EVIDENCE · BANK & ACCOUNTING.
// - ONE status per grain. Cluster status is a rollup WITH detail
//   ("PARTIAL · 3 of 4 complete · $99.10 unresolved"), child rows carry the
//   transaction statuses. Diagnostic line under every unresolved status.
// - Every unresolved row shows ONE explicit primary action (the specific
//   missing decision); secondary actions live in the ⋯ menu.

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const DbBadge = () => (
  <span title="Matched to Donorbox record" className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-teal-600 text-white text-[7px] font-bold shrink-0">DB</span>
);
const CodingBadge = () => (
  <span title="Coding form attached" className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-slate-200 text-slate-600 shrink-0"><ClipboardList className="w-2.5 h-2.5" /></span>
);
const LetterBadge = () => (
  <span title="Grant letter attached" className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-indigo-100 text-indigo-600 shrink-0"><FileText className="w-2.5 h-2.5" /></span>
);

type ChildStatus = "READY TO APPROVE" | "NEEDS DONOR" | "NEEDS GIFT" | "NEEDS ACCOUNTING" | "AMOUNT MISMATCH" | "CONFLICT" | "DONE";

const childTone: Record<ChildStatus, string> = {
  "DONE": "bg-emerald-100 text-emerald-800",
  "READY TO APPROVE": "bg-blue-100 text-blue-800",
  "NEEDS DONOR": "bg-amber-100 text-amber-800",
  "NEEDS GIFT": "bg-amber-100 text-amber-800",
  "NEEDS ACCOUNTING": "bg-amber-100 text-amber-800",
  "AMOUNT MISMATCH": "bg-red-100 text-red-700",
  "CONFLICT": "bg-red-100 text-red-700",
};

const StatusChip = ({ status }: { status: ChildStatus }) => (
  <span className={`inline-flex px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider whitespace-nowrap ${childTone[status]}`}>{status}</span>
);

const PrimaryAction = ({ children }: { children: React.ReactNode }) => (
  <button className="px-2.5 py-1 rounded-md bg-slate-900 text-white text-[10px] font-semibold whitespace-nowrap hover:bg-slate-700">{children}</button>
);

const Kebab = () => (
  <button title="Exclude · Flag for research · Move to another gift · Split · View source" className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-slate-100">
    <MoreHorizontal className="w-3.5 h-3.5 text-slate-400" />
  </button>
);

const Metric = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="flex flex-col">
    <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
    <span className={`text-[11px] font-semibold tabular-nums ${warn ? "text-red-600" : "text-slate-800"}`}>{value}</span>
  </div>
);

const MoneyBadge = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"}`}>
    {ok ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertTriangle className="w-2.5 h-2.5" />} Money: {label}
  </span>
);
const AttribBadge = ({ done, total }: { done: number; total: number }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${done === total ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"}`}>
    Attribution: {done}/{total} complete
  </span>
);

interface ChildRow {
  donor: React.ReactNode;
  evidence: React.ReactNode;
  bank: React.ReactNode;
  status: ChildStatus;
  diagnostic?: string;
  action?: string;
}

const ColHeads = () => (
  <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_150px_130px] gap-3 px-4 py-1.5 border-b border-slate-100 bg-slate-50/60">
    {["DONOR & PURPOSE", "PAYMENT EVIDENCE", "BANK & ACCOUNTING", "STATUS", "ACTION"].map(h => (
      <span key={h} className={`text-[8px] font-bold uppercase tracking-wider text-slate-400 ${h === "ACTION" ? "text-right" : ""}`}>{h}</span>
    ))}
  </div>
);

const Row = ({ r }: { r: ChildRow }) => (
  <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_150px_130px] gap-3 px-4 py-2 border-b border-slate-50 items-start hover:bg-slate-50/70">
    <div className="text-[11px] leading-snug">{r.donor}</div>
    <div className="text-[11px] leading-snug">{r.evidence}</div>
    <div className="text-[11px] leading-snug">{r.bank}</div>
    <div className="flex flex-col gap-0.5">
      <StatusChip status={r.status} />
      {r.diagnostic && <span className="text-[9px] text-slate-500 leading-tight">{r.diagnostic}</span>}
    </div>
    <div className="flex items-center justify-end gap-1">
      {r.action && <PrimaryAction>{r.action}</PrimaryAction>}
      <Kebab />
    </div>
  </div>
);

const Donor = ({ name, sub, badges }: { name: string; sub: string; badges?: React.ReactNode }) => (
  <div>
    <div className="flex items-center gap-1.5 font-semibold text-slate-800">{name}{badges && <span className="flex gap-1">{badges}</span>}</div>
    <div className="text-[10px] text-slate-500">{sub}</div>
  </div>
);
const Muted = ({ top, sub }: { top: string; sub?: string }) => (
  <div>
    <div className="text-slate-700">{top}</div>
    {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
  </div>
);

export function WorkbenchV2() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Reconciliation Workbench — v2</h1>
          <p className="text-xs text-slate-500 font-medium">Lens rail + honest cluster headers + one status per grain + explicit next actions</p>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* MAIN WORKLIST */}
        <main className="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">

          {/* CLUSTER 1 — balanced but incomplete */}
          <section className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 pt-3 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2 flex-wrap">
                <ChevronDown className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-bold tracking-wide text-slate-800 uppercase">Stripe payout · Dec 27, 2024</span>
                <span className="text-[10px] text-slate-400 font-medium">QBO deposit 31716 · Black Wildflowers Fund</span>
                <span className="ml-auto flex items-center gap-1.5">
                  <MoneyBadge ok label="Balanced" />
                  <AttribBadge done={3} total={4} />
                </span>
              </div>
              <div className="mt-2 flex items-center gap-6">
                <Metric label="Gross" value={fmt(838.18)} />
                <Metric label="Fees" value={fmt(14.08)} />
                <Metric label="Bank" value={fmt(824.10)} />
                <Metric label="Gap" value={fmt(0)} />
                <Metric label="Resolved" value="3 / 4" />
                <span className="ml-auto inline-flex px-2.5 py-1 rounded-md bg-blue-100 text-blue-800 text-[10px] font-bold uppercase tracking-wider">
                  Partial · 3 of 4 complete · {fmt(99.10)} unresolved
                </span>
              </div>
            </div>
            <ColHeads />
            <Row r={{
              donor: <Donor name="Rivera Family Fund · $500.00" sub="Dec 22 · Teacher stipends — Minnesota" badges={<><DbBadge /><CodingBadge /><LetterBadge /></>} />,
              evidence: <Muted top="Stripe ch_9Rvra · $500.00" sub="Dec 22 · Visa ···4242 · recurring" />,
              bank: <Muted top="↳ via payout bundle" sub="settles into deposit 31716" />,
              status: "DONE",
            }} />
            <Row r={{
              donor: <Donor name="Chen Household · $200.00" sub="Dec 23 · Annual fund" badges={<DbBadge />} />,
              evidence: <Muted top="Stripe ch_7Chen · $200.00" sub="Dec 23 · Amex ···1005 · one-time" />,
              bank: <Muted top="↳ via payout bundle" sub="settles into deposit 31716" />,
              status: "DONE",
              diagnostic: "Coding form still missing (non-blocking)",
            }} />
            <Row r={{
              donor: <Donor name="Anna Okafor · $25.00" sub="Dec 24 · GivingTuesday follow-up" badges={<CodingBadge />} />,
              evidence: <Muted top="Stripe ch_2Okfr · $25.00" sub="Dec 24 · Visa ···8812 · first-time" />,
              bank: <Muted top="↳ via payout bundle" sub="settles into deposit 31716" />,
              status: "DONE",
              diagnostic: "Not matched to Donorbox (non-blocking)",
            }} />
            <Row r={{
              donor: <span className="text-slate-400 italic">Unknown donor · {fmt(99.10)}</span>,
              evidence: <Muted top="Stripe ch_4Unkn · $99.10" sub="Dec 26 · Mastercard ···3319" />,
              bank: <Muted top="↳ via payout bundle" sub="settles into deposit 31716" />,
              status: "NEEDS DONOR",
              diagnostic: "No donor identified",
              action: "Choose donor",
            }} />
          </section>

          {/* CLUSTER 2 — ready to approve */}
          <section className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 pt-3 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2 flex-wrap">
                <ChevronRight className="w-4 h-4 text-slate-400" />
                <span className="text-xs font-bold tracking-wide text-slate-800 uppercase">Wire transfer · Dec 20, 2024</span>
                <span className="text-[10px] text-slate-400 font-medium">QBO deposit 31702 · First Horizon → WF operating</span>
                <span className="ml-auto flex items-center gap-1.5">
                  <MoneyBadge ok label="Balanced" />
                  <AttribBadge done={1} total={1} />
                </span>
              </div>
              <div className="mt-2 flex items-center gap-6">
                <Metric label="Gross" value={fmt(150000)} />
                <Metric label="Fees" value={fmt(0)} />
                <Metric label="Bank" value={fmt(150000)} />
                <Metric label="Gap" value={fmt(0)} />
                <Metric label="Resolved" value="1 / 1" />
                <span className="ml-auto inline-flex px-2.5 py-1 rounded-md bg-blue-100 text-blue-800 text-[10px] font-bold uppercase tracking-wider">
                  Ready · all links made · awaiting approval
                </span>
              </div>
            </div>
            <ColHeads />
            <Row r={{
              donor: <Donor name="Meadow Fund Commitment · $150,000.00" sub="FY27 general support · Meadow Fund" badges={<CodingBadge />} />,
              evidence: <Muted top="Wire TR-991 · $150,000.00" sub="Dec 20 · First Horizon" />,
              bank: <Muted top="QBO deposit 31702 · $150,000.00" sub="from bank feed · 4010 Grants · Class: National" />,
              status: "READY TO APPROVE",
              diagnostic: "Grant letter still missing (non-blocking)",
              action: "Approve match",
            }} />
          </section>

          {/* CLUSTER 3 — complete but mismatched */}
          <section className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 pt-3 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2 flex-wrap">
                <ChevronRight className="w-4 h-4 text-slate-400" />
                <span className="text-xs font-bold tracking-wide text-slate-800 uppercase">Check deposit · Dec 18, 2024</span>
                <span className="text-[10px] text-slate-400 font-medium">QBO deposit 31688 · Prairie Sky Fund check #4471</span>
                <span className="ml-auto flex items-center gap-1.5">
                  <MoneyBadge ok={false} label="Mismatch" />
                  <AttribBadge done={1} total={1} />
                </span>
              </div>
              <div className="mt-2 flex items-center gap-6">
                <Metric label="Gross" value={fmt(5000)} />
                <Metric label="Fees" value={fmt(0)} />
                <Metric label="Bank" value={fmt(4986.92)} />
                <Metric label="Gap" value={fmt(13.08)} warn />
                <Metric label="Resolved" value="1 / 1" />
                <span className="ml-auto inline-flex px-2.5 py-1 rounded-md bg-red-100 text-red-700 text-[10px] font-bold uppercase tracking-wider">
                  Conflict · amounts differ by {fmt(13.08)}
                </span>
              </div>
            </div>
            <ColHeads />
            <Row r={{
              donor: <Donor name="Prairie Sky Fund · $5,000.00" sub="Capital campaign pledge payment" badges={<><CodingBadge /><LetterBadge /></>} />,
              evidence: <Muted top="Check #4471 · $5,000.00" sub="Dec 15 · scanned image on file" />,
              bank: <Muted top="QBO deposit 31688 · $4,986.92" sub="from bank feed · bank service charge deducted?" />,
              status: "AMOUNT MISMATCH",
              diagnostic: `Gift amount differs by ${fmt(13.08)}`,
              action: "Resolve conflict",
            }} />
          </section>
        </main>

        {/* RIGHT RAIL — lenses + recent changes */}
        <aside className="w-72 shrink-0 bg-white border-l border-slate-200 overflow-y-auto">
          <div className="p-3 border-b border-slate-100">
            <h2 className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-2">Lenses</h2>
            <nav className="space-y-0.5">
              {([
                ["All unresolved", 12, true],
                ["Needs donor or gift", 5, false],
                ["Needs accounting", 3, false],
                ["Settlement gaps", 2, false],
                ["Conflicts", 1, false],
                ["Refunds", 1, false],
                ["Excluded", 4, false],
                ["Completed", 38, false],
              ] as [string, number, boolean][]).map(([label, count, active]) => (
                <button key={label} className={`flex items-center justify-between w-full px-2.5 py-1.5 rounded-md text-[11px] font-medium ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                  <span>{label}</span>
                  <span className={`text-[10px] tabular-nums font-semibold ${active ? "text-slate-300" : "text-slate-400"}`}>{count}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="p-3">
            <h2 className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-2">Recent changes</h2>
            <div className="space-y-2">
              {[
                ["Linked Chen Household gift → ch_7Chen", "2 min ago"],
                ["Approved Rivera match", "9 min ago"],
                ["Snapshotted coding onto deposit 31716", "24 min ago"],
                ["Excluded duplicate $50.00 charge", "1 hr ago"],
              ].map(([what, when]) => (
                <div key={what} className="flex items-start gap-2 rounded-md border border-slate-100 bg-slate-50/60 px-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-slate-700 leading-snug">{what}</p>
                    <p className="text-[9px] text-slate-400">{when}</p>
                  </div>
                  <button className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-blue-600 hover:text-blue-800 shrink-0 mt-0.5">
                    <Undo2 className="w-2.5 h-2.5" /> Undo
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="p-3 border-t border-slate-100 text-[9px] text-slate-400 leading-relaxed">
            <AlertCircle className="w-3 h-3 inline mr-1" />
            Cluster headers answer: what event, how much, balanced?, decisions left. Money and Attribution are independent — "balanced but incomplete" ≠ "complete but mismatched".
          </div>
        </aside>
      </div>
    </div>
  );
}
