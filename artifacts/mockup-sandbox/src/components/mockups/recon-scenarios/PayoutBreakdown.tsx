import React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Link as LinkIcon, AlertCircle, FileText, Banknote, CreditCard, Layers, ArrowRight, MinusCircle, Check } from "lucide-react";

export function PayoutBreakdown() {
  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-900 rounded flex items-center justify-center shadow-sm">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight text-slate-900">Payout Breakdown</h1>
            <p className="text-sm text-slate-500 font-medium">po_1QrX92L... → DEP-3391</p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="font-medium text-slate-600">
          Close Breakdown
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-8 flex flex-col gap-6 max-w-5xl mx-auto w-full">
        {/* Settlement Overview */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                <CreditCard className="w-5 h-5 text-slate-500" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-900">Stripe Payout</div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">po_1QrX92L4KqT</div>
              </div>
            </div>
            
            <div className="flex flex-col items-center px-4">
              <div className="text-xs font-semibold uppercase tracking-widest text-emerald-600 mb-1">Settled</div>
              <ArrowRight className="w-5 h-5 text-emerald-500" />
            </div>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                <Banknote className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-900">QB Deposit</div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">DEP-3391</div>
              </div>
            </div>
          </div>
          
          <div className="text-right">
            <div className="text-3xl font-light font-mono text-slate-900 tracking-tight">$4,850.00</div>
            <div className="text-xs text-slate-500 font-mono mt-1">
              4 charges ($5,000.00 gross) - fees ($150.00)
            </div>
          </div>
        </div>

        {/* Warning about supersede */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3 text-sm text-blue-800">
          <LinkIcon className="w-5 h-5 shrink-0 text-blue-600" />
          <p>
            <strong>Note on linking:</strong> Individual charge links will supersede any gift links on the main QB deposit. The $4,850.00 deposit will not be double-counted.
          </p>
        </div>

        {/* Charges List */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
            <h3 className="font-semibold text-slate-900 text-sm">Payout Components</h3>
            <div className="flex items-center gap-4 text-sm font-mono">
              <div className="text-slate-500">Matched: <span className="text-emerald-600 font-medium">$4,750.00</span> gross</div>
              <div className="text-slate-500">Unmatched: <span className="text-amber-600 font-medium">$250.00</span> gross</div>
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {/* Charge 1 - Matched */}
            <div className="p-4 flex items-center justify-between bg-emerald-50/30">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded bg-emerald-100 flex items-center justify-center shrink-0">
                  <Check className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-900">Stripe Charge • ch_3Nh...</div>
                  <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                    <span className="font-mono">Oct 14, 2026</span>
                    <span>•</span>
                    <span>Tied to <a href="#" className="text-blue-600 hover:underline">Gift #4102</a> (Meadow Fund)</span>
                  </div>
                </div>
              </div>
              <div className="text-right font-mono">
                <div className="text-sm font-medium text-slate-900">$2,500.00</div>
                <div className="text-xs text-slate-400">Net: $2,425.00</div>
              </div>
            </div>

            {/* Charge 2 - Matched */}
            <div className="p-4 flex items-center justify-between bg-emerald-50/30">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded bg-emerald-100 flex items-center justify-center shrink-0">
                  <Check className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-900">Stripe Charge • ch_8Lx...</div>
                  <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                    <span className="font-mono">Oct 14, 2026</span>
                    <span>•</span>
                    <span>Tied to <a href="#" className="text-blue-600 hover:underline">Gift #4105</a> (Chan Zuckerberg Initiative)</span>
                  </div>
                </div>
              </div>
              <div className="text-right font-mono">
                <div className="text-sm font-medium text-slate-900">$1,000.00</div>
                <div className="text-xs text-slate-400">Net: $970.00</div>
              </div>
            </div>

            {/* Charge 3 - Matched */}
            <div className="p-4 flex items-center justify-between bg-emerald-50/30">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded bg-emerald-100 flex items-center justify-center shrink-0">
                  <Check className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-900">Stripe Charge • ch_9Zq...</div>
                  <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                    <span className="font-mono">Oct 14, 2026</span>
                    <span>•</span>
                    <span>Tied to <a href="#" className="text-blue-600 hover:underline">Gift #4108</a> (Third Coast Foundation)</span>
                  </div>
                </div>
              </div>
              <div className="text-right font-mono">
                <div className="text-sm font-medium text-slate-900">$1,250.00</div>
                <div className="text-xs text-slate-400">Net: $1,212.50</div>
              </div>
            </div>

            {/* Charge 4 - Unmatched */}
            <div className="p-4 flex items-center justify-between bg-amber-50/30">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded bg-amber-100 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-4 h-4 text-amber-600" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-900">Stripe Charge • ch_1Fp...</div>
                  <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                    <span className="font-mono">Oct 14, 2026</span>
                    <span>•</span>
                    <span className="text-amber-700 font-medium">Unreconciled</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <Button size="sm" variant="outline" className="h-7 text-xs border-amber-200 text-amber-700 hover:bg-amber-100">
                  Find Match
                </Button>
                <div className="text-right font-mono">
                  <div className="text-sm font-medium text-slate-900">$250.00</div>
                  <div className="text-xs text-slate-400">Net: $242.50</div>
                </div>
              </div>
            </div>

            {/* Fees Line */}
            <div className="p-4 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded bg-slate-200 flex items-center justify-center shrink-0">
                  <MinusCircle className="w-4 h-4 text-slate-500" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-700">Stripe Processing Fees</div>
                  <div className="text-xs text-slate-500 mt-0.5">Auto-claimed as operational expense</div>
                </div>
              </div>
              <div className="text-right font-mono">
                <div className="text-sm font-medium text-slate-500">-$150.00</div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
