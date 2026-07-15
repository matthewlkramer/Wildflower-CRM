import React, { useState } from "react";
import { 
  GitMerge, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  FileText,
  User,
  Info,
  Archive,
  ChevronRight,
  ShieldCheck
} from "lucide-react";

const formatCurrency = (n: number) => 
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

interface Gift {
  id: string;
  amount: number;
  date: string;
  notes: string;
  allocations: { fund: string; amount: number }[];
}

const GIFTS: Gift[] = [
  {
    id: "G-1402",
    amount: 25000,
    date: "Oct 1, 2026",
    notes: "Part 1 of grant",
    allocations: [{ fund: "General Operating", amount: 25000 }]
  },
  {
    id: "G-1403",
    amount: 25000,
    date: "Oct 2, 2026",
    notes: "Part 2 of grant",
    allocations: [{ fund: "General Operating", amount: 25000 }]
  },
  {
    id: "G-1404",
    amount: 25000,
    date: "Oct 2, 2026",
    notes: "Part 3 of grant",
    allocations: [{ fund: "Capacity Building", amount: 25000 }]
  }
];

export function CombineGifts() {
  const [survivorId, setSurvivorId] = useState<string>("G-1402");

  const survivor = GIFTS.find(g => g.id === survivorId)!;
  const absorbed = GIFTS.filter(g => g.id !== survivorId);

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <GitMerge className="w-4 h-4 text-slate-500" />
            <span className="text-xs font-medium text-slate-500 uppercase tracking-widest">Reconciliation Tools</span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">Combine Duplicate Gifts</h1>
        </div>
        <div className="flex items-center gap-3">
          <button className="text-sm font-medium text-slate-600 px-4 py-2 hover:bg-slate-100 rounded-md transition-colors">
            Cancel
          </button>
          <button className="bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium px-4 py-2 rounded-md shadow-sm transition-colors flex items-center gap-2">
            <GitMerge className="w-4 h-4" /> Combine into {survivorId}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">

          {/* Context Alert */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3 shadow-sm">
            <Info className="w-5 h-5 text-blue-600 shrink-0" />
            <div className="text-sm text-blue-900">
              <span className="font-semibold block mb-0.5">Safe Operation</span>
              You are combining multiple CRM records into one. Allocations will merge, payment links will re-point to the survivor, and the other gifts will be archived (not deleted). Underlying evidence rows (QuickBooks/Stripe) are never modified.
            </div>
          </div>

          <div className="grid grid-cols-12 gap-8">
            
            {/* Step 1: Pick Survivor */}
            <div className="col-span-7 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-slate-900">1. Pick the Survivor Record</h2>
              
              <div className="space-y-3">
                {GIFTS.map(gift => {
                  const isSelected = survivorId === gift.id;
                  return (
                    <div 
                      key={gift.id}
                      onClick={() => setSurvivorId(gift.id)}
                      className={`relative flex items-start gap-4 p-4 rounded-xl border-2 transition-all cursor-pointer ${
                        isSelected 
                          ? 'bg-blue-50/30 border-blue-500 shadow-sm' 
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                        isSelected ? 'border-blue-500' : 'border-slate-300'
                      }`}>
                        {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                      </div>
                      
                      <div className="flex-1">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                              {gift.id}
                              {isSelected && <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700">Survivor</span>}
                            </div>
                            <div className="text-xs text-slate-500 font-mono mt-0.5">{gift.date} • Meadow Fund</div>
                          </div>
                          <div className="text-base font-mono font-medium text-slate-900">
                            {formatCurrency(gift.amount)}
                          </div>
                        </div>
                        
                        <div className="text-sm text-slate-600 bg-slate-50 rounded p-2 border border-slate-100 mb-2">
                          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">Notes</span>
                          {gift.notes}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {gift.allocations.map((alloc, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5 px-2 py-1 bg-slate-100 rounded text-xs font-medium text-slate-700">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                              {alloc.fund} <span className="font-mono text-slate-500 ml-1">{formatCurrency(alloc.amount)}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Step 2: Preview Result */}
            <div className="col-span-5 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-slate-900">2. Outcome Preview</h2>
              
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden sticky top-8">
                <div className="p-5 border-b border-slate-100">
                  <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 mb-4 bg-emerald-50 px-3 py-2 rounded-md border border-emerald-100">
                    <ShieldCheck className="w-4 h-4" /> Final Combined Record
                  </div>
                  
                  <div className="mb-4">
                    <div className="text-sm text-slate-500 font-medium mb-1">Meadow Fund</div>
                    <div className="text-3xl font-light font-mono tracking-tight text-slate-900 mb-2">
                      {formatCurrency(75000)}
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                      Surviving ID: <span className="font-semibold text-slate-900">{survivorId}</span>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Merged Allocations</div>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-sm p-2 bg-slate-50 rounded border border-slate-100">
                          <span className="font-medium text-slate-700 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                            General Operating
                          </span>
                          <span className="font-mono font-medium text-slate-900">{formatCurrency(50000)}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm p-2 bg-slate-50 rounded border border-slate-100">
                          <span className="font-medium text-slate-700 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                            Capacity Building
                          </span>
                          <span className="font-mono font-medium text-slate-900">{formatCurrency(25000)}</span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">To Be Archived</div>
                      <div className="space-y-2">
                        {absorbed.map(g => (
                          <div key={g.id} className="flex justify-between items-center text-sm p-2 bg-slate-50/50 rounded border border-slate-100 text-slate-500">
                            <span className="flex items-center gap-1.5"><Archive className="w-3.5 h-3.5" /> {g.id}</span>
                            <span className="font-mono">{formatCurrency(g.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}
