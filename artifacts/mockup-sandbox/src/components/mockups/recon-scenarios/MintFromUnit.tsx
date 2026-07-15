import React from "react";
import { 
  Plus, 
  Search, 
  AlertCircle, 
  Ban, 
  ArrowRight,
  Landmark,
  Building,
  User,
  Calendar,
  CheckCircle2,
  FileText
} from "lucide-react";

export function MintFromUnit() {
  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold leading-tight text-slate-900">Unmatched Payment</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Needs action to reconcile</p>
        </div>
      </header>

      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-4xl mx-auto flex flex-col gap-6">
          
          {/* The Unit in question */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex justify-between items-start">
             <div className="flex gap-4">
               <div className="w-12 h-12 rounded bg-indigo-50 flex items-center justify-center border border-indigo-100 shrink-0">
                 <Landmark className="w-6 h-6 text-indigo-600" />
               </div>
               <div>
                 <div className="flex items-center gap-2 mb-1">
                   <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium uppercase tracking-widest">ACH Deposit</span>
                   <span className="text-xs text-slate-400 font-mono">QBD-10924</span>
                 </div>
                 <h2 className="text-xl font-semibold text-slate-900">Hollyhock Family Fund</h2>
                 <p className="text-sm text-slate-500 mt-1 max-w-md">Memo: 2026 GENERAL GRANT INSTALLMENT #1 / REF 89912A</p>
               </div>
             </div>
             <div className="text-right">
               <div className="text-3xl font-semibold font-mono tracking-tight text-slate-900">$10,000.00</div>
               <div className="text-sm text-slate-500 mt-1 font-mono">Oct 28, 2025</div>
             </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-2">Actions</h3>
            
            {/* Primary Action: Mint */}
            <div className="bg-white border-2 border-indigo-500 rounded-xl shadow-sm p-5 hover:bg-indigo-50/30 transition-colors cursor-pointer group">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                  <Plus className="w-5 h-5 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-slate-900 group-hover:text-indigo-700 transition-colors">Mint New Gift</h3>
                  <p className="text-sm text-slate-500 mt-1">Create a new CRM record from this payment. We've pre-filled what we can.</p>
                  
                  <div className="mt-4 grid grid-cols-3 gap-3">
                    <div className="bg-slate-50 border border-slate-100 p-3 rounded">
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">Guessed Donor</div>
                      <div className="text-sm font-medium text-slate-900 flex items-center gap-1.5"><Building className="w-3.5 h-3.5 text-slate-400"/> Hollyhock Family Fund</div>
                    </div>
                    <div className="bg-slate-50 border border-slate-100 p-3 rounded">
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">Entity</div>
                      <div className="text-sm font-medium text-slate-900 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500"/> Detected (WF Org)</div>
                    </div>
                    <div className="bg-slate-50 border border-slate-100 p-3 rounded">
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">Allocation</div>
                      <div className="text-sm font-medium text-slate-900">General Operating</div>
                    </div>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-indigo-400 group-hover:text-indigo-600 group-hover:translate-x-1 transition-all" />
              </div>
            </div>

            {/* Alternative Action: Apply to Pledge */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
              <div className="flex items-center gap-3 mb-4">
                <FileText className="w-5 h-5 text-slate-500" />
                <h3 className="text-base font-semibold text-slate-900">Apply to Open Pledge</h3>
              </div>
              
              <div className="space-y-2">
                <div className="p-3 border border-slate-200 rounded-lg hover:border-slate-300 hover:bg-slate-50 cursor-pointer flex justify-between items-center transition-colors">
                  <div>
                    <div className="text-sm font-medium text-slate-900">Pledge #P-2910 • Hollyhock Family Fund</div>
                    <div className="text-xs text-slate-500 mt-0.5">Expected: Oct 2025</div>
                  </div>
                  <div className="text-sm font-mono font-medium text-slate-900">$10,000.00</div>
                </div>
                
                {/* Greyed out unpickable item */}
                <div className="p-3 border border-slate-100 rounded-lg bg-slate-50/50 flex justify-between items-center opacity-70">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-500">Pledge #P-1802 • Hollyhock Family Fund</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-400 font-mono">Expected: Mar 2025</span>
                      <span className="inline-flex items-center gap-1 bg-slate-200 px-2 py-0.5 rounded text-[10px] font-semibold text-slate-600 uppercase tracking-widest"><Ban className="w-3 h-3" /> Amount mismatch</span>
                    </div>
                  </div>
                  <div className="text-sm font-mono font-medium text-slate-400 line-through">$5,000.00</div>
                </div>
              </div>
            </div>

            {/* Alternative Action: Exclude */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 hover:bg-slate-50 transition-colors cursor-pointer group">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center shrink-0">
                    <Ban className="w-4 h-4 text-slate-500" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-slate-900 group-hover:text-slate-700 transition-colors">Exclude as Non-Donation</h3>
                    <p className="text-sm text-slate-500">Mark as transfer, fee refund, or other non-revenue.</p>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-slate-500 transition-colors" />
              </div>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}
