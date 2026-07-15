import React, { useState } from "react";
import {
  AlertCircle, Layers, MoreHorizontal, Undo2, ClipboardList, FileText,
  ChevronDown, ChevronRight, CornerDownRight, Plus, Check, Link2, Search,
  Sparkles, Lock, X,
} from "lucide-react";

// WORKBENCH V4 — v3 (9c cluster-first base + rail + calm status) plus the
// three requested refinements:
// 1. Per-CARD action menus (⋯ on each facet card) for actions that belong to
//    that record alone; the row-level kebab keeps cluster-wide actions.
// 2. Lenses split: "Needs donor or gift" → "Missing donor" + "Donor record
//    missing key info"; same split applied to the accounting lens →
//    "Missing accounting record" + "Accounting record missing key info".
// 3. The unknown-charge donor slot offers THREE actions — Link CRM donation
//    record / Create CRM donation record / Identify donor — and "Create"
//    opens a dialog prefilled from the Stripe charge (opens by default here
//    so it's visible; Cancel closes it, the button reopens it).

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

// Row-level kebab: CLUSTER-wide actions only.
const RowKebab = () => (
  <button title="Cluster actions: approve match · split cluster · exclude all · history" className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-slate-100 shrink-0">
    <MoreHorizontal className="w-3.5 h-3.5 text-slate-400" />
  </button>
);

// Card-level action menu — actions that belong to THIS record, not the row.
const CardMenu = ({ items, defaultOpen }: { items: string[]; defaultOpen?: boolean }) => {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <span className="relative shrink-0 ml-1">
      <button onClick={() => setOpen(o => !o)} className={`inline-flex items-center justify-center w-4.5 h-4.5 w-[18px] h-[18px] rounded ${open ? "bg-slate-200" : "hover:bg-slate-200/70"}`}>
        <MoreHorizontal className="w-3 h-3 text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-30 w-44 rounded-md border border-slate-200 bg-white shadow-lg py-1">
          {items.map(it => (
            <button key={it} onClick={() => setOpen(false)} className="block w-full text-left px-2.5 py-1 text-[10px] text-slate-700 hover:bg-slate-50">{it}</button>
          ))}
        </div>
      )}
    </span>
  );
};

