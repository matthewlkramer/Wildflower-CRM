import React from "react";
import {
  CheckCircle2, AlertCircle, AlertTriangle, Layers, MoreHorizontal, Undo2,
  ClipboardList, FileText, ChevronDown, ChevronRight,
} from "lucide-react";

// WORKBENCH V2b — HYBRID: the ratified Grain C continuous table body
// (columns stay aligned across every cluster, minimal chrome, fast vertical
// scanning) + the v2 cluster header as a full-width BAND row instead of a
// separate card. Same rail, same statuses, same primary actions as v2.
// The question this mockup answers: do we need cards at all, or does the
// header band inside one continuous table carry the same information with
// better scannability?

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

const GRID = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_150px_130px] gap-3 px-4";

interface ChildRow {
  donor: React.ReactNode;
  evidence: React.ReactNode;
  bank: React.ReactNode;
  status: ChildStatus;
  diagnostic?: string;
  action?: string;
}

const Row = ({ r }: { r: ChildRow }) => (
  <div className={`${GRID} py-2 border-b border-slate-50 items-start hover:bg-slate-50/70`}>
    <div className="text-[11px] leading-snug pl-4">{r.donor}</div>
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

const Band = ({ open, title, refLine, metrics, moneyOk, moneyLabel, attribDone, attribTotal, rollup, rollupTone }: {
  open: boolean; title: string; refLine: string;
  metrics: [string, string, boolean?][];
  moneyOk: boolean; moneyLabel: string; attribDone: number; attribTotal: number;
  rollup: string; rollupTone: "blue" | "red";
}) => (
  <div className="px-4 py-2 bg-slate-100/90 border-y border-slate-200">
    <div className="flex items-center gap-2 flex-wrap">
      {open ? <ChevronDown className="w-4 h-4 text-blue-500" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      <span className="text-xs font-bold tracking-wide text-slate-800 uppercase">{title}</span>
      <span className="text-[10px] text-slate-400 font-medium">{refLine}</span>
      <span className="ml-auto flex items-center gap-1.5">
        <MoneyBadge ok={moneyOk} label={moneyLabel} />
        <AttribBadge done={attribDone} total={attribTotal} />
      </span>
    </div>
    <div className="mt-1 flex items-center gap-5">
      {metrics.map(([label, value, warn]) => (
        <span key={label} className="text-[10px]">
          <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400 mr-1">{label}</span>
          <span className={`font-semibold tabular-nums ${warn ? "text-red-600" : "text-slate-800"}`}>{value}</span>
        </span>
      ))}
      <span className={`ml-auto inline-flex px-2.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider ${rollupTone === "blue" ? "bg-blue-100 text-blue-800" : "bg-red-100 text-red-700"}`}>
        {rollup}
      </span>
    </div>
  </div>
);

export function WorkbenchHybrid() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Reconciliation Workbench — v2b (continuous table)</h1>
          <p className="text-xs text-slate-500 font-medium">Grain C table body + v2 header bands — columns stay aligned across clusters, less chrome</p>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 overflow-y-auto p-4 min-w-0">
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className={`${GRID} py-1.5 border-b border-slate-100 bg-slate-50/60 sticky top-0 z-10`}>
              {["DONOR & PURPOSE", "PAYMENT EVIDENCE", "BANK & ACCOUNTING", "STATUS", "ACTION"].map(h => (
                <span key={h} className={`text-[8px] font-bold uppercase tracking-wider text-slate-400 ${h === "ACTION" ? "text-right" : ""}`}>{h}</span>
              ))}
            </div>

            {/* CLUSTER 1 — balanced but incomplete */}
            <Band open title="Stripe payout · Dec 27, 2024" refLine="QBO deposit 31716 · Black Wildflowers Fund"
              metrics={[["Gross", fmt(838.18)], ["Fees", fmt(14.08)], ["Bank", fmt(824.10)], ["Gap", fmt(0)], ["Resolved", "3 / 4"]]}
              moneyOk moneyLabel="Balanced" attribDone={3} attribTotal={4}
              rollup={`Partial · 3 of 4 complete · ${fmt(99.10)} unresolved`} rollupTone="blue" />
            <Row r={{
              donor: <Donor name="Rivera Family Fund · $500.00" sub="Dec 22 · Teacher stipends — Minnesota" badges={<><DbBadge /><CodingBadge /><LetterBadge /></>} />,
              evidence: <Muted top="Stripe ch_9Rvra · $500.00" sub="Dec 22 · Visa ···4242 · recurring" />,
              bank: <Muted top="↳ via payout bundle" sub="settles into deposit 31716" />,
              status: "DONE",
            }} />
            <Row r={{
              donor: <Donor name="Chen Household · $200.00" sub="Dec 23 · Annual fund" badges={<DbBadge />} />,
              evidence: <Muted top="Stripe ch_7Chen · $200.00" sub="Dec 23 · Amex ···1005 · one-time" />,
              bank: <Muted top="↳ via payout bundle" sub="QB payer shows 'PayPal Giving' — corrected in CRM, QB fix pending" />,
              status: "DONE",
              diagnostic: "QB record needs correction (payer name)",
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

            {/* CLUSTER 2 — ready to approve */}
            <Band open={false} title="Wire transfer · Dec 20, 2024" refLine="QBO deposit 31702 · First Horizon → WF operating"
              metrics={[["Gross", fmt(150000)], ["Fees", fmt(0)], ["Bank", fmt(150000)], ["Gap", fmt(0)], ["Resolved", "1 / 1"]]}
              moneyOk moneyLabel="Balanced" attribDone={1} attribTotal={1}
              rollup="Ready · all links made · awaiting approval" rollupTone="blue" />
            <Row r={{
              donor: <Donor name="Meadow Fund Commitment · $150,000.00" sub="FY27 general support · Meadow Fund" badges={<CodingBadge />} />,
              evidence: <Muted top="Wire TR-991 · $150,000.00" sub="Dec 20 · First Horizon" />,
              bank: <Muted top="QBO deposit 31702 · $150,000.00" sub="from bank feed · 4010 Grants · Class: National" />,
              status: "READY TO APPROVE",
              diagnostic: "Grant letter still missing (non-blocking)",
              action: "Approve match",
            }} />

            {/* CLUSTER 3 — complete but mismatched */}
            <Band open={false} title="Check deposit · Dec 18, 2024" refLine="QBO deposit 31688 · Prairie Sky Fund check #4471"
              metrics={[["Gross", fmt(5000)], ["Fees", fmt(0)], ["Bank", fmt(4986.92)], ["Gap", fmt(13.08), true], ["Resolved", "1 / 1"]]}
              moneyOk={false} moneyLabel="Mismatch" attribDone={1} attribTotal={1}
              rollup={`Conflict · amounts differ by ${fmt(13.08)}`} rollupTone="red" />
            <Row r={{
              donor: <Donor name="Prairie Sky Fund · $5,000.00" sub="Capital campaign pledge payment" badges={<><CodingBadge /><LetterBadge /></>} />,
              evidence: <Muted top="Check #4471 · $5,000.00" sub="Dec 15 · scanned image on file" />,
              bank: <Muted top="QBO deposit 31688 · $4,986.92" sub="from bank feed · bank service charge deducted?" />,
              status: "AMOUNT MISMATCH",
              diagnostic: `Gift amount differs by ${fmt(13.08)}`,
              action: "Resolve conflict",
            }} />

            {/* CLUSTER 4 — excluded but QB disagrees */}
            <Band open={false} title="ACH deposit · Dec 12, 2024" refLine="QBO deposit 31654 · coded 4010 Grants"
              metrics={[["Gross", fmt(1200)], ["Fees", fmt(0)], ["Bank", fmt(1200)], ["Gap", fmt(0)], ["Resolved", "—"]]}
              moneyOk moneyLabel="Balanced" attribDone={0} attribTotal={0}
              rollup="Excluded · QB says donation" rollupTone="red" />
            <Row r={{
              donor: <span className="text-slate-400 italic">Not a donation — facility rental reimbursement</span>,
              evidence: <Muted top="ACH · $1,200.00" sub="Dec 12 · Minnesota Wildflower PTO" />,
              bank: <Muted top="QBO deposit 31654 · $1,200.00" sub="coded 4010 Grants · Class: Minnesota" />,
              status: "NEEDS ACCOUNTING",
              diagnostic: "Excluded from workbench, but QB codes it as a donation — QB recode needed",
              action: "Flag QB recode",
            }} />
          </div>
        </main>

        {/* RIGHT RAIL */}
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
                ["QB record needs correction", 2, false],
                ["Excluded · QB says donation", 1, false],
                ["Excluded", 4, false],
                ["Completed", 38, false],
              ] as [string, number, boolean][]).map(([label, count, active]) => (
                <button key={label} className={`flex items-center justify-between w-full px-2.5 py-1.5 rounded-md text-[11px] font-medium ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                  <span>{label}</span>
                  <span className={`text-[10px] tabular-nums font-semibold ${active ? "text-slate-300" : "text-slate-400"}`}>{count}</span>
                </button>
              ))}
            </nav>
            <p className="text-[9px] text-slate-400 mt-2 leading-snug">
              The two QB lenses are the bookkeeper's punch list — the CRM never writes back to QuickBooks, so "QB is wrong" items queue here until a human fixes QB.
            </p>
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
            Same information as v2 — but one continuous surface: header bands replace cards, so columns align across every cluster.
          </div>
        </aside>
      </div>
    </div>
  );
}
