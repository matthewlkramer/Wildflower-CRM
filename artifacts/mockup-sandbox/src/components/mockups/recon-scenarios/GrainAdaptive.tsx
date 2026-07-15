import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CheckCircle2, AlertCircle, Plus, Layers, ChevronRight, ChevronDown,
  CornerDownRight, Search, ClipboardList, Upload,
} from "lucide-react";

// GRAIN C — ADAPTIVE (ratified) with refinements:
// - Summary row cells carry real summary sentences, not bare counts.
// - Many-to-many: the accounting side of a payout bundle holds TWO QB records
//   (net deposit + processor-fee payment). QB deposits and QB payments both
//   appear in staged payments and are treated interchangeably here.
// - Mini cards lead with what helps matching: date, purpose, donor name.
// - Who/why cards show a Donorbox badge when matched to a Donorbox record and
//   a coding-form badge when one is attached; actions: search Donorbox,
//   search coding form, upload grant letter.
// - Every card states its OWN completeness ("Missing grant letter"),
//   independent of linkage.

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const DbBadge = () => (
  <span title="Matched to Donorbox record" className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-teal-600 text-white text-[7px] font-bold shrink-0">DB</span>
);
const CodingBadge = () => (
  <span title="Coding form attached" className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-slate-200 text-slate-600 shrink-0"><ClipboardList className="w-2.5 h-2.5" /></span>
);

