import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CheckCircle2, AlertCircle, Plus, Layers, ChevronRight, ChevronDown,
  CornerDownRight, Search, ClipboardList, Upload, MoreHorizontal,
  Unlink, Scissors, Boxes, ArrowLeftRight, EyeOff, FileText,
} from "lucide-react";

// GRAIN C — ADAPTIVE (ratified) with refinements:
// - Summary row cells are compact but COMPLETE (amounts, counts, dates).
// - Payout bundle accounting = TWO QB records: a GROSS payment + a processor
//   fee that sum to NET — the amount the bank deposit was for. QB deposits
//   and QB payments both appear in staged payments, treated interchangeably.
// - Mini cards lead with matching info: date, purpose, donor name.
// - Who/why badges: Donorbox-matched, coding form attached, grant letter
//   attached. Every card has a "⋯" action menu (search Donorbox / coding
//   form, upload grant letter, unlink, split, group, replace intermediary
//   with donor, exclude from workbench) — one shown open for reference.
// - Every card states its OWN completeness, independent of linkage.

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

const MenuItem = ({ icon: Icon, children, danger }: { icon: React.ElementType; children: React.ReactNode; danger?: boolean }) => (
  <button className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-[11px] font-medium rounded ${danger ? "text-red-600 hover:bg-red-50" : "text-slate-700 hover:bg-slate-100"}`}>
    <Icon className="w-3 h-3 shrink-0" /> {children}
  </button>
);

const CardMenu = ({ open }: { open?: boolean }) => (
  <span className="relative shrink-0">
    <button className={`inline-flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 ${open ? "bg-black/5" : ""}`}>
      <MoreHorizontal className="w-3.5 h-3.5 text-slate-400" />
    </button>
    {open && (
      <div className="absolute right-0 top-6 w-60 bg-white border border-slate-200 rounded-md shadow-xl z-30 p-1">
        <MenuItem icon={Search}>Search Donorbox for a match</MenuItem>
        <MenuItem icon={ClipboardList}>Search coding forms</MenuItem>
        <MenuItem icon={Upload}>Upload grant letter</MenuItem>
        <div className="my-1 border-t border-slate-100" />
        <MenuItem icon={Unlink}>Unlink from this cluster</MenuItem>
        <MenuItem icon={Scissors}>Split into multiple records</MenuItem>
        <MenuItem icon={Boxes}>Group with another record</MenuItem>
        <MenuItem icon={ArrowLeftRight}>Replace intermediary with donor</MenuItem>
        <div className="my-1 border-t border-slate-100" />
        <MenuItem icon={EyeOff} danger>Exclude from workbench</MenuItem>
      </div>
    )}
  </span>
);

const WhoCard = ({ amount, name, meta, missing, db, coding, letter, menuOpen }: {
  amount: number; name: string; meta: string; missing?: string;
  db?: boolean; coding?: boolean; letter?: boolean; menuOpen?: boolean;
}) => (
  <div className={`relative w-full rounded border p-2 ${missing ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
    <div className="flex items-center gap-1.5">
      {missing ? <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
      <span className={`text-xs font-semibold ${missing ? "text-amber-900" : "text-emerald-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${missing ? "text-amber-800" : "text-emerald-800"}`}>{name}</span>
      <span className="ml-auto flex items-center gap-1">
        {db && <DbBadge />}{coding && <CodingBadge />}{letter && <LetterBadge />}
        <CardMenu open={menuOpen} />
      </span>
    </div>
    <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${missing ? "text-amber-700/80" : "text-emerald-700/80"}`}>{meta}</div>
    {missing && <div className="text-[10px] pl-5 font-semibold text-amber-700">{missing}</div>}
  </div>
);

const TxCard = ({ amount, label, meta, missing }: { amount: number; label: string; meta: string; missing?: string }) => (
  <div className={`relative w-full rounded border p-2 ${missing ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
    <div className="flex items-center gap-1.5">
      {missing ? <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
      <span className={`text-xs font-semibold ${missing ? "text-amber-900" : "text-emerald-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${missing ? "text-amber-800" : "text-emerald-800"}`}>{label}</span>
      <span className="ml-auto"><CardMenu /></span>
    </div>
    <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${missing ? "text-amber-700/80" : "text-emerald-700/80"}`}>{meta}</div>
    {missing && <div className="text-[10px] pl-5 font-semibold text-amber-700">{missing}</div>}
  </div>
);

const AcctCard = ({ amount, label, kind, meta, missing }: {
  amount: number; label: string; kind: "QB Deposit" | "QB Payment"; meta: string; missing?: string;
}) => (
  <div className={`relative w-full rounded border p-2 ${missing ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
    <div className="flex items-center gap-1.5">
      {missing ? <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
      <span className={`text-xs font-semibold ${missing ? "text-amber-900" : "text-emerald-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${missing ? "text-amber-800" : "text-emerald-800"}`}>{label}</span>
      <span className="ml-auto flex items-center gap-1">
        <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400 border border-slate-200 rounded px-1 py-px bg-white shrink-0">{kind}</span>
        <CardMenu />
      </span>
    </div>
    <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${missing ? "text-amber-700/80" : "text-emerald-700/80"}`}>{meta}</div>
    {missing && <div className="text-[10px] pl-5 font-semibold text-amber-700">{missing}</div>}
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

// Sub-row: indented under its summary row
const SubRow = ({ who, tx, status }: { who: React.ReactNode; tx: React.ReactNode; status: "ok" | "todo" }) => (
  <TableRow className="bg-slate-50/70 hover:bg-slate-100/70 border-l-2 border-l-blue-300">
    <TableCell className="align-top py-2 pr-0 pl-9"><CornerDownRight className="w-3.5 h-3.5 text-slate-300 mt-2.5" /></TableCell>
    <TableCell className="align-top py-2"><div className="ml-4">{who}</div></TableCell>
    <TableCell className="align-top py-2"><div className="ml-4">{tx}</div></TableCell>
    <TableCell className="align-top py-2">
      <div className="ml-4 flex items-center h-10 px-2 text-[10px] text-slate-400 font-medium">↳ part of the Stripe payout bundle</div>
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
          <h1 className="text-base font-semibold leading-tight">Grain C — Adaptive (refined)</h1>
          <p className="text-xs text-slate-500 font-medium">Browse one row per cluster; expand to work one row per transaction</p>
        </div>
      </header>

      <div className="px-6 py-2.5 bg-white border-b border-slate-100 flex items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
          <CheckCircle2 className="w-3 h-3" /> Every card states its own completeness, independent of linkage
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-medium">
          <AlertCircle className="w-3 h-3" /> QB deposits &amp; QB payments both appear in staged payments — treated interchangeably
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="border border-slate-200 rounded-lg shadow-sm bg-white">
          <Table>
            <TableHeader className="bg-slate-50 border-b border-slate-200">
              <TableRow className="hover:bg-slate-50">
                <TableHead className="w-[28px]"></TableHead>
                <TableHead className="w-[300px] text-xs font-semibold text-slate-600">WHO &amp; WHY (CRM)</TableHead>
                <TableHead className="w-[280px] text-xs font-semibold text-slate-600">TRANSACTION (Proof)</TableHead>
                <TableHead className="w-[300px] text-xs font-semibold text-slate-600">
                  ACCOUNTING &amp; BANK REC (QB)
                  <div className="text-[9px] font-medium text-slate-400 normal-case tracking-normal">populated from bank deposits — deposits &amp; payments interchangeable</div>
                </TableHead>
                <TableHead className="text-right text-xs font-semibold text-slate-600">Cluster</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Simple 1:1:1 cluster — no second level */}
              <TableRow className="hover:bg-slate-50">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3">
                  <WhoCard amount={150000} name="Meadow Fund Commitment" meta="Jun 15 · FY27 general support · Meadow Fund" missing="Missing grant letter" coding />
                </TableCell>
                <TableCell className="align-top py-3"><TxCard amount={150000} label="Wire TR-991" meta="Jul 1 · First Horizon → WF operating" missing="Missing originating bank confirmation" /></TableCell>
                <TableCell className="align-top py-3"><AcctCard amount={150000} label="DEP-8821" kind="QB Deposit" meta="Jul 1 · from bank feed · 4010 Grants · Class: National" /></TableCell>
                <TableCell className="align-top py-3 text-right"><Pill kind="partial">Partial</Pill></TableCell>
              </TableRow>

              {/* BUNDLE SUMMARY ROW — expanded */}
              <TableRow className="bg-blue-50/40 hover:bg-blue-50/50 border-t border-blue-100">
                <TableCell className="align-top py-3 pr-0"><ChevronDown className="w-4 h-4 text-blue-500 mt-2" /></TableCell>
                <TableCell className="align-top py-3">
                  <div className="rounded border border-slate-200 bg-white px-2.5 py-2">
                    <p className="text-[11px] leading-snug text-slate-700">
                      <span className="font-semibold">3 gifts · {fmt(725)}</span> — cover 3 of 4 charges in this bundle
                    </p>
                    <p className="text-[10px] text-amber-700 font-semibold mt-0.5">1 charge ({fmt(99.10)}) has no gift yet</p>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <div className="rounded border border-slate-200 bg-white px-2.5 py-2">
                    <p className="text-[11px] leading-snug text-slate-700">
                      <span className="font-semibold">4 Stripe charges · one payout · Jul 2</span>
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{fmt(824.10)} gross · {fmt(24.35)} fees · {fmt(799.75)} net</p>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <div className="space-y-1">
                    <AcctCard amount={824.10} label="PMT-2291" kind="QB Payment" meta="Jul 3 · gross Stripe charges" />
                    <AcctCard amount={-24.35} label="FEE-1108" kind="QB Payment" meta="Jul 3 · Stripe processing fee" missing="Missing class coding" />
                    <div className="text-[9px] text-slate-400 font-medium pl-1">sum to {fmt(799.75)} net — the bank deposit QB ingested</div>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <Pill kind="partial">Partial</Pill>
                    <span className="text-[9px] text-slate-400 font-medium">rolls up from 4 sub-rows</span>
                  </div>
                </TableCell>
              </TableRow>

              {/* Sub-rows — indented, transaction grain, where matching happens */}
              <SubRow status="ok"
                who={<WhoCard amount={500} name="Rivera Family Fund" meta="Jun 28 · Teacher stipends — Minnesota" db coding letter />}
                tx={<TxCard amount={500} label="ch_9Rvra · Stripe" meta="Jun 28 · Visa ···4242 · recurring monthly" />}
              />
              <SubRow status="ok"
                who={<WhoCard amount={200} name="Chen Household" meta="Jun 29 · Annual fund" db missing="Missing coding form" menuOpen />}
                tx={<TxCard amount={200} label="ch_7Chen · Stripe" meta="Jun 29 · Amex ···1005 · one-time" />}
              />
              <SubRow status="ok"
                who={<WhoCard amount={25} name="Anna Okafor" meta="Jun 30 · GivingTuesday follow-up" coding missing="Not matched to Donorbox" />}
                tx={<TxCard amount={25} label="ch_2Okfr · Stripe" meta="Jun 30 · Visa ···8812 · first-time donor" />}
              />
              <SubRow status="todo"
                who={<Ghost label="Link who & why" />}
                tx={<TxCard amount={99.10} label="ch_4Unkn · Stripe" meta="Jul 1 · Mastercard ···3319" missing="No donor identified" />}
              />

              {/* Stray — still one row, no second level */}
              <TableRow className="hover:bg-slate-50 border-t border-slate-100">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3">
                  <WhoCard amount={75000} name="Prairie Sky Fund" meta="Pledge · expected this month · capital campaign" />
                </TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link transaction" /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link accounting / bank rec" /></TableCell>
                <TableCell className="align-top py-3 text-right"><Pill kind="todo">Unlinked</Pill></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed max-w-4xl px-1">
          <span className="font-semibold text-slate-600">Reading:</span> summary cells are compact but complete — amounts,
          counts, dates. The bundle's accounting side holds two QB records: a gross payment plus the processor fee, summing
          to the net the bank deposit was for. Badges: <span className="inline-flex align-middle mx-0.5"><DbBadge /></span> Donorbox-matched,
          <span className="inline-flex align-middle mx-0.5"><CodingBadge /></span> coding form attached, <span className="inline-flex align-middle mx-0.5"><LetterBadge /></span> grant
          letter attached. Every card's ⋯ menu (open on the Chen card) carries the full action set: search Donorbox /
          coding forms, upload grant letter, unlink, split, group, replace intermediary with donor, exclude from workbench.
          Amber lines are the card's own gaps, separate from linkage.
        </div>
      </div>
    </div>
  );
}
