import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  Search, Filter, CheckCircle2, AlertCircle, Circle, 
  Banknote, CreditCard, Ban, Link as LinkIcon, Split, 
  ArrowRight, ChevronRight, ChevronDown, GripVertical, 
  Plus, FileText, FileX, Copy, Check, FileCheck, Layers
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Status = "unreconciled" | "partial" | "linked" | "excluded";

// Each row is a UNIT OF MONEY — not anchored on any one system's record.
// The three facets are peer component SLOTS; the QB record is just the
// component that usually arrives first (money landing in QB mints most rows).
// Adequacy problems (e.g. coding gaps) live INSIDE the owning component's chip.
// LINKAGE = is the slot filled at all; ADEQUACY = is the filled component complete.

type ComponentState = {
  present: boolean;
  adequate?: boolean;
  ref?: string;      // record identity, e.g. "DEP-8821 · QB Deposit"
  detail?: string;   // adequate supporting detail, e.g. coding
  problem?: string;  // inadequacy reason, shown INSIDE the chip
  hint?: string;     // why an empty slot is empty
};

interface MainQueueItem {
  id: string;
  date: string;
  amount: number;
  status: Status;
  description: string;
  exclusionReason?: string;
  whoWhy: ComponentState;
  transaction?: ComponentState;
  accounting?: ComponentState;
  // A check: ONE QB record fills both the transaction and accounting roles,
  // each role carrying its own adequacy.
  qbSpan?: {
    ref: string;
    txn: { adequate: boolean; note: string };
    acct: { adequate: boolean; note: string };
  };
  isExpanded?: boolean;
}

const MAIN_DATA: MainQueueItem[] = [
  {
    id: "item-1",
    date: "Oct 15, 2026",
    amount: 150000.00,
    status: "partial",
    description: "Wire Transfer - Meadow Fund",
    whoWhy: {
      present: true,
      adequate: true,
      ref: "Meadow Fund Commitment",
      detail: "Grant letter on file"
    },
    transaction: {
      present: true,
      adequate: false,
      ref: "Wire TR-991",
      problem: "Missing originating bank confirmation"
    },
    accounting: {
      present: true,
      adequate: true,
      ref: "DEP-8821 · QB Deposit",
      detail: "4010 Grants · Class: National"
    },
    isExpanded: true // The exemplar
  },
  {
    id: "item-2",
    date: "Oct 12, 2026",
    amount: 25000.00,
    status: "partial",
    description: "Check deposit",
    whoWhy: {
      present: true,
      adequate: false,
      ref: "Third Coast Foundation",
      problem: "Missing grant letter"
    },
    qbSpan: {
      ref: "CHK-8812 · QB Check",
      txn: { adequate: true, note: "Check image on file" },
      acct: { adequate: false, note: "Needs account + class coding" }
    }
  },
  {
    id: "item-3",
    date: "Oct 10, 2026",
    amount: 824.10,
    status: "unreconciled",
    description: "Stripe payout (4 charges)",
    whoWhy: {
      present: false
    },
    transaction: {
      present: true,
      adequate: true,
      ref: "po_1Qxyz98 · Stripe Payout",
      detail: "4 charges itemized"
    },
    accounting: {
      present: true,
      adequate: false,
      ref: "DEP-3410 · QB Deposit",
      problem: "Missing class code"
    }
  },
  {
    id: "item-4",
    date: "Oct 18, 2026",
    amount: 250.00,
    status: "unreconciled",
    description: "Stripe charge — payout not settled",
    whoWhy: {
      present: false
    },
    transaction: {
      present: true,
      adequate: true,
      ref: "ch_3Mxyz · Stripe Charge",
      detail: "Card receipt attached"
    },
    accounting: {
      present: false,
      hint: "No QB record yet — payout not synced"
    }
  },
  {
    id: "item-5",
    date: "Oct 05, 2026",
    amount: 45.00,
    status: "excluded",
    description: "Bank fee reversal",
    exclusionReason: "Non-donation: Operating revenue",
    whoWhy: { present: false, hint: "Not needed" },
    transaction: { present: false, hint: "Not needed" },
    accounting: { present: true, adequate: true, ref: "DEP-3388 · QB Deposit", detail: "6120 Bank fees" }
  }
];

