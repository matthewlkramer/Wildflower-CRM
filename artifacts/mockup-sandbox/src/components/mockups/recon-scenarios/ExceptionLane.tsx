import React from "react";
import {
  AlertTriangle,
  RefreshCcw,
  Archive,
  CreditCard,
  Landmark,
  FileText,
  Link as LinkIcon,
  Info,
  History,
  ShieldAlert,
  ArrowRight,
  ExternalLink,
  CheckCircle2,
  Layers
} from "lucide-react";

export function ExceptionLane() {
  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Header */}
      <header className="px-5 py-3 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center shadow-sm">
            <AlertTriangle className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight text-slate-900">Exception Lane</h1>
            <p className="text-xs text-slate-500 font-medium">Reconciliation Workbench</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
            4 active exceptions
          </span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto flex flex-col gap-6">

          <div className="mb-2">
            <h2 className="text-lg font-semibold text-slate-900">Requires Attention</h2>
            <p className="text-sm text-slate-500">Money whose transaction path cannot be cleanly linked. Review and resolve.</p>
          </div>

          {/* Exception 1: Missing Charge Detail */}
          <div className="bg-white border border-rose-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
            <div className="bg-rose-50/50 border-b border-rose-100 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-rose-600" />
                <h3 className="font-semibold text-rose-900 text-sm">Historical Import Gap</h3>
              </div>
              <span className="text-xs font-medium text-rose-700 bg-rose-100 px-2 py-0.5 rounded">Action Required</span>
            </div>
            <div className="p-5 flex gap-6">
              <div className="flex-1">
                <div className="text-sm text-slate-900 font-medium mb-1">Stripe Payout po_1M29x... is missing charge details.</div>
                <div className="text-sm text-slate-500 mb-4">
                  This payout was imported before granular charge tracking was enabled. The $1,250.00 deposit exists in QuickBooks, but the underlying donors cannot be individually matched via Stripe API.
                </div>
                <div className="flex items-center gap-3">
                  <button className="text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded shadow-sm transition-colors flex items-center gap-1.5">
                    <RefreshCcw className="w-3.5 h-3.5" /> Re-pull Stripe Data
                  </button>
                  <button className="text-xs font-medium bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded shadow-sm transition-colors">
                    Tie to coarse deposit-level Gift
                  </button>
                </div>
              </div>
              <div className="w-48 shrink-0 bg-slate-50 rounded-lg p-3 border border-slate-100 flex flex-col justify-center">
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase tracking-wider">Affected Amount</div>
                <div className="text-lg font-mono font-medium text-slate-900">$1,250.00</div>
                <div className="text-xs text-slate-400 mt-2">Payout date: Jan 12, 2025</div>
              </div>
            </div>
          </div>

          {/* Exception 2: Refunded Stripe Donation */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
            <div className="bg-slate-50/50 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Archive className="w-4 h-4 text-slate-500" />
                <h3 className="font-semibold text-slate-900 text-sm">Refunded Donation</h3>
              </div>
              <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/> Resolved (Trail Visible)</span>
            </div>
            <div className="p-5 flex gap-6">
              <div className="flex-1">
                <div className="text-sm text-slate-900 font-medium mb-1">Stripe Charge ch_3M92x... was refunded.</div>
                <div className="text-sm text-slate-500 mb-4">
                  The reversing entry in QuickBooks netted the original deposit to zero. The original Gift #8912 has been archived. No further action needed.
                </div>
                <div className="flex items-center gap-3">
                  <a href="#" className="text-xs font-medium text-blue-600 hover:underline flex items-center gap-1">
                    View Gift #8912 <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
              <div className="w-48 shrink-0 bg-slate-50 rounded-lg p-3 border border-slate-100 flex flex-col justify-center">
                <div className="flex justify-between items-center mb-1">
                  <div className="text-xs text-slate-500 font-medium uppercase tracking-wider">Charge</div>
                  <div className="text-sm font-mono font-medium text-slate-900">$500.00</div>
                </div>
                <div className="flex justify-between items-center">
                  <div className="text-xs text-rose-500 font-medium uppercase tracking-wider">Refund</div>
                  <div className="text-sm font-mono font-medium text-rose-600">-$500.00</div>
                </div>
                <div className="border-t border-slate-200 my-2"></div>
                <div className="flex justify-between items-center">
                  <div className="text-xs text-slate-500 font-medium uppercase tracking-wider">Net</div>
                  <div className="text-sm font-mono font-medium text-slate-400">$0.00</div>
                </div>
              </div>
            </div>
          </div>

          {/* Exception 3: PayPal Donation without settlement */}
          <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
            <div className="bg-amber-50/50 border-b border-amber-100 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-600" />
                <h3 className="font-semibold text-amber-900 text-sm">Orphaned Platform Signal</h3>
              </div>
              <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded">Known Gap</span>
            </div>
            <div className="p-5 flex gap-6">
              <div className="flex-1">
                <div className="text-sm text-slate-900 font-medium mb-1">Donorbox PayPal donation has no API payout trail.</div>
                <div className="text-sm text-slate-500 mb-4">
                  A $100 donation from Michael Chen was recorded via Donorbox using PayPal. Because we do not ingest PayPal API settlement data, this record lacks a transaction leg. It ties to the books only via an eventual manual deposit.
                </div>
                <div className="flex items-center gap-3">
                  <button className="text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded shadow-sm transition-colors flex items-center gap-1.5">
                    <LinkIcon className="w-3.5 h-3.5" /> Force link to QB Deposit
                  </button>
                </div>
              </div>
              <div className="w-48 shrink-0 bg-slate-50 rounded-lg p-3 border border-slate-100 flex flex-col justify-center">
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase tracking-wider">Amount</div>
                <div className="text-lg font-mono font-medium text-slate-900">$100.00</div>
                <div className="text-xs text-slate-400 mt-2">Source: Donorbox (PayPal)</div>
              </div>
            </div>
          </div>

          {/* Exception 4: Dual Claims */}
          <div className="bg-white border border-blue-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
            <div className="bg-blue-50/50 border-b border-blue-100 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-600" />
                <h3 className="font-semibold text-blue-900 text-sm">Dual Source Claim</h3>
              </div>
              <span className="text-xs font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded">Review Required</span>
            </div>
            <div className="p-5 flex gap-6">
              <div className="flex-1">
                <div className="text-sm text-slate-900 font-medium mb-1">Deposit line claimed by two systems.</div>
                <div className="text-sm text-slate-500 mb-4">
                  QuickBooks Deposit DEP-8812 is linked to both a Donorbox ACH signal and a manual check scan.
                  Count the settling record once, and mark the other as corroborating evidence.
                </div>
                
                <div className="space-y-2 mt-4 bg-slate-50 rounded-lg p-3 border border-slate-100">
                   <label className="flex items-center gap-3 cursor-pointer">
                     <input type="radio" name="claim" className="w-4 h-4 text-blue-600 border-slate-300 focus:ring-blue-600" defaultChecked />
                     <div>
                       <div className="text-sm font-medium text-slate-900">Make Donorbox ACH the <span className="font-semibold">counted</span> record</div>
                       <div className="text-xs text-slate-500">Keep QB Check as corroborating evidence</div>
                     </div>
                   </label>
                   <label className="flex items-center gap-3 cursor-pointer opacity-70">
                     <input type="radio" name="claim" className="w-4 h-4 text-blue-600 border-slate-300 focus:ring-blue-600" />
                     <div>
                       <div className="text-sm font-medium text-slate-900">Make QB Check the <span className="font-semibold">counted</span> record</div>
                       <div className="text-xs text-slate-500">Keep Donorbox ACH as corroborating evidence</div>
                     </div>
                   </label>
                </div>
                
                <div className="mt-4">
                  <button className="text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded shadow-sm transition-colors">
                    Resolve Conflict
                  </button>
                </div>
              </div>
              <div className="w-48 shrink-0 bg-slate-50 rounded-lg p-3 border border-slate-100 flex flex-col justify-center">
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase tracking-wider">Deposit DEP-8812</div>
                <div className="text-lg font-mono font-medium text-slate-900">$2,500.00</div>
                <div className="text-xs text-slate-400 mt-2">Meadow Fund</div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
