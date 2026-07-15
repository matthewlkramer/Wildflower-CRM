import React from "react";
import {
  CheckCircle2, AlertTriangle, ArrowLeft, MoreHorizontal, Layers,
  Link2, History, GitBranch, Wallet, Scale, Wrench,
} from "lucide-react";

// CLUSTER FOCUS — full focus view for one complicated cluster, plus the
// persistent child inspector. Opened by selecting a cluster (or child) in the
// workbench. Left: the cluster's own dossier (totals, completeness math,
// included/missing charges, fee accounting, settlement link, conflicts,
// repair actions). Right: inspector for the selected child transaction
// (donor & gift, processor txn, QBO relationship, money breakdown, match
// rationale, ledger applications, source lineage, audit history, actions).

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const SectionTitle = ({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) => (
  <h3 className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
    <Icon className="w-3 h-3" /> {children}
  </h3>
);

const Metric = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="flex flex-col">
    <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
    <span className={`text-xs font-semibold tabular-nums ${warn ? "text-red-600" : "text-slate-800"}`}>{value}</span>
  </div>
);

const ChargeRow = ({ name, amount, chip, tone, selected }: {
  name: string; amount: number; chip: string; tone: "ok" | "warn"; selected?: boolean;
}) => (
  <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-[11px] ${selected ? "border-blue-400 bg-blue-50 ring-1 ring-blue-300" : "border-slate-100 bg-white"}`}>
    {tone === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
    <span className="font-medium text-slate-800 truncate">{name}</span>
    <span className="ml-auto tabular-nums font-semibold text-slate-700">{fmt(amount)}</span>
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider whitespace-nowrap ${tone === "ok" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{chip}</span>
  </div>
);

const KV = ({ k, v, warn }: { k: string; v: React.ReactNode; warn?: boolean }) => (
  <div className="flex items-baseline justify-between gap-2 py-0.5">
    <span className="text-[10px] text-slate-400 font-medium shrink-0">{k}</span>
    <span className={`text-[11px] text-right ${warn ? "text-amber-700 font-semibold" : "text-slate-700"}`}>{v}</span>
  </div>
);

export function ClusterFocus() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center gap-3 shadow-sm">
        <button className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"><ArrowLeft className="w-3.5 h-3.5" /> Workbench</button>
        <div className="w-px h-6 bg-slate-200" />
        <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center"><Layers className="w-4 h-4 text-white" /></div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Stripe payout · Dec 27, 2024</h1>
          <p className="text-xs text-slate-500 font-medium">QBO deposit 31716 · Black Wildflowers Fund</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800"><CheckCircle2 className="w-2.5 h-2.5" /> Money: Balanced</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-blue-100 text-blue-800">Attribution: 3/4 complete</span>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* LEFT — cluster dossier */}
        <main className="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">
          <section className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
            <SectionTitle icon={Scale}>Completeness calculation</SectionTitle>
            <div className="flex items-center gap-8 mb-3">
              <Metric label="Gross" value={fmt(838.18)} />
              <Metric label="Fees" value={fmt(14.08)} />
              <Metric label="Bank" value={fmt(824.10)} />
              <Metric label="Gap" value={fmt(0)} />
              <Metric label="Resolved" value="3 / 4" />
            </div>
            <div className="space-y-1 text-[11px] text-slate-600 font-mono bg-slate-50 rounded-md p-2.5 border border-slate-100">
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3 h-3 text-emerald-600" /> charges {fmt(838.18)} − fees {fmt(14.08)} = net {fmt(824.10)}</div>
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3 h-3 text-emerald-600" /> net {fmt(824.10)} = bank deposit 31716 {fmt(824.10)} · gap {fmt(0)}</div>
              <div className="flex items-center gap-2"><AlertTriangle className="w-3 h-3 text-amber-600" /> gifts {fmt(725)} cover 3 of 4 charges · {fmt(99.10)} unattributed</div>
            </div>
          </section>

          <section className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
            <SectionTitle icon={Link2}>Included charges (4) — none missing</SectionTitle>
            <div className="space-y-1.5">
              <ChargeRow name="Rivera Family Fund · ch_9Rvra" amount={508.80} chip="Done" tone="ok" />
              <ChargeRow name="Chen Household · ch_7Chen" amount={203.52} chip="Done" tone="ok" />
              <ChargeRow name="Anna Okafor · ch_2Okfr" amount={25.86} chip="Done" tone="ok" />
              <ChargeRow name="Unknown donor · ch_4Unkn" amount={100.00} chip="Needs donor" tone="warn" selected />
            </div>
            <p className="text-[9px] text-slate-400 mt-1.5">Amounts shown gross; Stripe reports every charge in this payout. A payout missing a charge would appear here as a settlement gap.</p>
          </section>

          <div className="grid grid-cols-2 gap-4">
            <section className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
              <SectionTitle icon={Wallet}>Fee accounting</SectionTitle>
              <KV k="PMT-2291 · QB Payment" v={`${fmt(838.18)} gross charges`} />
              <KV k="FEE-1108 · QB Payment" v={`−${fmt(14.08)} processing fee`} warn />
              <p className="text-[10px] text-amber-700 font-semibold mt-1">Missing class coding on FEE-1108</p>
              <button className="mt-2 px-2.5 py-1 rounded-md bg-slate-900 text-white text-[10px] font-semibold">Code the fee</button>
            </section>
            <section className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
              <SectionTitle icon={Link2}>Settlement link</SectionTitle>
              <KV k="QBO deposit" v="31716 · Dec 28 · from bank feed" />
              <KV k="Entity" v="Black Wildflowers Fund" />
              <KV k="Tied" v={<span className="inline-flex items-center gap-1 text-emerald-700 font-semibold"><CheckCircle2 className="w-3 h-3" /> payout ↔ deposit</span>} />
            </section>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <section className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
              <SectionTitle icon={AlertTriangle}>Conflicts</SectionTitle>
              <p className="text-[11px] text-slate-500">None — no charge is claimed by another gift, no double-booking detected.</p>
            </section>
            <section className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
              <SectionTitle icon={Wrench}>Repair actions</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {["Re-pull payout from Stripe", "Rebuild bundle", "Add missing charge", "Re-run auto-match"].map(a => (
                  <button key={a} className="px-2 py-1 rounded-md border border-slate-200 text-[10px] font-medium text-slate-600 hover:bg-slate-50">{a}</button>
                ))}
              </div>
            </section>
          </div>
        </main>

        {/* RIGHT — child inspector */}
        <aside className="w-[340px] shrink-0 bg-white border-l border-slate-200 overflow-y-auto">
          <div className="p-3 border-b border-slate-100 sticky top-0 bg-white z-10">
            <div className="flex items-center gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800">ch_4Unkn · {fmt(100)}</p>
                <p className="text-[10px] text-slate-400">selected charge · Dec 26 · Mastercard ···3319</p>
              </div>
              <span className="ml-auto inline-flex px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 whitespace-nowrap">Needs donor</span>
              <button className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-slate-100" title="Exclude · Flag for research · Move to another gift · Split · View source"><MoreHorizontal className="w-3.5 h-3.5 text-slate-400" /></button>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">No donor identified</p>
            <button className="mt-2 w-full px-2.5 py-1.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold">Choose donor</button>
          </div>

          <div className="p-3 space-y-3">
            <section>
              <SectionTitle icon={Link2}>Donor & gift</SectionTitle>
              <p className="text-[11px] text-slate-500 mb-1.5">None linked. Closest candidates:</p>
              <div className="space-y-1">
                {[
                  ["Maya Torres — Donorbox donation $100.00 · Dec 26", "email + amount match"],
                  ["M. Torres-Webb — recurring donor", "name similarity only"],
                ].map(([who, why]) => (
                  <div key={who} className="flex items-start gap-2 rounded-md border border-slate-100 bg-slate-50/60 px-2 py-1.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-slate-700 leading-snug">{who}</p>
                      <p className="text-[9px] text-slate-400">{why}</p>
                    </div>
                    <button className="text-[9px] font-semibold text-blue-600 shrink-0 mt-0.5">Pick</button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <SectionTitle icon={Wallet}>Money</SectionTitle>
              <KV k="Gross" v={fmt(100)} />
              <KV k="Fee" v={`−${fmt(3.20)}`} />
              <KV k="Net" v={fmt(96.80)} />
              <KV k="Refund" v="—" />
            </section>

            <section>
              <SectionTitle icon={Link2}>Processor transaction</SectionTitle>
              <KV k="Stripe charge" v="ch_4Unkn9Xw2" />
              <KV k="Payout" v="po_1QZk44 · Dec 27" />
              <KV k="Card" v="Mastercard ···3319" />
              <KV k="Statement desc." v="WILDFLOWER SCH" />
            </section>

            <section>
              <SectionTitle icon={Link2}>QBO relationship</SectionTitle>
              <KV k="Deposit" v="31716 · Dec 28" />
              <KV k="Share of deposit" v={`${fmt(96.80)} of ${fmt(824.10)}`} />
              <KV k="Coding" v="pending donor" warn />
            </section>

            <section>
              <SectionTitle icon={GitBranch}>Match rationale</SectionTitle>
              <p className="text-[11px] text-slate-500 leading-snug">Auto-match found no CRM gift within the amount window; no Donorbox record shares this card fingerprint. Two name/email candidates shown above.</p>
            </section>

            <section>
              <SectionTitle icon={Wallet}>Ledger applications</SectionTitle>
              <p className="text-[11px] text-slate-500">None — nothing applied until a gift is minted or linked.</p>
            </section>

            <section>
              <SectionTitle icon={GitBranch}>Source lineage</SectionTitle>
              <p className="text-[10px] text-slate-600 font-mono leading-relaxed">stripe payout po_1QZk44<br />└ charge ch_4Unkn9Xw2<br />&nbsp;&nbsp;└ QBO deposit 31716 (bank feed)</p>
            </section>

            <section>
              <SectionTitle icon={History}>Audit history</SectionTitle>
              <div className="space-y-1 text-[10px] text-slate-500">
                <p>Dec 28 · imported from Stripe sync</p>
                <p>Dec 28 · auto-match ran — no candidate above threshold</p>
                <p>Jan 2 · flagged in "Needs donor or gift" lens</p>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
