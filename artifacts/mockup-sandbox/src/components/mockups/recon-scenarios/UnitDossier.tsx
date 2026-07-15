import React from "react";
import { 
  CheckCircle2, 
  Link as LinkIcon, 
  FileText, 
  User, 
  Building, 
  Tag, 
  Calendar, 
  Check, 
  FileCheck, 
  CreditCard, 
  Landmark, 
  FileDigit,
  ArrowRight
} from "lucide-react";

export function UnitDossier() {
  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold leading-tight text-slate-900 flex items-center gap-2">
            Unit Dossier <span className="text-slate-400 font-normal">|</span> Meadow Fund Check
          </h1>
          <p className="text-sm text-slate-500 font-medium mt-1">
            Status: <span className="text-emerald-600 font-semibold uppercase tracking-wider text-xs">Fully Reconciled</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="text-sm font-medium bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-md shadow-sm transition-colors">
            View in Ledger
          </button>
        </div>
      </header>

      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-6xl mx-auto">
          
          <div className="grid grid-cols-3 gap-6 relative">
            
            {/* Link lines background (visual representation) */}
            <div className="absolute top-1/2 left-[16.6%] right-[16.6%] h-px bg-slate-200 -z-10 hidden md:block"></div>
            
            {/* Column 1: WHO & WHY (CRM record) */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-full z-10">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 rounded-t-xl">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Who & Why <span className="text-slate-400 font-normal normal-case">(CRM)</span></h2>
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="p-5 flex-1 flex flex-col gap-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">Gift</div>
                    <div className="text-2xl font-semibold text-slate-900 font-mono tracking-tight">$50,000.00</div>
                    <div className="text-sm text-slate-500 mt-0.5">ID: G-9021 • Oct 14, 2025</div>
                  </div>
                </div>

                <div className="space-y-3 mt-2 pt-4 border-t border-slate-100">
                  <div className="flex gap-3 items-start">
                    <Building className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">Meadow Fund</div>
                      <div className="text-xs text-slate-500">Foundation • Donor</div>
                    </div>
                  </div>
                  <div className="flex gap-3 items-start">
                    <Tag className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">General Operating Support</div>
                      <div className="text-xs text-slate-500">Allocation</div>
                    </div>
                  </div>
                  <div className="flex gap-3 items-start">
                    <FileCheck className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-blue-600 hover:underline cursor-pointer">meadow_grant_letter_2025.pdf</div>
                      <div className="text-xs text-slate-500">Attached Documentation</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 2: TRANSACTION (Proof money moved) */}
            <div className="bg-white rounded-xl border-2 border-indigo-100 shadow-sm flex flex-col h-full relative z-10">
              <div className="px-5 py-4 border-b border-indigo-50 flex items-center justify-between bg-indigo-50/30 rounded-t-xl">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Transaction <span className="text-slate-400 font-normal normal-case">(Proof)</span></h2>
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="p-5 flex-1 flex flex-col gap-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">Check / Deposit</div>
                    <div className="text-2xl font-semibold text-slate-900 font-mono tracking-tight">$50,000.00</div>
                    <div className="text-sm text-slate-500 mt-0.5">Ref: DEP-8821 • Oct 15, 2025</div>
                  </div>
                </div>

                <div className="space-y-3 mt-2 pt-4 border-t border-slate-100">
                  <div className="flex gap-3 items-start">
                    <CreditCard className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">Check #4091</div>
                      <div className="text-xs text-slate-500">Payment Method</div>
                    </div>
                  </div>
                  <div className="flex gap-3 items-start">
                    <Landmark className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">First Republic Bank</div>
                      <div className="text-xs text-slate-500">Originating Institution</div>
                    </div>
                  </div>
                </div>
                
                <div className="mt-auto pt-4 flex justify-center">
                  <div className="bg-indigo-50 text-indigo-700 text-xs font-medium px-3 py-1.5 rounded-full flex items-center gap-1.5 border border-indigo-100">
                    <LinkIcon className="w-3.5 h-3.5" />
                    One Record, Two Roles
                  </div>
                </div>
              </div>
            </div>

            {/* Column 3: ACCOUNTING (QB record) */}
            <div className="bg-white rounded-xl border-2 border-indigo-100 shadow-sm flex flex-col h-full z-10">
              <div className="px-5 py-4 border-b border-indigo-50 flex items-center justify-between bg-indigo-50/30 rounded-t-xl">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Accounting <span className="text-slate-400 font-normal normal-case">(QB)</span></h2>
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="p-5 flex-1 flex flex-col gap-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">QuickBooks Deposit</div>
                    <div className="text-2xl font-semibold text-slate-900 font-mono tracking-tight">$50,000.00</div>
                    <div className="text-sm text-slate-500 mt-0.5">Line ID: QBD-99120 • Oct 15, 2025</div>
                  </div>
                </div>

                <div className="space-y-3 mt-2 pt-4 border-t border-slate-100">
                  <div className="flex gap-3 items-start">
                    <Building className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">WF Foundation Entity</div>
                      <div className="text-xs text-slate-500">Attribution</div>
                    </div>
                  </div>
                  <div className="flex gap-3 items-start">
                    <Calendar className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">FY 2026</div>
                      <div className="text-xs text-slate-500">Fiscal Year</div>
                    </div>
                  </div>
                  <div className="flex gap-3 items-start">
                    <FileDigit className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">40100 - Without Donor Restrictions</div>
                      <div className="text-xs text-slate-500">Revenue Code</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
          
          <div className="mt-8 bg-slate-100 border border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Links & Lineage</h3>
            <div className="flex items-center gap-4 text-sm">
              <div className="bg-white border border-slate-300 px-3 py-2 rounded shadow-sm flex items-center gap-2">
                <span className="font-mono text-slate-600">G-9021</span>
                <span className="text-slate-400">↔</span>
                <span className="font-mono text-slate-600">DEP-8821</span>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400" />
              <div className="text-slate-600 font-medium">Link established Nov 2, 2025 by System Auto-Match</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