const STRAY_TRANSACTIONS = [
  { id: "st-2", ref: "CHK-1002", date: "Oct 19, 2026", amount: 5000.00, desc: "Check image upload" }
];

const STRAY_WHOWHY = [
  { id: "sw-1", name: "Prairie Sky Fund", date: "Oct 16, 2026", amount: 75000.00, desc: "Pledge - expected this month" },
  { id: "sw-2", name: "Hollyhock Family Fund", date: "Oct 17, 2026", amount: 10000.00, desc: "Annual gift" }
];

const formatCurrency = (n: number) => 
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

// A component SLOT of a money unit. Empty slots are dashed placeholders (with
// a reason when useful); filled slots carry the record's identity AND its own
// adequacy — so e.g. a coding gap shows INSIDE the QB record's chip.
const ComponentChip = ({ c }: { c: ComponentState }) => {
  if (!c.present) {
    return (
      <div className="flex flex-col items-center justify-center min-h-12 w-full rounded border border-dashed border-slate-200 bg-slate-50/50 px-2 py-1.5">
        <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Empty slot</span>
        {c.hint && <span className="text-[9px] text-slate-400 mt-0.5 text-center leading-tight">{c.hint}</span>}
      </div>
    );
  }

  if (c.adequate) {
    return (
      <div className="p-2 w-full rounded border border-emerald-200 bg-emerald-50">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span className="text-xs font-medium text-emerald-900">{c.ref}</span>
        </div>
        {c.detail && <div className="text-[10px] text-emerald-700/80 mt-0.5 pl-5 leading-tight">{c.detail}</div>}
      </div>
    );
  }

  return (
    <div className="p-2 w-full rounded border border-amber-200 bg-amber-50">
      <div className="flex items-center gap-1.5">
        <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
        <span className="text-xs font-medium text-amber-900">{c.ref}</span>
      </div>
      <span className="block text-[10px] leading-tight text-amber-700 font-medium mt-0.5 pl-5">{c.problem}</span>
    </div>
  );
};

