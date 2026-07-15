import React from "react";
import {
  AlertCircle, Layers, MoreHorizontal, Undo2, ClipboardList, FileText,
  ChevronDown, ChevronRight, CornerDownRight, Plus, Check,
} from "lucide-react";

// WORKBENCH V3 — back to the ratified 9c (Grain C adaptive) as the base:
// the CLUSTER is the row and the three facets are the axis — a CRM gift or
// pledge with no QB payment yet is a first-class row with "+ link" slots,
// never forced under a QB-payment header. Folded in from 10/12:
// - right rail (lenses incl. the two QB-correction lenses + recent changes
//   with Undo)
// - the cluster header math (gross − fees = net = bank · gap) as ONE inline
//   line inside the expanded cluster, not a band of chips
// - one status per grain with rollup detail + diagnostic
// - explicit primary action naming the missing decision
// - renamed columns
// CALM STATUS treatment (replaces the chip pile): each grain gets ONE
// colored dot + short word, with muted detail text under it. Money and
// attribution facts live in plain text, not stacked badges.

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

type Tone = "green" | "amber" | "red" | "blue" | "slate";

const dotColor: Record<Tone, string> = {
  green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500",
  blue: "bg-blue-500", slate: "bg-slate-400",
};
const wordColor: Record<Tone, string> = {
  green: "text-emerald-700", amber: "text-amber-700", red: "text-red-700",
  blue: "text-blue-700", slate: "text-slate-500",
};