const Card = ({ tone, amount, name, sub, gap, badges, menu, menuOpen }: {
  tone: "green" | "amber"; amount: string; name: string; sub: string; gap?: string;
  badges?: React.ReactNode; menu?: string[]; menuOpen?: boolean;
}) => (
  <div className={`relative rounded-md border px-2.5 py-1.5 ${tone === "green" ? "border-emerald-200 bg-emerald-50/50" : "border-amber-300 bg-amber-50/60"}`}>
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-bold text-slate-800 tabular-nums">{amount}</span>
      <span className="text-[11px] font-semibold text-slate-700 truncate">{name}</span>
      <span className="flex items-center gap-1 ml-auto">
        {badges}
        {menu && <CardMenu items={menu} defaultOpen={menuOpen} />}
      </span>
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

// Card-level menus by facet type
const GIFT_MENU = ["Open gift record", "Edit allocations", "Unlink from this match", "Move to another cluster"];
const STRIPE_MENU = ["View in Stripe", "View receipt", "Exclude — not a donation", "Move to another cluster", "Flag for research"];
const WIRE_MENU = ["View wire detail", "Exclude — not a donation", "Move to another cluster", "Flag for research"];
const CHECK_MENU = ["View scanned check", "Exclude — not a donation", "Move to another cluster", "Flag for research"];
const QB_MENU = ["View in QuickBooks", "Flag QB recode", "Unlink from this match", "Flag for research"];

// The three donor-slot actions for an unidentified charge
const DonorActions = ({ onCreate }: { onCreate: () => void }) => (
  <div className="flex flex-col gap-1">
    {[
      { icon: <Link2 className="w-3 h-3" />, label: "Link CRM donation record", onClick: undefined },
      { icon: <Plus className="w-3 h-3" />, label: "Create CRM donation record", onClick: onCreate },
      { icon: <Search className="w-3 h-3" />, label: "Identify donor", onClick: undefined },
    ].map(a => (
      <button key={a.label} onClick={a.onClick}
        className="w-full rounded-md border border-dashed border-slate-300 px-2 py-1 text-[9.5px] font-semibold text-slate-500 hover:border-slate-400 hover:text-slate-700 hover:bg-slate-50 flex items-center gap-1.5">
        {a.icon} {a.label}
      </button>
    ))}
  </div>
);

const Field = ({ label, value, empty, locked, hint }: {
  label: string; value?: string; empty?: boolean; locked?: boolean; hint?: string;
}) => (
  <div>
    <div className="text-[9px] font-bold uppercase tracking-wide text-slate-400 mb-0.5 flex items-center gap-1">
      {label} {locked && <Lock className="w-2.5 h-2.5" />}
    </div>
    <div className={`rounded-md border px-2.5 py-1.5 text-[11px] ${
      empty ? "border-amber-400 bg-amber-50/60 text-slate-400 italic"
        : locked ? "border-slate-200 bg-slate-50 text-slate-600"
        : "border-slate-300 bg-white text-slate-800 font-medium"}`}>
      {value ?? "—"}
    </div>
    {hint && <div className="text-[9px] text-slate-400 mt-0.5 leading-snug">{hint}</div>}
  </div>
);

const CreateGiftDialog = ({ onClose }: { onClose: () => void }) => (
  <div className="fixed inset-0 z-40 flex items-center justify-center">
    <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
    <div className="relative z-50 w-[440px] rounded-lg bg-white shadow-2xl border border-slate-200">
      <div className="px-4 py-3 border-b border-slate-100 flex items-start gap-2">
        <div className="flex-1">
          <h3 className="text-[13px] font-semibold text-slate-900">New donation record</h3>
          <p className="text-[10px] text-slate-500 flex items-center gap-1 mt-0.5">
            <Sparkles className="w-3 h-3 text-blue-500" /> Prefilled from Stripe charge ch_4Unkn — only the donor is missing
          </p>
        </div>
        <button onClick={onClose} className="w-6 h-6 rounded hover:bg-slate-100 inline-flex items-center justify-center">
          <X className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>
      <div className="p-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Donor" empty value="Search organizations, people, households…"
            hint="Required — no donor identified on the charge. 'Identify donor' suggestions appear here." />
        </div>
        <Field label="Amount" value="$99.10" />
        <Field label="Date received" value="Dec 26, 2024" />
        <Field label="Payment method" value="Card · Mastercard ···3319" />
        <Field label="Type" value="Donation" />
        <div className="col-span-2">
          <Field label="Source" locked value="Stripe charge ch_4Unkn → payout Dec 27 → bank deposit 31716"
            hint="Created from the charge, so the link is made automatically — this row leaves 'Missing donor' the moment you save." />
        </div>
        <div className="col-span-2">
          <Field label="Memo" value="GIVINGTUESDAY WF DONATION (statement descriptor)" />
        </div>
      </div>
      <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
        <p className="text-[9px] text-slate-400 leading-snug max-w-[210px]">A starter allocation is seeded; coding derives once the donor is set.</p>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-slate-200 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>
          <button disabled className="px-3 py-1.5 rounded-md bg-slate-300 text-white text-[11px] font-semibold cursor-not-allowed" title="Pick a donor first">Create & link to charge</button>
        </div>
      </div>
    </div>
  </div>
);

const GRID = "grid grid-cols-[26px_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_190px_30px] gap-3 px-4 items-start";

export function WorkbenchV4() {
  const [dialogOpen, setDialogOpen] = useState(true);
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      {dialogOpen && <CreateGiftDialog onClose={() => setDialogOpen(false)} />}
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Reconciliation Workbench — v4</h1>
          <p className="text-xs text-slate-500 font-medium">v3 + per-card action menus · split lenses · 3-action donor slot with prefilled create dialog</p>
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
              <Card tone="amber" amount={fmt(150000)} name="Meadow Fund Commitment" sub="FY27 general support · Meadow Fund" gap="Missing grant letter" badges={<CodingBadge />} menu={GIFT_MENU} />
              <Card tone="green" amount={fmt(150000)} name="Wire TR-991" sub="Dec 20 · First Horizon → WF operating" menu={WIRE_MENU} />
              <Card tone="green" amount={fmt(150000)} name="DEP 31702" sub="from bank feed · 4010 Grants · Class: National" menu={QB_MENU} />
              <Status tone="blue" word="Ready to approve" detail="all links made · grant letter missing (non-blocking)" action actionLabel="Approve match" />
              <RowKebab />
            </div>

            {/* 2 — Stripe payout bundle, EXPANDED */}
            <div className={`${GRID} pt-2.5 pb-1 bg-blue-50/20`}>
              <ChevronDown className="w-4 h-4 text-blue-500 mt-2" />
              <Summary lines={["3 gifts · $725.00 — cover 3 of 4 charges", "in this Stripe payout bundle"]} gap="1 charge ($99.10) has no gift yet" />
              <Summary lines={["4 Stripe charges · one payout · Dec 27", "$838.18 gross · $14.08 fees · $824.10 net"]} />
              <Summary lines={["PMT-2291 · $838.18 gross charges", "FEE-1108 · −$14.08 processing fee"]} gap="Missing class coding on the fee" />
              <Status tone="blue" word="Partial" detail="3 of 4 complete · $99.10 unresolved" />
              <RowKebab />
            </div>
            <div className="pl-[52px] pr-4 pb-2 bg-blue-50/20">
              <p className="text-[10px] text-slate-500 font-mono">
                <Check className="w-3 h-3 inline text-emerald-600 mr-1" />
                gross $838.18 − fees $14.08 = net $824.10 = bank deposit 31716 · gap $0.00 — money balanced · attribution 3/4
              </p>
            </div>
            {[
              {
                donor: <Card tone="green" amount={fmt(500)} name="Rivera Family Fund" sub="Dec 22 · Teacher stipends — Minnesota" badges={<><DbBadge /><CodingBadge /><LetterBadge /></>} menu={GIFT_MENU} />,
                evidence: <Card tone="green" amount={fmt(500)} name="ch_9Rvra · Stripe" sub="Dec 22 · Visa ···4242 · recurring" menu={STRIPE_MENU} />,
                status: <Status tone="green" word="Done" />,
              },
              {
                donor: <Card tone="green" amount={fmt(200)} name="Chen Household" sub="Dec 23 · Annual fund" badges={<DbBadge />} menu={GIFT_MENU} />,
                evidence: <Card tone="green" amount={fmt(200)} name="ch_7Chen · Stripe" sub="Dec 23 · Amex ···1005 · one-time" menu={STRIPE_MENU} />,
                status: <Status tone="green" word="Done" detail="QB payer name wrong ('PayPal Giving') — QB fix pending" />,
              },
              {
                donor: <Card tone="green" amount={fmt(25)} name="Anna Okafor" sub="Dec 24 · GivingTuesday follow-up" badges={<CodingBadge />} menu={GIFT_MENU} />,
                evidence: <Card tone="green" amount={fmt(25)} name="ch_2Okfr · Stripe" sub="Dec 24 · Visa ···8812 · first-time" menu={STRIPE_MENU} />,
                status: <Status tone="green" word="Done" detail="not matched to Donorbox (non-blocking)" />,
              },
              {
                donor: <DonorActions onCreate={() => setDialogOpen(true)} />,
                evidence: <Card tone="amber" amount={fmt(99.10)} name="ch_4Unkn · Stripe" sub="Dec 26 · Mastercard ···3319" gap="No donor identified" menu={STRIPE_MENU} />,
                status: <Status tone="amber" word="Missing donor" detail="pick an action at left — create opens a prefilled gift" />,
              },
            ].map((r, i) => (
              <div key={i} className={`${GRID} py-2 border-b border-slate-50 bg-blue-50/20 last-of-type:border-slate-100`}>
                <CornerDownRight className="w-3.5 h-3.5 text-slate-300 ml-2 mt-2" />
                <div className="pl-4">{r.donor}</div>
                {r.evidence}
                <div className="text-[10px] text-slate-400 pt-2 pl-1">↳ part of the payout bundle above</div>
                {r.status}
                <RowKebab />
              </div>
            ))}

            {/* 3 — complete but mismatched; QB card's menu shown OPEN as the demo */}
            <div className={`${GRID} py-2.5 border-b border-slate-100 hover:bg-slate-50/60`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <Card tone="green" amount={fmt(5000)} name="Prairie Sky Fund" sub="Capital campaign pledge payment" badges={<><CodingBadge /><LetterBadge /></>} menu={GIFT_MENU} />
              <Card tone="green" amount={fmt(5000)} name="Check #4471" sub="Dec 15 · scanned image on file" menu={CHECK_MENU} />
              <Card tone="amber" amount={fmt(4986.92)} name="DEP 31688" sub="from bank feed · bank service charge deducted?" gap="$13.08 short of the check" menu={QB_MENU} menuOpen />
              <Status tone="red" word="Conflict" detail="gift amount differs by $13.08 — complete but mismatched" action actionLabel="Resolve conflict" />
              <RowKebab />
            </div>

            {/* 4 — CRM pledge with NO money yet */}
            <div className={`${GRID} py-2.5 border-b border-slate-100 hover:bg-slate-50/60`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <Card tone="green" amount={fmt(75000)} name="Oak Grove Fund — pledge" sub="expected this month · capital campaign" badges={<LetterBadge />} menu={GIFT_MENU} />
              <LinkSlot label="Link payment evidence" />
              <LinkSlot label="Link bank & accounting" />
              <Status tone="slate" word="Unlinked" detail="no money received yet — nothing to reconcile" />
              <RowKebab />
            </div>

            {/* 5 — excluded, but QB coded it as a donation */}
            <div className={`${GRID} py-2.5 hover:bg-slate-50/60 opacity-90`}>
              <ChevronRight className="w-4 h-4 text-slate-300 mt-2" />
              <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                <div className="text-[11px] font-medium text-slate-500 italic">Not a donation</div>
                <div className="text-[10px] text-slate-400">facility rental reimbursement</div>
              </div>
              <Card tone="green" amount={fmt(1200)} name="ACH · Minnesota Wildflower PTO" sub="Dec 12" menu={WIRE_MENU} />
              <Card tone="amber" amount={fmt(1200)} name="DEP 31654" sub="coded 4010 Grants · Class: Minnesota" gap="QB codes it as a donation" menu={QB_MENU} />
              <Status tone="red" word="Excluded · QB disagrees" detail="excluded from workbench, but QB books it as a donation" action actionLabel="Flag QB recode" />
              <RowKebab />
            </div>
          </div>

          <p className="text-[10px] text-slate-400 mt-3 leading-relaxed px-1">
            <span className="font-semibold text-slate-500">Reading:</span> every facet card now carries its own ⋯ menu (shown open on DEP 31688) for actions scoped to that record — view in QuickBooks/Stripe, unlink, move, exclude, flag — while the row-end ⋯ keeps cluster-wide actions (approve, split, history). The unattributed charge offers three donor paths; "Create CRM donation record" opens the dialog prefilled from the charge.
          </p>
        </main>

        {/* RIGHT RAIL — lenses split per feedback */}
        <aside className="w-72 shrink-0 bg-white border-l border-slate-200 overflow-y-auto">
          <div className="p-3 border-b border-slate-100">
            <h2 className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-2">Lenses</h2>
            <nav className="space-y-0.5">
              {([
                ["All unresolved", 12, true, false],
                ["Missing donor", 3, false, true],
                ["Donor record missing key info", 2, false, true],
                ["Missing accounting record", 2, false, true],
                ["Accounting record missing key info", 1, false, true],
                ["Settlement gaps", 2, false, false],
                ["Conflicts", 1, false, false],
                ["Refunds", 1, false, false],
                ["QB record needs correction", 2, false, false],
                ["Excluded · QB says donation", 1, false, false],
                ["Excluded", 4, false, false],
                ["Completed", 38, false, false],
              ] as [string, number, boolean, boolean][]).map(([label, count, active, isNew]) => (
                <button key={label} className={`flex items-center justify-between w-full px-2.5 py-1.5 rounded-md text-[11px] font-medium ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                  <span className="flex items-center gap-1.5">
                    {label}
                    {isNew && <span className="text-[7px] font-bold uppercase tracking-wide text-blue-500 bg-blue-50 rounded px-1 py-px">split</span>}
                  </span>
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
            "Missing X" = the record doesn't exist yet; "missing key info" = it exists but lacks something (donor contact/coding, class coding on the QB side). The two QB lenses remain the bookkeeper's punch list.
          </div>
        </aside>
      </div>
    </div>
  );
}