const ActionRow = ({ letter }: { letter?: boolean }) => (
  <div className="flex items-center gap-2.5 mt-1 pl-0.5">
    <button className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-slate-400 hover:text-slate-600 uppercase tracking-wide"><Search className="w-2.5 h-2.5" /> Donorbox</button>
    <button className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-slate-400 hover:text-slate-600 uppercase tracking-wide"><Search className="w-2.5 h-2.5" /> Coding form</button>
    {letter && <button className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-slate-400 hover:text-slate-600 uppercase tracking-wide"><Upload className="w-2.5 h-2.5" /> Grant letter</button>}
  </div>
);

const WhoCard = ({ amount, name, meta, missing, db, coding }: {
  amount: number; name: string; meta: string; missing?: string; db?: boolean; coding?: boolean;
}) => (
  <div className={`w-full rounded border p-2 ${missing ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
    <div className="flex items-center gap-1.5">
      {missing ? <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
      <span className={`text-xs font-semibold ${missing ? "text-amber-900" : "text-emerald-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${missing ? "text-amber-800" : "text-emerald-800"}`}>{name}</span>
      <span className="ml-auto flex items-center gap-1">{db && <DbBadge />}{coding && <CodingBadge />}</span>
    </div>
    <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${missing ? "text-amber-700/80" : "text-emerald-700/80"}`}>{meta}</div>
    {missing && <div className="text-[10px] pl-5 font-semibold text-amber-700">{missing}</div>}
  </div>
);

const TxCard = ({ amount, label, meta, missing }: { amount: number; label: string; meta: string; missing?: string }) => (
  <div className={`w-full rounded border p-2 ${missing ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
    <div className="flex items-center gap-1.5">
      {missing ? <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
      <span className={`text-xs font-semibold ${missing ? "text-amber-900" : "text-emerald-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${missing ? "text-amber-800" : "text-emerald-800"}`}>{label}</span>
    </div>
    <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${missing ? "text-amber-700/80" : "text-emerald-700/80"}`}>{meta}</div>
    {missing && <div className="text-[10px] pl-5 font-semibold text-amber-700">{missing}</div>}
  </div>
);

const AcctCard = ({ amount, label, kind, meta, missing }: {
  amount: number; label: string; kind: "QB Deposit" | "QB Payment"; meta: string; missing?: string;
}) => (
  <div className={`w-full rounded border p-2 ${missing ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
    <div className="flex items-center gap-1.5">
      {missing ? <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
      <span className={`text-xs font-semibold ${missing ? "text-amber-900" : "text-emerald-900"}`}>{fmt(amount)}</span>
      <span className={`text-xs font-medium truncate ${missing ? "text-amber-800" : "text-emerald-800"}`}>{label}</span>
      <span className="ml-auto text-[8px] font-bold uppercase tracking-wider text-slate-400 border border-slate-200 rounded px-1 py-px bg-white shrink-0">{kind}</span>
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
        <div className="border border-slate-200 rounded-lg shadow-sm overflow-hidden bg-white">
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
                  <WhoCard amount={150000} name="Meadow Fund Commitment" meta="Jun 15 · FY27 general support · Meadow Fund" missing="Missing grant letter" db={false} coding />
                  <ActionRow letter />
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
                      <span className="font-semibold">3 gifts totalling {fmt(725)}</span> cover 3 of the 4 charges in this Stripe bundle.
                    </p>
                    <p className="text-[10px] text-amber-700 font-semibold mt-0.5">1 charge has no gift yet</p>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <div className="rounded border border-slate-200 bg-white px-2.5 py-2">
                    <p className="text-[11px] leading-snug text-slate-700">
                      <span className="font-semibold">Bundle of 4 Stripe charges</span> paid out in one transaction on <span className="font-semibold">Jul 2</span>.
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{fmt(824.10)} gross · {fmt(24.35)} fees · {fmt(799.75)} net</p>
                  </div>
                </TableCell>
                <TableCell className="align-top py-3">
                  <div className="space-y-1">
                    <AcctCard amount={799.75} label="DEP-3410" kind="QB Deposit" meta="Jul 3 · from bank feed · covers full Stripe payout (net)" />
                    <AcctCard amount={24.35} label="PMT-2291" kind="QB Payment" meta="Jul 3 · Stripe processing fees" missing="Missing class coding" />
                    <div className="text-[9px] text-slate-400 font-medium pl-1">2 QB records together cover the {fmt(824.10)} gross</div>
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
                who={<><WhoCard amount={500} name="Rivera Family Fund" meta="Jun 28 · Teacher stipends — Minnesota" db coding /><ActionRow letter /></>}
                tx={<TxCard amount={500} label="ch_9Rvra · Stripe" meta="Jun 28 · Visa ···4242 · recurring monthly" />}
              />
              <SubRow status="ok"
                who={<><WhoCard amount={200} name="Chen Household" meta="Jun 29 · Annual fund" db missing="Missing coding form" /><ActionRow letter /></>}
                tx={<TxCard amount={200} label="ch_7Chen · Stripe" meta="Jun 29 · Amex ···1005 · one-time" />}
              />
              <SubRow status="ok"
                who={<><WhoCard amount={25} name="Anna Okafor" meta="Jun 30 · GivingTuesday follow-up" coding missing="Not matched to Donorbox" /><ActionRow letter /></>}
                tx={<TxCard amount={25} label="ch_2Okfr · Stripe" meta="Jun 30 · Visa ···8812 · first-time donor" />}
              />
              <SubRow status="todo"
                who={<><Ghost label="Link who & why" /><ActionRow letter /></>}
                tx={<TxCard amount={99.10} label="ch_4Unkn · Stripe" meta="Jul 1 · Mastercard ···3319" missing="No donor identified" />}
              />

              {/* Stray — still one row, no second level */}
              <TableRow className="hover:bg-slate-50 border-t border-slate-100">
                <TableCell className="align-top py-3 pr-0"><ChevronRight className="w-4 h-4 text-slate-400 mt-2" /></TableCell>
                <TableCell className="align-top py-3">
                  <WhoCard amount={75000} name="Prairie Sky Fund" meta="Pledge · expected this month · capital campaign" db={false} coding={false} />
                  <ActionRow letter />
                </TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link transaction" /></TableCell>
                <TableCell className="align-top py-3"><Ghost label="Link accounting / bank rec" /></TableCell>
                <TableCell className="align-top py-3 text-right"><Pill kind="todo">Unlinked</Pill></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed max-w-4xl px-1">
          <span className="font-semibold text-slate-600">Reading:</span> the summary row speaks in sentences — who/why says
          what the gifts cover, transaction describes the payout bundle, accounting shows the (often two) QB records that
          book it: net deposit + fee payment. Card badges: <span className="inline-flex align-middle mx-0.5"><DbBadge /></span> = matched to a
          Donorbox record, <span className="inline-flex align-middle mx-0.5"><CodingBadge /></span> = coding form attached. Amber lines are the card's
          own gaps ("Missing grant letter") — separate from whether it's linked.
        </div>
      </div>
    </div>
  );
}