// ONE status per grain: a dot + word, detail in muted text underneath.
const Status = ({ tone, word, detail, action, actionLabel }: {
  tone: Tone; word: string; detail?: string; action?: boolean; actionLabel?: string;
}) => (
  <div className="flex flex-col gap-1 items-start">
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${wordColor[tone]}`}>
      <span className={`w-2 h-2 rounded-full ${dotColor[tone]} shrink-0`} /> {word}
    </span>
    {detail && <span className="text-[9px] text-slate-500 leading-tight">{detail}</span>}
    {action && <button className="mt-0.5 px-2.5 py-1 rounded-md bg-slate-900 text-white text-[10px] font-semibold whitespace-nowrap hover:bg-slate-700">{actionLabel}</button>}
  </div>
);

const Kebab = () => (
  <button title="Exclude · Flag for research · Move to another gift · Split · View source" className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-slate-100 shrink-0">
    <MoreHorizontal className="w-3.5 h-3.5 text-slate-400" />
  </button>
);

// Facet mini-card, 9c style: tone border/bg + amount/name + sub line +
// its own standalone completeness line (separate from linkage).
const Card = ({ tone, amount, name, sub, gap, badges }: {
  tone: "green" | "amber"; amount: string; name: string; sub: string; gap?: string; badges?: React.ReactNode;
}) => (
  <div className={`rounded-md border px-2.5 py-1.5 ${tone === "green" ? "border-emerald-200 bg-emerald-50/50" : "border-amber-300 bg-amber-50/60"}`}>
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-bold text-slate-800 tabular-nums">{amount}</span>
      <span className="text-[11px] font-semibold text-slate-700 truncate">{name}</span>
      {badges && <span className="flex gap-1 ml-auto">{badges}</span>}
    </div>
    <div className="text-[10px] text-slate-500 leading-snug">{sub}</div>
    {gap && <div className="text-[10px] font-semibold text-amber-700 leading-snug">{gap}</div>}
  </div>
);

const LinkSlot = ({ label }: { label: string }) => (
  <button className="w-full rounded-md border border-dashed border-slate-300 px-2.5 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide hover:border-slate-400 hover:text-slate-500 flex items-center justify-center gap-1">
    <Plus className="w-3 h-3" /> {label}
  </button>
);

const Summary = ({ lines, gap }: { lines: string[]; gap?: string }) => (
  <div className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5">
    {lines.map((l, i) => (
      <div key={l} className={`text-[10.5px] leading-snug ${i === 0 ? "font-semibold text-slate-800" : "text-slate-500"}`}>{l}</div>
    ))}
    {gap && <div className="text-[10px] font-semibold text-amber-700 leading-snug">{gap}</div>}
  </div>
);

const GRID = "grid grid-cols-[26px_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_190px_30px] gap-3 px-4 items-start";

export function WorkbenchV3() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Reconciliation Workbench — v3</h1>
          <p className="text-xs text-slate-500 font-medium">9c cluster-first body (CRM gifts stand alone without QB) + rail, inline money math, one calm status per grain</p>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 overflow-y-auto p-4 min-w-0">
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className={`${GRID} py-1.5 border-b border-slate-100 bg-slate-50/60 sticky top-0 z-10`}>
              <span />
              {["DONOR & PURPOSE", "PAYMENT EVIDENCE", "BANK & ACCOUNTING", "STATUS & NEXT STEP"].map(h => (
                <span key={h} className="text-[8px] font-bold uppercase tracking-wider text-slate-400">{h}</span>
              ))}
              <span />
            </div>

            {/* 1 — simple 1:1:1, ready to approve */}
            <div className={`${GRID} py-2.5 border-b border-slate-100 hover:bg-slate-50/60`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <Card tone="amber" amount={fmt(150000)} name="Meadow Fund Commitment" sub="FY27 general support · Meadow Fund" gap="Missing grant letter" badges={<CodingBadge />} />
              <Card tone="green" amount={fmt(150000)} name="Wire TR-991" sub="Dec 20 · First Horizon → WF operating" />
              <Card tone="green" amount={fmt(150000)} name="DEP 31702" sub="from bank feed · 4010 Grants · Class: National" />
              <Status tone="blue" word="Ready to approve" detail="all links made · grant letter missing (non-blocking)" action actionLabel="Approve match" />
              <Kebab />
            </div>

            {/* 2 — Stripe payout bundle, EXPANDED */}
            <div className={`${GRID} pt-2.5 pb-1 bg-blue-50/20`}>
              <ChevronDown className="w-4 h-4 text-blue-500 mt-2" />
              <Summary lines={["3 gifts · $725.00 — cover 3 of 4 charges", "in this Stripe payout bundle"]} gap="1 charge ($99.10) has no gift yet" />
              <Summary lines={["4 Stripe charges · one payout · Dec 27", "$838.18 gross · $14.08 fees · $824.10 net"]} />
              <Summary lines={["PMT-2291 · $838.18 gross charges", "FEE-1108 · −$14.08 processing fee"]} gap="Missing class coding on the fee" />
              <Status tone="blue" word="Partial" detail="3 of 4 complete · $99.10 unresolved" />
              <Kebab />
            </div>
            {/* inline money math — replaces the chip band */}
            <div className="pl-[52px] pr-4 pb-2 bg-blue-50/20">
              <p className="text-[10px] text-slate-500 font-mono">
                <Check className="w-3 h-3 inline text-emerald-600 mr-1" />
                gross $838.18 − fees $14.08 = net $824.10 = bank deposit 31716 · gap $0.00 — money balanced · attribution 3/4
              </p>
            </div>
            {[
              {
                donor: <Card tone="green" amount={fmt(500)} name="Rivera Family Fund" sub="Dec 22 · Teacher stipends — Minnesota" badges={<><DbBadge /><CodingBadge /><LetterBadge /></>} />,
                evidence: <Card tone="green" amount={fmt(500)} name="ch_9Rvra · Stripe" sub="Dec 22 · Visa ···4242 · recurring" />,
                status: <Status tone="green" word="Done" />,
              },
              {
                donor: <Card tone="green" amount={fmt(200)} name="Chen Household" sub="Dec 23 · Annual fund" badges={<DbBadge />} />,
                evidence: <Card tone="green" amount={fmt(200)} name="ch_7Chen · Stripe" sub="Dec 23 · Amex ···1005 · one-time" />,
                status: <Status tone="green" word="Done" detail="QB payer name wrong ('PayPal Giving') — QB fix pending" />,
              },
              {
                donor: <Card tone="green" amount={fmt(25)} name="Anna Okafor" sub="Dec 24 · GivingTuesday follow-up" badges={<CodingBadge />} />,
                evidence: <Card tone="green" amount={fmt(25)} name="ch_2Okfr · Stripe" sub="Dec 24 · Visa ···8812 · first-time" />,
                status: <Status tone="green" word="Done" detail="not matched to Donorbox (non-blocking)" />,
              },
              {
                donor: <LinkSlot label="Choose donor" />,
                evidence: <Card tone="amber" amount={fmt(99.10)} name="ch_4Unkn · Stripe" sub="Dec 26 · Mastercard ···3319" gap="No donor identified" />,
                status: <Status tone="amber" word="Needs donor" detail="No donor identified" action actionLabel="Choose donor" />,
              },
            ].map((r, i) => (
              <div key={i} className={`${GRID} py-2 border-b border-slate-50 bg-blue-50/20 last-of-type:border-slate-100`}>
                <CornerDownRight className="w-3.5 h-3.5 text-slate-300 ml-2 mt-2" />
                <div className="pl-4">{r.donor}</div>
                {r.evidence}
                <div className="text-[10px] text-slate-400 pt-2 pl-1">↳ part of the payout bundle above</div>
                {r.status}
                <Kebab />
              </div>
            ))}

            {/* 3 — complete but mismatched */}
            <div className={`${GRID} py-2.5 border-b border-slate-100 hover:bg-slate-50/60`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <Card tone="green" amount={fmt(5000)} name="Prairie Sky Fund" sub="Capital campaign pledge payment" badges={<><CodingBadge /><LetterBadge /></>} />
              <Card tone="green" amount={fmt(5000)} name="Check #4471" sub="Dec 15 · scanned image on file" />
              <Card tone="amber" amount={fmt(4986.92)} name="DEP 31688" sub="from bank feed · bank service charge deducted?" gap="$13.08 short of the check" />
              <Status tone="red" word="Conflict" detail="gift amount differs by $13.08 — complete but mismatched" action actionLabel="Resolve conflict" />
              <Kebab />
            </div>

            {/* 4 — CRM pledge with NO money yet: first-class row, not under any QB axis */}
            <div className={`${GRID} py-2.5 border-b border-slate-100 hover:bg-slate-50/60`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <Card tone="green" amount={fmt(75000)} name="Oak Grove Fund — pledge" sub="expected this month · capital campaign" badges={<LetterBadge />} />
              <LinkSlot label="Link payment evidence" />
              <LinkSlot label="Link bank & accounting" />
              <Status tone="slate" word="Unlinked" detail="no money received yet — nothing to reconcile" />
              <Kebab />
            </div>

            {/* 5 — excluded, but QB coded it as a donation */}
            <div className={`${GRID} py-2.5 hover:bg-slate-50/60 opacity-90`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                <div className="text-[11px] font-medium text-slate-500 italic">Not a donation</div>
                <div className="text-[10px] text-slate-400">facility rental reimbursement</div>
              </div>
              <Card tone="green" amount={fmt(1200)} name="ACH · Minnesota Wildflower PTO" sub="Dec 12" />
              <Card tone="amber" amount={fmt(1200)} name="DEP 31654" sub="coded 4010 Grants · Class: Minnesota" gap="QB codes it as a donation" />
              <Status tone="red" word="Excluded · QB disagrees" detail="excluded from workbench, but QB books it as a donation" action actionLabel="Flag QB recode" />
              <Kebab />
            </div>
          </div>

          <p className="text-[10px] text-slate-400 mt-3 leading-relaxed px-1">
            <span className="font-semibold text-slate-500">Reading:</span> each row is a cluster of the three facets — any facet can be empty (dashed "+ link" slot), so a pledge awaiting money is a normal row, not an orphan of a QB payment. One dot per grain replaces the chip pile: the word is the status, the muted line under it is the why (diagnostic) or the rollup detail. The expanded bundle carries its money math as one inline line — gross − fees = net = bank — instead of a metrics band.
          </p>
        </main>

        {/* RIGHT RAIL — unchanged from 10/12 (the part that works) */}
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
            The two QB lenses are the bookkeeper's punch list — the CRM never writes back to QuickBooks, so "QB is wrong" items queue until a human fixes QB.
          </div>
        </aside>
      </div>
    </div>
  );
}
