import React, { useState } from "react";
import { 
  Search, 
  CheckCircle2, 
  AlertCircle, 
  Ban, 
  ArrowRight,
  FileText,
  Landmark,
  Clock,
  SplitSquareHorizontal,
  ChevronRight,
  ArrowDownToLine,
  Filter
} from "lucide-react";

const formatCurrency = (n: number) => 
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export function MatchSearch() {
  const [searchQuery, setSearchQuery] = useState("Third Coast");

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <Landmark className="w-4 h-4 text-slate-500" />
          <span className="text-xs font-medium text-slate-500 uppercase tracking-widest">QuickBooks Deposit Line</span>
        </div>
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 mb-1">Third Coast Foundation</h1>
            <div className="text-sm text-slate-500 font-mono flex items-center gap-2">
              <span>Check #2044</span>
              <span>•</span>
              <span>Sep 15, 2026</span>
              <span>•</span>
              <span>DEP-90214</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-light font-mono tracking-tight text-slate-900">{formatCurrency(25000)}</div>
            <div className="text-sm font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-200/50 inline-flex mt-1">
              Unreconciled
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full p-8 flex flex-col gap-6">
          
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Find CRM Match</h2>
                <div className="text-xs font-medium text-slate-500">Auto-search yielded 3 candidates</div>
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input 
                  type="text" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search gifts, pledges, or donors..." 
                  className="w-full pl-9 pr-10 py-2.5 text-sm bg-white border border-slate-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-400"
                />
                <button className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 rounded">
                  <Filter className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="divide-y divide-slate-100">
              {/* Candidate 1: Strong Match */}
              <div className="p-4 flex items-start gap-4 hover:bg-slate-50 transition-colors group">
                <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center shrink-0 border border-emerald-100 mt-1">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">Gift #8912 • Third Coast Foundation</div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">Expected: Sep 14, 2026</div>
                    </div>
                    <div className="text-base font-mono font-medium text-slate-900">
                      $25,000.00
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-sm bg-emerald-100 text-emerald-700 uppercase tracking-widest">
                      <CheckCircle2 className="w-3 h-3" /> Exact Amount
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-sm bg-blue-100 text-blue-700 uppercase tracking-widest">
                      <Clock className="w-3 h-3" /> Date -1d
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button className="bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium px-4 py-2 rounded-md shadow-sm transition-colors flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" /> Confirm Match
                    </button>
                  </div>
                </div>
              </div>

              {/* Candidate 2: Amount Mismatch */}
              <div className="p-4 flex items-start gap-4 hover:bg-slate-50 transition-colors bg-amber-50/10">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0 border border-amber-200 mt-1">
                  <AlertCircle className="w-5 h-5 text-amber-600" />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">Pledge #8904 • Third Coast Foundation</div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">Expected: Sep 1, 2026</div>
                    </div>
                    <div className="text-right">
                      <div className="text-base font-mono font-medium text-slate-900">$24,850.00</div>
                      <div className="text-xs font-mono text-amber-600 mt-0.5">Delta: +$150.00</div>
                    </div>
                  </div>
                  
                  <div className="mt-3 p-4 bg-white border border-amber-200/60 rounded-lg shadow-sm">
                    <div className="text-xs font-semibold text-slate-900 mb-3 flex items-center gap-2">
                      <ArrowDownToLine className="w-4 h-4 text-amber-500" />
                      Resolve Amount Mismatch
                    </div>
                    <div className="flex gap-3">
                      <button className="flex-1 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-medium px-3 py-2 rounded-md shadow-sm transition-all text-left flex flex-col gap-1">
                        <span className="flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> Correct Gift Amount</span>
                        <span className="text-[11px] text-slate-500 font-normal">Update CRM to $25,000.00</span>
                      </button>
                      <button className="flex-1 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-medium px-3 py-2 rounded-md shadow-sm transition-all text-left flex flex-col gap-1">
                        <span className="flex items-center gap-1.5"><SplitSquareHorizontal className="w-3.5 h-3.5" /> Apply Partially</span>
                        <span className="text-[11px] text-slate-500 font-normal">Leave $150.00 unreconciled</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Candidate 3: Already Claimed */}
              <div className="p-4 flex items-start gap-4 bg-slate-50/80 opacity-75">
                <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center shrink-0 border border-slate-300 mt-1">
                  <Ban className="w-5 h-5 text-slate-500" />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <div className="text-sm font-medium text-slate-500">Gift #8899 • Third Coast Foundation</div>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">Received: Aug 20, 2026</div>
                    </div>
                    <div className="text-base font-mono font-medium text-slate-500">
                      $25,000.00
                    </div>
                  </div>
                  <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-200/50 border border-slate-200 rounded text-xs font-medium text-slate-600">
                    <Ban className="w-3.5 h-3.5" />
                    Already claimed by check #2041 
                    <span className="mx-1 text-slate-300">|</span>
                    <a href="#" className="text-blue-600 hover:underline inline-flex items-center">
                      View claim <ChevronRight className="w-3 h-3 ml-0.5" />
                    </a>
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
