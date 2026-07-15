import React, { useState } from "react";
import { 
  Check, 
  Search, 
  AlertCircle, 
  ArrowRight, 
  Building,
  User,
  CreditCard,
  Landmark,
  FileText,
  X,
  Link as LinkIcon,
  Plus,
  Clock,
  Split,
  Undo2,
  Filter,
  CheckCircle2,
  Ban,
  Layers,
  Sparkles
} from "lucide-react";

type ItemState = "auto-matched" | "partial-lump" | "no-match";

interface WorkItem {
  id: string;
  source: "QuickBooks" | "Stripe";
  type: "Deposit Lump" | "Charge" | "Payment";
  payer: string;
  amount: number;
  date: string;
  state: ItemState;
  stateLabel: string;
}

const ITEMS: WorkItem[] = [
  {
    id: "item-1",
    source: "Stripe",
    type: "Charge",
    payer: "Sarah Jenkins",
    amount: 250.00,
    date: "Oct 10, 2026",
    state: "auto-matched",
    stateLabel: "Matched — Review"
  },
  {
    id: "item-2",
    source: "QuickBooks",
    type: "Deposit Lump",
    payer: "Stripe Payout ST-4912",
    amount: 4210.00,
    date: "Oct 12, 2026",
    state: "partial-lump",
    stateLabel: "Lump: 2 of 3 tied"
  },
  {
    id: "item-3",
    source: "QuickBooks",
    type: "Payment",
    payer: "Check #9912 - John Doe",
    amount: 500.00,
    date: "Oct 13, 2026",
    state: "no-match",
    stateLabel: "No match found"
  }
];

