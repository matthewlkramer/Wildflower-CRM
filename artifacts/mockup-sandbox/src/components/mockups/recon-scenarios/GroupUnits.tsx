import React, { useState } from "react";
import {
  Link as LinkIcon,
  Check,
  Search,
  AlertCircle,
  Landmark,
  CreditCard,
  Plus,
  Layers,
  Info,
  ChevronRight,
  ArrowRightLeft,
  X,
  ShieldAlert
} from "lucide-react";

export function GroupUnits() {
  const [selectedUnits, setSelectedUnits] = useState<string[]>(['qb-1', 'qb-2', 'qb-3', 'qb-4']);

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Header */}
      <header className="px-5 py-3 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center shadow-sm">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight text-slate-900">Unit Grouper</h1>
            <p className="text-xs text-slate-500 font-medium">Reconciliation Workbench</p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center">
        <div className="max-w-5xl w-full flex flex-col gap-8">
          
          <div className="bg-blue-50/50 border border-blue-100 rounded-lg p-4 flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900">
              <strong className="font-semibold block mb-1">QuickBooks rows are immutable.</strong>
              These 4 accounting payments were entered separately in QuickBooks for restriction tracking, but they represent a single wire transfer from the donor. By grouping them here, you can match the entire $100,000 to the single CRM Gift while preserving the individual line-item accounting links.
            </div>
          </div>

          <div className="flex gap-8 items-stretch">
            
            {/* Left: QB Units */}
            <div className="flex-1 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-slate-500" />
                  <h3 className="font-semibold text-slate-900 text-sm">QuickBooks Payments</h3>
                </div>
                <div className="text-xs font-medium text-slate-500">
                  4 selected • $100,000.00
                </div>
              </div>
              
              <div className="p-3 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                 <Search className="w-4 h-4 text-slate-400" />
                 <input type="text" placeholder="Search Prairie Sky Fund..." className="bg-transparent border-none focus:ring-0 text-sm w-full outline-none placeholder:text-slate-400" defaultValue="Prairie Sky Fund wire" />
              </div>

              <div className="divide-y divide-slate-100">
                {[
                  { id: 'qb-1', amount: 40000, memo: 'General Operating', date: 'Jul 15, 2026', ref: 'WIRE-9921' },
                  { id: 'qb-2', amount: 30000, memo: 'Capital Campaign', date: 'Jul 15, 2026', ref: 'WIRE-9921' },
                  { id: 'qb-3', amount: 20000, memo: 'Scholarship Fund', date: 'Jul 15, 2026', ref: 'WIRE-9921' },
                  { id: 'qb-4', amount: 10000, memo: 'Teacher Professional Dev', date: 'Jul 15, 2026', ref: 'WIRE-9921' },
                ].map(unit => (
                  <label key={unit.id} className="flex items-start gap-3 p-4 hover:bg-slate-50 cursor-pointer transition-colors">
                    <div className="pt-1">
                      <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600" checked={selectedUnits.includes(unit.id)} readOnly />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-sm font-medium text-slate-900">Prairie Sky Fund</span>
                        <span className="text-sm font-mono font-medium text-slate-900">${unit.amount.toLocaleString()}.00</span>
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-2">
                        <span>{unit.date}</span>
                        <span>•</span>
                        <span className="font-mono">{unit.ref}</span>
                      </div>
                      <div className="text-xs text-slate-600 mt-1.5 bg-slate-100 inline-block px-2 py-0.5 rounded">
                        Memo: {unit.memo}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Middle: Match Action */}
            <div className="w-32 flex flex-col items-center justify-center relative">
               <div className="h-full w-px bg-slate-200 absolute left-1/2 top-0 -translate-x-1/2 -z-10"></div>
               <div className="bg-white border border-slate-200 rounded-full px-4 py-2 text-xs font-semibold text-slate-600 shadow-sm flex items-center gap-2 whitespace-nowrap">
                 Group & Match <ArrowRightLeft className="w-3.5 h-3.5" />
               </div>
            </div>

            {/* Right: CRM Gift */}
            <div className="flex-1 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col h-fit">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded bg-blue-100 flex items-center justify-center">
                    <LinkIcon className="w-3 h-3 text-blue-700" />
                  </div>
                  <h3 className="font-semibold text-slate-900 text-sm">CRM Gift Match</h3>
                </div>
              </div>
              
              <div className="p-6 flex flex-col items-center text-center border-b border-slate-100">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                  <Layers className="w-8 h-8 text-slate-400" />
                </div>
                <h2 className="text-xl font-semibold text-slate-900 mb-1">Gift #10492</h2>
                <div className="text-sm text-slate-500 mb-4">Prairie Sky Fund • Jul 12, 2026</div>
                <div className="text-3xl font-light font-mono text-slate-900 tracking-tight">$100,000.00</div>
              </div>

              <div className="p-4 bg-slate-50 flex items-center justify-between">
                <div className="text-xs font-medium text-slate-500">
                  Status after matching:
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-100 px-2 py-1 rounded">
                  <Check className="w-3.5 h-3.5" /> Fully Reconciled
                </div>
              </div>
            </div>

          </div>

          {/* Action Bar */}
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
              Cancel
            </button>
            <button className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md shadow-sm transition-colors flex items-center gap-2">
              <Check className="w-4 h-4" /> Confirm Match (4 → 1)
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