// A check: ONE QB record filling BOTH the transaction and accounting slots,
// each role with its own adequacy signal.
const QbSpanChip = ({ span }: { span: NonNullable<MainQueueItem["qbSpan"]> }) => (
  <div className="p-2 w-full rounded border border-slate-300 bg-white">
    <div className="flex items-center gap-1.5 mb-1.5">
      <FileCheck className="w-3.5 h-3.5 text-slate-600 shrink-0" />
      <span className="text-xs font-semibold text-slate-800">{span.ref}</span>
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-auto">One record, two roles</span>
    </div>
    <div className="grid grid-cols-2 gap-1.5">
      <div className={`rounded border px-1.5 py-1 ${span.txn.adequate ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Transaction</div>
        <div className={`text-[10px] leading-tight font-medium flex items-center gap-1 mt-0.5 ${span.txn.adequate ? 'text-emerald-700' : 'text-amber-700'}`}>
          {span.txn.adequate ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <AlertCircle className="w-3 h-3 shrink-0" />}
          {span.txn.note}
        </div>
      </div>
      <div className={`rounded border px-1.5 py-1 ${span.acct.adequate ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Accounting</div>
        <div className={`text-[10px] leading-tight font-medium flex items-center gap-1 mt-0.5 ${span.acct.adequate ? 'text-emerald-700' : 'text-amber-700'}`}>
          {span.acct.adequate ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <AlertCircle className="w-3 h-3 shrink-0" />}
          {span.acct.note}
        </div>
      </div>
    </div>
  </div>
);

const StatusBadge = ({ status }: { status: Status }) => {
  const base = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider";
  switch (status) {
    case "linked": return <span className={`${base} bg-emerald-100 text-emerald-800`}>Reconciled</span>;
    case "partial": return <span className={`${base} bg-blue-100 text-blue-800`}>Partial</span>;
    case "unreconciled": return <span className={`${base} bg-amber-100 text-amber-800`}>Unreconciled</span>;
    case "excluded": return <span className={`${base} bg-slate-200 text-slate-600`}>Excluded</span>;
  }
};

export function UnbrokenQueue() {
  const [strayTxOpen, setStrayTxOpen] = useState(true);
  const [strayWhoOpen, setStrayWhoOpen] = useState(true);

  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex justify-between items-center shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center shadow-sm">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight text-slate-900">Finance Reconciliation</h1>
            <p className="text-xs text-slate-500 font-medium">Main Worklist</p>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        
        {/* MAIN WORKLIST */}
        <div className="flex-1 flex flex-col min-w-0 bg-white">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <div>
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                Money Units <Badge variant="secondary" className="bg-slate-200 text-slate-700">12 Pending</Badge>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">Each row is a unit of money — no facet is the anchor; the QB record is just one of its components.</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-64">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input placeholder="Search money units..." className="pl-8 h-8 text-xs bg-white" />
              </div>
              <Button variant="outline" size="sm" className="h-8 text-xs"><Filter className="w-3.5 h-3.5 mr-1.5"/> Filter</Button>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4">
            <div className="border border-slate-200 rounded-lg shadow-sm overflow-hidden">
              <Table>
                <TableHeader className="bg-slate-50 border-b border-slate-200">
                  <TableRow className="hover:bg-slate-50">
                    <TableHead className="w-[180px] text-xs font-semibold text-slate-600">Money Unit</TableHead>
                    <TableHead className="w-[210px] text-xs font-semibold text-slate-600">WHO & WHY (CRM)</TableHead>
                    <TableHead className="w-[210px] text-xs font-semibold text-slate-600">TRANSACTION (Proof)</TableHead>
                    <TableHead className="w-[210px] text-xs font-semibold text-slate-600">ACCOUNTING (QB record + coding)</TableHead>
                    <TableHead className="text-right text-xs font-semibold text-slate-600">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MAIN_DATA.map((item) => (
                    <React.Fragment key={item.id}>
                      <TableRow className={`group ${item.status === 'excluded' ? 'opacity-60 bg-slate-50/50' : 'hover:bg-slate-50'} ${item.isExpanded ? 'bg-slate-50' : ''}`}>
                        <TableCell className="align-top py-3">
                          <div className="flex items-start gap-2">
                            {item.isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />}
                            <div>
                              <div className="font-semibold text-sm text-slate-900">{formatCurrency(item.amount)}</div>
                              <div className="text-xs text-slate-500 font-mono mt-0.5">{item.date}</div>
                              <div className="text-xs text-slate-600 mt-1">{item.description}</div>
                              {item.exclusionReason && (
                                <div className="mt-1.5 inline-flex items-center gap-1 bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider">
                                  <Ban className="w-3 h-3" /> {item.exclusionReason}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="align-top py-3"><ComponentChip c={item.whoWhy} /></TableCell>
                        {item.qbSpan ? (
                          <TableCell colSpan={2} className="align-top py-3"><QbSpanChip span={item.qbSpan} /></TableCell>
                        ) : (
                          <>
                            <TableCell className="align-top py-3"><ComponentChip c={item.transaction ?? { present: false }} /></TableCell>
                            <TableCell className="align-top py-3"><ComponentChip c={item.accounting ?? { present: false }} /></TableCell>
                          </>
                        )}
                        <TableCell className="align-top py-3 text-right">
                          <StatusBadge status={item.status} />
                        </TableCell>
                      </TableRow>
                      
                      {/* Expanded Exemplar Record */}
                      {item.isExpanded && (
                        <TableRow className="bg-slate-50/50 border-b border-slate-200 hover:bg-slate-50/50">
                          <TableCell colSpan={5} className="p-0 border-t border-slate-200/60">
                            <div className="p-6 pl-10">
                              <div className="bg-white border border-emerald-100 rounded-lg shadow-sm p-5 max-w-4xl">
                                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-slate-100">
                                  <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 uppercase tracking-wider text-[10px] font-bold rounded">Adequate WHO & WHY Shape</Badge>
                                  <span className="text-sm font-semibold text-slate-800">Commitment: Meadow Fund 2026-2027</span>
                                </div>
                                
                                <div className="grid grid-cols-4 gap-6 mb-6">
                                  <div>
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Total Commitment</div>
                                    <div className="text-xl font-semibold text-slate-900">{formatCurrency(150000)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Schedule</div>
                                    <div className="text-sm font-medium text-slate-700">4 payments over 2 years</div>
                                  </div>
                                  <div className="col-span-2">
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Documentation</div>
                                    <div className="text-sm font-medium text-blue-600 flex items-center gap-1.5"><FileCheck className="w-3.5 h-3.5" /> grant_agreement_signed.pdf</div>
                                  </div>
                                </div>

                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Allocations (3 Purposes)</div>
                                <div className="border border-slate-200 rounded-md overflow-hidden">
                                  <Table>
                                    <TableHeader className="bg-slate-50">
                                      <TableRow>
                                        <TableHead className="text-xs h-8">Amount</TableHead>
                                        <TableHead className="text-xs h-8">Purpose / Restriction</TableHead>
                                        <TableHead className="text-xs h-8">Fiscal Year</TableHead>
                                        <TableHead className="text-xs h-8">Region</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      <TableRow>
                                        <TableCell className="py-2 text-sm font-medium">{formatCurrency(50000)}</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">General Operating Support</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">FY 2026</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">National</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell className="py-2 text-sm font-medium">{formatCurrency(50000)}</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">Technology Initiative (Restricted)</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">FY 2026</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">National</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell className="py-2 text-sm font-medium">{formatCurrency(50000)}</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">General Operating Support</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">FY 2027</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">National</TableCell>
                                      </TableRow>
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>

        {/* SIDEBAR: STRAY LISTS */}
        <div className="w-[380px] border-l border-slate-200 bg-slate-50 flex flex-col shrink-0">
          
          <Collapsible open={strayTxOpen} onOpenChange={setStrayTxOpen} className="flex flex-col border-b border-slate-200">
            <CollapsibleTrigger className="p-4 flex items-center justify-between hover:bg-slate-100 transition-colors">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center">
                  <CreditCard className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-sm font-semibold text-slate-800">Stray Transactions</h3>
                <Badge variant="secondary" className="ml-1 text-[10px] h-5 bg-indigo-50 text-indigo-700 border-indigo-200">7</Badge>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${strayTxOpen ? '' : '-rotate-90'}`} />
            </CollapsibleTrigger>
            <CollapsibleContent className="p-4 pt-0">
              <div className="text-xs text-slate-500 mb-3 leading-relaxed">
                Stripe charges/payouts or check images with no who/why link yet. Drag to a WHO & WHY record to link.
              </div>
              <div className="space-y-2">
                {STRAY_TRANSACTIONS.map(tx => (
                  <div key={tx.id} className="bg-white p-3 rounded-md border border-slate-200 shadow-sm cursor-grab active:cursor-grabbing hover:border-indigo-300 transition-colors group">
                    <div className="flex items-start gap-2">
                      <GripVertical className="w-4 h-4 text-slate-300 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-sm text-slate-900">{formatCurrency(tx.amount)}</span>
                          <span className="text-[10px] font-mono text-slate-500">{tx.date}</span>
                        </div>
                        <div className="text-xs font-mono text-indigo-600 mb-0.5">{tx.ref}</div>
                        <div className="text-xs text-slate-500">{tx.desc}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={strayWhoOpen} onOpenChange={setStrayWhoOpen} className="flex flex-col flex-1">
            <CollapsibleTrigger className="p-4 flex items-center justify-between hover:bg-slate-100 transition-colors">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded bg-emerald-100 text-emerald-700 flex items-center justify-center">
                  <FileText className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-sm font-semibold text-slate-800">Stray WHO & WHY</h3>
                <Badge variant="secondary" className="ml-1 text-[10px] h-5 bg-emerald-50 text-emerald-700 border-emerald-200">5</Badge>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${strayWhoOpen ? '' : '-rotate-90'}`} />
            </CollapsibleTrigger>
            <CollapsibleContent className="p-4 pt-0 overflow-y-auto">
              <div className="text-xs text-slate-500 mb-3 leading-relaxed">
                Commitments/gifts with no transaction yet. Drag onto another WHO & WHY to merge/group, or onto a transaction to link.
              </div>
              <div className="space-y-2 relative">
                
                {/* Drag State Affordance Example */}
                <div className="absolute top-12 left-0 right-0 z-20 pointer-events-none">
                  <Popover open={true}>
                    <PopoverTrigger asChild>
                      <div className="bg-white/90 backdrop-blur p-3 rounded-md border-2 border-emerald-400 shadow-xl opacity-90 scale-105 rotate-2">
                        <div className="flex items-start gap-2">
                          <GripVertical className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                          <div>
                            <div className="font-medium text-sm text-slate-900">{formatCurrency(75000)} • Prairie Sky Fund</div>
                            <div className="text-xs text-slate-500">Pledge - expected this month</div>
                          </div>
                        </div>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-2 shadow-xl border-slate-200 z-30 pointer-events-auto" side="left" align="start" sideOffset={10}>
                      <div className="text-xs font-semibold text-slate-800 px-2 py-1 mb-1">Drop Actions</div>
                      <div className="flex flex-col gap-1">
                        <button className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100 rounded text-left">
                          <Layers className="w-3.5 h-3.5 text-blue-600" />
                          <span>Group as allocations of one commitment</span>
                        </button>
                        <button className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100 rounded text-left">
                          <Copy className="w-3.5 h-3.5 text-amber-600" />
                          <span>Mark as double entry (Merge/Archive)</span>
                        </button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {STRAY_WHOWHY.map((wh) => (
                  <div key={wh.id} className={`bg-white p-3 rounded-md border border-slate-200 shadow-sm transition-colors group ${wh.id === 'sw-2' ? 'border-emerald-400 bg-emerald-50/30 ring-2 ring-emerald-400/20' : ''}`}>
                    <div className="flex items-start gap-2">
                      <GripVertical className="w-4 h-4 text-slate-300 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-sm text-slate-900">{formatCurrency(wh.amount)}</span>
                          <span className="text-[10px] font-mono text-slate-500">{wh.date}</span>
                        </div>
                        <div className="text-xs font-semibold text-emerald-700 mb-0.5">{wh.name}</div>
                        <div className="text-xs text-slate-500">{wh.desc}</div>
                        {wh.id === 'sw-2' && (
                          <div className="mt-2 text-[10px] font-bold text-emerald-600 uppercase tracking-wider bg-emerald-100/50 inline-block px-1.5 py-0.5 rounded">
                            Drop Target
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Recently paired: single object, two components */}
          <div className="p-4 border-t border-slate-200 bg-white">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-blue-100 text-blue-700 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-800">Recently paired</h3>
            </div>
            <div className="text-xs text-slate-500 mb-3 leading-relaxed">
              Linked pairs stay one object until explicitly delinked — searches from the QB list find them as a single unit.
            </div>
            <div className="rounded-md border border-blue-200 bg-blue-50/40 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-sm text-slate-900">{formatCurrency(20000)} • Third Coast Foundation</span>
                <button className="text-[10px] font-medium text-slate-400 hover:text-slate-600 uppercase tracking-wider">Delink</button>
              </div>
              <div className="flex items-stretch gap-1.5">
                <div className="flex-1 rounded border border-emerald-200 bg-white px-2 py-1.5">
                  <div className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider">Who &amp; Why</div>
                  <div className="text-[11px] text-slate-700">Capacity grant · 2 allocations</div>
                </div>
                <div className="flex items-center text-blue-400">
                  <LinkIcon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 rounded border border-slate-200 bg-white px-2 py-1.5">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Transaction</div>
                  <div className="text-[11px] text-slate-700 font-mono">Check #2051 · Oct 20</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