const formatCurrency = (n: number) => 
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export function MatchDesk() {
  const [selectedId, setSelectedId] = useState("item-2");
  const [searchQuery, setSearchQuery] = useState("");

  const selectedItem = ITEMS.find(i => i.id === selectedId) || ITEMS[1];

  const renderStateIcon = (state: ItemState) => {
    switch (state) {
      case "auto-matched": return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />;
      case "partial-lump": return <Split className="w-3.5 h-3.5 text-blue-600" />;
      case "no-match": return <AlertCircle className="w-3.5 h-3.5 text-amber-600" />;
    }
  };

  const renderStateBadge = (state: ItemState, label: string) => {
    const base = "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider";
    switch (state) {
      case "auto-matched": return <span className={`${base} bg-emerald-50 text-emerald-700 border border-emerald-200/60`}>{renderStateIcon(state)} {label}</span>;
      case "partial-lump": return <span className={`${base} bg-blue-50 text-blue-700 border border-blue-200/60`}>{renderStateIcon(state)} {label}</span>;
      case "no-match": return <span className={`${base} bg-amber-50 text-amber-700 border border-amber-200/60`}>{renderStateIcon(state)} {label}</span>;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Header */}
      <header className="px-5 py-3 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center shadow-sm">
            <LinkIcon className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight text-slate-900">Match Desk</h1>
            <p className="text-xs text-slate-500 font-medium">Reconciliation Workbench</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-md hover:bg-slate-100 transition-colors">
            Queue: All Unreconciled (24)
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left Pane: Work List */}
        <div className="w-[380px] bg-white border-r border-slate-200 flex flex-col shrink-0 z-10 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.05)]">
          <div className="p-3 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Filter work list..." 
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-slate-200 rounded shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-400"
              />
            </div>
            <button className="p-1.5 border border-slate-200 rounded bg-white text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-900">
              <Filter className="w-3.5 h-3.5" />
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {ITEMS.map(item => {
              const isSelected = selectedId === item.id;
              return (
                <button 
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left p-3 rounded-lg border transition-all duration-200 flex flex-col gap-2 relative overflow-hidden ${
                    isSelected 
                      ? 'bg-blue-50/40 border-blue-200 shadow-sm ring-1 ring-blue-500/10' 
                      : 'bg-white border-slate-200/60 hover:border-slate-300 hover:shadow-sm'
                  }`}
                >
                  {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500" />}
                  
                  <div className="flex justify-between items-start w-full">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      {item.source === "QuickBooks" ? <Landmark className="w-3.5 h-3.5" /> : <CreditCard className="w-3.5 h-3.5" />}
                      {item.type}
                    </div>
                    <span className="text-xs text-slate-400 font-mono">{item.date}</span>
                  </div>
                  
                  <div className="flex justify-between items-end w-full">
                    <span className="text-sm font-medium text-slate-900 truncate pr-3">{item.payer}</span>
                    <span className="text-sm font-semibold text-slate-900 font-mono tracking-tight">{formatCurrency(item.amount)}</span>
                  </div>
                  
                  <div className="mt-1">
                    {renderStateBadge(item.state, item.stateLabel)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Pane: Inspector / Match Space */}
        <div className="flex-1 flex flex-col overflow-y-auto bg-slate-50/50">
          
          {/* Detailed Header */}
          <div className="bg-white border-b border-slate-200 px-8 py-6 shrink-0">
            <div className="flex justify-between items-start mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-medium uppercase tracking-widest flex items-center gap-1.5">
                    {selectedItem.source === "QuickBooks" ? <Landmark className="w-3 h-3" /> : <CreditCard className="w-3 h-3" />}
                    {selectedItem.source} {selectedItem.type}
                  </span>
                  <span className="text-sm text-slate-400 font-mono px-2 border-l border-slate-200">{selectedItem.date}</span>
                </div>
                <h2 className="text-2xl font-semibold text-slate-900">{selectedItem.payer}</h2>
              </div>
              <div className="text-right">
                <div className="text-3xl font-light font-mono text-slate-900 tracking-tight">{formatCurrency(selectedItem.amount)}</div>
                {selectedItem.source === "Stripe" && (
                  <div className="text-xs text-slate-500 font-mono mt-1">
                    Gross: $257.90 • Fee: -$7.90
                  </div>
                )}
              </div>
            </div>
            
            {/* Raw Facts Grid */}
            <div className="grid grid-cols-4 gap-6 pt-4 border-t border-slate-100 mt-2">
              <div>
                <span className="block text-[10px] uppercase tracking-widest text-slate-400 font-medium mb-1">Source Ref</span>
                <span className="text-sm font-mono text-slate-700">{selectedItem.source === "QuickBooks" ? "DEP-90214" : "ch_3P9ZqL..."}</span>
              </div>
              <div className="col-span-2">
                <span className="block text-[10px] uppercase tracking-widest text-slate-400 font-medium mb-1">Memo / Descriptor</span>
                <span className="text-sm text-slate-700 truncate block">{selectedItem.source === "QuickBooks" ? "STRIPE PAYOUT ST-4912 SETTLEMENT" : "WILDFLOWER CRM DONATION"}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-widest text-slate-400 font-medium mb-1">Entity Marker</span>
                <span className="text-sm text-slate-700">None detected</span>
              </div>
            </div>
          </div>

          <div className="flex-1 p-8 overflow-y-auto flex flex-col gap-6 max-w-5xl mx-auto w-full">
            
            {/* --- STATE: PARTIAL LUMP --- */}
            {selectedItem.state === "partial-lump" && (
              <>
                {/* Matches Space for Lump */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-slate-500" />
                      <h3 className="font-semibold text-slate-900 text-sm">Lump Settlement Components</h3>
                    </div>
                    <div className="flex items-center gap-4 text-sm font-mono">
                      <div className="text-slate-500">Tied: <span className="text-emerald-600 font-medium">$4,000.00</span></div>
                      <div className="text-slate-500">Gap: <span className="text-amber-600 font-medium">$210.00</span></div>
                      <div className="h-4 w-px bg-slate-300"></div>
                      <div className="text-slate-900 font-medium">Total: $4,210.00</div>
                    </div>
                  </div>
                  <div className="px-5 py-1.5 border-b border-slate-100 bg-slate-50/30 text-[11px] text-slate-400 font-mono">
                    Charge amounts shown net of Stripe fees • gross $4,335.40 − fees $125.40 = deposit $4,210.00
                  </div>
                  
                  {/* Running Tally Bar */}
                  <div className="h-1.5 w-full bg-slate-100 flex">
                    <div className="h-full bg-emerald-500" style={{ width: '95%' }}></div>
                    <div className="h-full bg-amber-400" style={{ width: '5%' }}></div>
                  </div>

                  <div className="p-0">
                    {/* Tied Items */}
                    <div className="border-b border-slate-100 bg-emerald-50/30 p-4 flex items-center justify-between group">
                      <div className="flex items-center gap-4">
                        <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                          <Check className="w-4 h-4 text-emerald-600" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-slate-900">Stripe Charge • ch_8819Lx...</div>
                          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                            <span className="font-mono">Oct 10</span> 
                            <span>•</span> 
                            <span>Tied to <a href="#" className="text-blue-600 hover:underline">Gift #4012</a> (Alice Walker)</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-sm font-mono font-medium text-slate-900">$3,000.00</div>
                        <button className="text-slate-400 hover:text-rose-600 transition-colors opacity-0 group-hover:opacity-100" title="Undo tie">
                          <Undo2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="border-b border-slate-100 bg-emerald-50/30 p-4 flex items-center justify-between group">
                      <div className="flex items-center gap-4">
                        <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                          <Check className="w-4 h-4 text-emerald-600" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-slate-900">Stripe Charge • ch_9921Bz...</div>
                          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                            <span className="font-mono">Oct 11</span> 
                            <span>•</span> 
                            <span>Tied to <a href="#" className="text-blue-600 hover:underline">Gift #4013</a> (Tech Corp)</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-sm font-mono font-medium text-slate-900">$1,000.00</div>
                        <button className="text-slate-400 hover:text-rose-600 transition-colors opacity-0 group-hover:opacity-100" title="Undo tie">
                          <Undo2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Candidate to close the gap */}
                    <div className="p-4 bg-white">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 ml-12">Candidate to close $210.00 gap</div>
                      
                      <div className="ml-12 border border-blue-200 rounded-lg p-4 bg-blue-50/30 flex items-start justify-between relative overflow-hidden">
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-400"></div>
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-900">Stripe Charge • ch_7710Mn...</span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 uppercase tracking-widest"><Check className="w-3 h-3" /> Amount Exact</span>
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-blue-100 text-blue-700 uppercase tracking-widest"><Clock className="w-3 h-3" /> Date -1d</span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1">Already matched to <a href="#" className="text-blue-600 hover:underline">Gift #4018</a> (Marcus Dean)</div>
                        </div>
                        <div className="flex flex-col items-end gap-3">
                          <div className="text-base font-mono font-semibold text-slate-900">$210.00</div>
                          <button className="text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded shadow-sm transition-colors flex items-center gap-1.5">
                            <Check className="w-3.5 h-3.5" /> Tie to Lump
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* --- STATE: AUTO-MATCHED --- */}
            {selectedItem.state === "auto-matched" && (
              <>
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
                  <div className="flex items-center gap-2 mb-6 border-b border-slate-100 pb-4">
                    <Sparkles className="w-4 h-4 text-emerald-500" />
                    <h3 className="font-semibold text-slate-900 text-sm">System Match Proposal</h3>
                  </div>

                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded bg-slate-100 flex items-center justify-center shrink-0">
                        <User className="w-5 h-5 text-slate-500" />
                      </div>
                      <div>
                        <div className="text-base font-medium text-slate-900">Sarah Jenkins</div>
                        <div className="text-sm text-slate-500">Individual • Donor since 2022</div>
                        <div className="mt-3 flex gap-2">
                           <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 uppercase tracking-widest"><Check className="w-3 h-3" /> Name 100%</span>
                           <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 uppercase tracking-widest"><Check className="w-3 h-3" /> Amount Exact</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                       <button className="text-sm font-medium bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-md shadow-sm transition-colors flex items-center gap-2">
                         <Check className="w-4 h-4" /> Accept & Create Gift
                       </button>
                       <button className="text-xs text-slate-500 hover:text-slate-900 font-medium px-2 py-1">
                         Reject candidate
                       </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* --- STATE: NO MATCH / SEARCH --- */}
            {selectedItem.state === "no-match" && (
              <>
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Search className="w-4 h-4 text-slate-500" />
                      <h3 className="font-semibold text-slate-900 text-sm">Hunting for Match</h3>
                    </div>
                  </div>
                  
                  <div className="p-5 border-b border-slate-100">
                    <div className="relative max-w-md">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input 
                        type="text" 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search donors, gifts, or pledges..." 
                        className="w-full pl-9 pr-4 py-2 text-sm bg-white border border-slate-200 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-400"
                      />
                    </div>
                  </div>

                  <div className="p-0">
                    {/* Search Results (Hardcoded Mock) */}
                    <div className="flex flex-col">
                      
                      {/* Valid Create Action */}
                      <div className="p-4 border-b border-slate-100 hover:bg-slate-50 flex items-center justify-between group transition-colors">
                        <div className="flex items-center gap-4">
                          <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center shrink-0">
                            <User className="w-4 h-4 text-slate-500" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-900">John Doe</div>
                            <div className="text-xs text-slate-500">Individual • ID: P-8192</div>
                          </div>
                        </div>
                        <button className="text-xs font-medium bg-white border border-slate-200 hover:border-blue-400 hover:text-blue-700 text-slate-700 px-3 py-1.5 rounded shadow-sm transition-all flex items-center gap-1.5">
                          <Plus className="w-3.5 h-3.5" /> Assign Donor & Create Gift
                        </button>
                      </div>

                      {/* Blocked Candidate 1 */}
                      <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between opacity-75">
                        <div className="flex items-center gap-4">
                          <div className="w-8 h-8 rounded bg-slate-200/50 flex items-center justify-center shrink-0">
                            <FileText className="w-4 h-4 text-slate-400" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-500">Pledge #102 (Johnathan Doe)</div>
                            <div className="text-xs text-slate-400 font-mono">Expected: $1,000.00</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 bg-slate-100 px-2.5 py-1 rounded text-xs font-medium text-slate-500 border border-slate-200">
                          <Ban className="w-3.5 h-3.5" /> Amount mismatch
                        </div>
                      </div>

                      {/* Blocked Candidate 2 */}
                      <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between opacity-75">
                        <div className="flex items-center gap-4">
                          <div className="w-8 h-8 rounded bg-slate-200/50 flex items-center justify-center shrink-0">
                            <CheckCircle2 className="w-4 h-4 text-slate-400" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-500">Gift #1842 (John Doe)</div>
                            <div className="text-xs text-slate-400 font-mono">Amount: $500.00</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 bg-slate-100 px-2.5 py-1 rounded text-xs font-medium text-slate-500 border border-slate-200">
                          <Ban className="w-3.5 h-3.5" /> Already tied to a payment
                        </div>
                      </div>

                      {/* Blocked Candidate 3 — overridable exclusion */}
                      <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between opacity-75">
                        <div className="flex items-center gap-4">
                          <div className="w-8 h-8 rounded bg-slate-200/50 flex items-center justify-center shrink-0">
                            <X className="w-4 h-4 text-slate-400" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-500">Stripe Charge • ch_5502Qr... (Jane Doe)</div>
                            <div className="text-xs text-slate-400 font-mono">Amount: $210.00</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-2 bg-slate-100 px-2.5 py-1 rounded text-xs font-medium text-slate-500 border border-slate-200">
                            <Ban className="w-3.5 h-3.5" /> Excluded — refund
                          </div>
                          <button className="text-xs font-medium bg-white border border-slate-200 hover:border-blue-400 hover:text-blue-700 text-slate-600 px-2.5 py-1 rounded shadow-sm transition-all flex items-center gap-1">
                            <Undo2 className="w-3 h-3" /> Re-include
                          </button>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>

                {/* Explicit manual actions since no automatic match */}
                <div className="flex gap-3 mt-4">
                  <button className="text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-md shadow-sm transition-colors flex items-center gap-2">
                    <Plus className="w-4 h-4" /> Create New Gift (No Donor Yet)
                  </button>
                  <button className="text-sm font-medium bg-white border border-slate-200 text-slate-600 hover:text-rose-600 hover:bg-rose-50 hover:border-rose-200 px-4 py-2 rounded-md shadow-sm transition-colors flex items-center gap-2">
                    <X className="w-4 h-4" /> Exclude with Reason...
                  </button>
                </div>
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

