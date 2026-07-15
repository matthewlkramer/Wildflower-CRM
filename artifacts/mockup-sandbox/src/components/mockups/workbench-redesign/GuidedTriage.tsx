import React, { useState } from "react";
import { 
  Check, 
  ChevronRight, 
  Search, 
  AlertCircle, 
  Link as LinkIcon, 
  Plus, 
  Ban,
  ArrowRight,
  Split,
  CornerDownRight,
  MoreHorizontal,
  FileText,
  Building,
  User,
  Clock,
  History,
  Info
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";

// --- Mock Data ---
type Status = "unlinked" | "proposed" | "confirmed" | "excluded" | "conflict";

interface LineageNode {
  type: string;
  id: string;
  amount: number;
}

interface Evidence {
  source: string;
  amountNet: number;
  date: string;
  payer: string;
  reference: string;
  lineage: LineageNode[];
}

interface CRMGift {
  donor: string;
  amountGross: number;
  date: string;
  allocations: string[];
  restrictions: string[];
  status: string;
}

interface WorkItem {
  id: string;
  status: Status;
  evidence: Evidence;
  crmGift?: CRMGift | null;
  feeAmount?: number;
}

const MOCK_ITEMS: WorkItem[] = [
  {
    id: "itm_1",
    status: "proposed",
    feeAmount: 287.12,
    evidence: {
      source: "Stripe Payout",
      amountNet: 9712.88,
      date: "2026-06-12",
      payer: "Walton Family Foundation",
      reference: "po_1NXXXXXX",
      lineage: [
        { type: "QBO Deposit", id: "DEP-4492", amount: 9712.88 },
        { type: "Stripe Payout", id: "po_1NXXXXXX", amount: 9712.88 },
        { type: "Stripe Charge", id: "ch_1NXXXXXX", amount: 10000.00 }
      ]
    },
    crmGift: {
      donor: "Walton Family Foundation",
      amountGross: 10000.00,
      date: "2026-06-10",
      allocations: ["General Operating"],
      restrictions: [],
      status: "Pledged"
    }
  },
  {
    id: "itm_2",
    status: "unlinked",
    evidence: {
      source: "QBO Deposit",
      amountNet: 1250.00,
      date: "2026-06-14",
      payer: "Unknown Sender",
      reference: "Check 1042",
      lineage: [
        { type: "QBO Deposit", id: "DEP-4495", amount: 1250.00 }
      ]
    },
    crmGift: null
  },
  {
    id: "itm_3",
    status: "conflict",
    feeAmount: 15.00,
    evidence: {
      source: "Donorbox",
      amountNet: 485.00,
      date: "2026-06-15",
      payer: "Maria Torres",
      reference: "DB-99412",
      lineage: [
        { type: "QBO Deposit", id: "DEP-4498", amount: 485.00 },
        { type: "Stripe Payout", id: "po_1NYYYYYY", amount: 485.00 },
        { type: "Donorbox", id: "DB-99412", amount: 500.00 }
      ]
    },
    crmGift: {
      donor: "Maria Torres",
      amountGross: 500.00,
      date: "2026-05-01",
      allocations: ["Scholarship Fund"],
      restrictions: ["Spring 2027 only"],
      status: "Paid" // Already paid! Conflict.
    }
  },
  {
    id: "itm_4",
    status: "confirmed",
    evidence: {
      source: "QBO Deposit",
      amountNet: 50000.00,
      date: "2026-06-16",
      payer: "City Education Grant",
      reference: "ACH-CITY-001",
      lineage: [
        { type: "QBO Deposit", id: "DEP-4501", amount: 50000.00 }
      ]
    },
    crmGift: {
      donor: "City Dept of Education",
      amountGross: 50000.00,
      date: "2026-06-15",
      allocations: ["Program Expansion"],
      restrictions: ["Reporting required"],
      status: "Pledged"
    }
  },
  {
    id: "itm_5",
    status: "proposed",
    feeAmount: 8.50,
    evidence: {
      source: "Stripe Payout",
      amountNet: 241.50,
      date: "2026-06-18",
      payer: "James Wilson",
      reference: "po_1NZZZZZZ",
      lineage: [
        { type: "QBO Deposit", id: "DEP-4505", amount: 241.50 },
        { type: "Stripe Payout", id: "po_1NZZZZZZ", amount: 241.50 },
        { type: "Stripe Charge", id: "ch_1NZZZZZZ", amount: 250.00 }
      ]
    },
    crmGift: {
      donor: "James Wilson",
      amountGross: 250.00,
      date: "2026-06-18",
      allocations: ["General Operating"],
      restrictions: [],
      status: "Unpaid"
    }
  }
];

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
};

const formatDate = (dateStr: string) => {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(dateStr));
};

export function GuidedTriage() {
  const [items, setItems] = useState<WorkItem[]>(MOCK_ITEMS);
  const [selectedId, setSelectedId] = useState<string>(MOCK_ITEMS[0].id);
  const [stagedCount, setStagedCount] = useState(0);

  const selectedItem = items.find(i => i.id === selectedId);

  const handleStageAction = (action: string) => {
    // In a real app, this would update the item's local state and add to the pending tray
    setItems(items.map(i => i.id === selectedId ? { ...i, status: "confirmed" } : i));
    setStagedCount(prev => prev + 1);
    
    // Auto-advance
    const currentIndex = items.findIndex(i => i.id === selectedId);
    if (currentIndex < items.length - 1) {
      setSelectedId(items[currentIndex + 1].id);
    }
  };

  const getStatusColor = (status: Status) => {
    switch (status) {
      case "proposed": return "bg-blue-500";
      case "confirmed": return "bg-green-500";
      case "conflict": return "bg-amber-500";
      case "unlinked": return "bg-gray-400";
      case "excluded": return "bg-slate-800";
      default: return "bg-gray-200";
    }
  };

  const getStatusBadge = (status: Status) => {
    switch (status) {
      case "proposed": return <Badge variant="secondary" className="bg-blue-100 text-blue-800 hover:bg-blue-100">Proposed Match</Badge>;
      case "confirmed": return <Badge variant="secondary" className="bg-green-100 text-green-800 hover:bg-green-100">Confirmed</Badge>;
      case "conflict": return <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-100">Conflict</Badge>;
      case "unlinked": return <Badge variant="outline" className="text-gray-600">Unlinked</Badge>;
      case "excluded": return <Badge variant="secondary" className="bg-slate-100 text-slate-800 hover:bg-slate-100">Excluded</Badge>;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center text-white font-bold">W</div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Reconciliation Triage</h1>
            <p className="text-sm text-slate-500">June 2026 • 24 items remaining</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Tabs defaultValue="inbox" className="w-[400px]">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="inbox">Inbox (24)</TabsTrigger>
              <TabsTrigger value="excluded">Excluded (5)</TabsTrigger>
              <TabsTrigger value="incomplete">Incomplete (2)</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end">
            <span className="text-sm font-medium text-slate-700">{stagedCount} items staged</span>
            <span className="text-xs text-slate-500">Ready to apply</span>
          </div>
          <Button disabled={stagedCount === 0} className="bg-indigo-600 hover:bg-indigo-700">
            Apply to CRM
          </Button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex flex-1 overflow-hidden">
        
        {/* Left List: Compact Inbox */}
        <aside className="w-[340px] flex flex-col bg-white border-r border-slate-200 shrink-0 z-10 shadow-[2px_0_8px_-4px_rgba(0,0,0,0.1)]">
          <div className="p-4 border-b border-slate-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search amount, donor, reference..." 
                className="w-full pl-9 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              />
            </div>
          </div>
          
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left p-3 rounded-lg flex items-start gap-3 transition-colors ${
                    selectedId === item.id 
                      ? "bg-indigo-50 border border-indigo-100 shadow-sm" 
                      : "hover:bg-slate-50 border border-transparent"
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${getStatusColor(item.status)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="font-medium text-sm truncate pr-2">
                        {formatCurrency(item.evidence.amountNet)}
                      </span>
                      <span className="text-xs text-slate-500 whitespace-nowrap">
                        {formatDate(item.evidence.date)}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600 truncate mb-1">
                      {item.evidence.payer}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                        {item.evidence.source}
                      </span>
                      {item.status === 'proposed' && (
                        <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                          1 Match
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </aside>

        {/* Right Panel: Focus Area */}
        <section className="flex-1 flex flex-col bg-slate-50/50 overflow-hidden relative">
          {selectedItem ? (
            <div className="flex-1 flex flex-col max-w-5xl mx-auto w-full">
              
              {/* Context Bar */}
              <div className="px-8 py-6 pb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {getStatusBadge(selectedItem.status)}
                  <span className="text-sm text-slate-500 font-medium">Item {items.findIndex(i => i.id === selectedId) + 1} of {items.length}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <kbd className="px-2 py-1 bg-white border border-slate-200 rounded text-xs shadow-sm">J</kbd> Next
                  <kbd className="px-2 py-1 bg-white border border-slate-200 rounded text-xs shadow-sm ml-2">K</kbd> Prev
                </div>
              </div>

              <ScrollArea className="flex-1 px-8 pb-8">
                
                {/* Decision Row (Primary Actions) */}
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-2 mb-6 flex items-center justify-between sticky top-0 z-20">
                  <div className="flex items-center gap-2">
                    {selectedItem.status === 'proposed' && (
                      <Button onClick={() => handleStageAction('confirm')} className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm px-6 h-10">
                        <Check className="mr-2 h-4 w-4" />
                        Confirm Match
                      </Button>
                    )}
                    {selectedItem.status === 'unlinked' && (
                      <Button onClick={() => handleStageAction('create')} className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm px-6 h-10">
                        <Plus className="mr-2 h-4 w-4" />
                        Create New Gift
                      </Button>
                    )}
                    {selectedItem.status === 'conflict' && (
                      <Button onClick={() => handleStageAction('resolve')} className="bg-amber-600 hover:bg-amber-700 text-white shadow-sm px-6 h-10">
                        <Split className="mr-2 h-4 w-4" />
                        Resolve Conflict
                      </Button>
                    )}
                    
                    <Separator orientation="vertical" className="h-6 mx-2" />
                    
                    <Button variant="ghost" size="sm" className="h-10 text-slate-600 hover:text-slate-900">
                      <Search className="mr-2 h-4 w-4" />
                      Find Different Gift
                    </Button>
                    <Button variant="ghost" size="sm" className="h-10 text-slate-600 hover:text-slate-900">
                      <LinkIcon className="mr-2 h-4 w-4" />
                      Link to Pledge
                    </Button>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" className="h-10 text-slate-600 hover:text-red-600">
                      <Ban className="mr-2 h-4 w-4" />
                      Exclude...
                    </Button>
                    <Button variant="ghost" size="icon" className="h-10 w-10 text-slate-400">
                      <MoreHorizontal className="h-5 w-5" />
                    </Button>
                  </div>
                </div>

                {/* Evidence vs CRM Side-by-Side */}
                <div className="grid grid-cols-2 gap-6 relative">
                  
                  {/* Link Line UI in middle */}
                  <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex flex-col items-center justify-center">
                    {selectedItem.status === 'unlinked' ? (
                      <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-300">
                        <LinkIcon className="w-4 h-4" />
                      </div>
                    ) : selectedItem.status === 'conflict' ? (
                      <div className="w-8 h-8 rounded-full bg-amber-100 border border-amber-200 flex items-center justify-center text-amber-600 shadow-sm">
                        <AlertCircle className="w-4 h-4" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-indigo-100 border border-indigo-200 flex items-center justify-center text-indigo-600 shadow-sm">
                        <Check className="w-4 h-4" />
                      </div>
                    )}
                  </div>

                  {/* LEFT: Funding Evidence */}
                  <Card className="shadow-sm border-slate-200 overflow-hidden flex flex-col">
                    <div className="bg-slate-50 border-b border-slate-100 px-5 py-3 flex justify-between items-center">
                      <h3 className="font-semibold text-slate-700 flex items-center gap-2 text-sm">
                        <Building className="h-4 w-4 text-slate-400" />
                        Funding Evidence
                      </h3>
                      <Badge variant="outline" className="bg-white">{selectedItem.evidence.source}</Badge>
                    </div>
                    
                    <div className="p-6 flex-1">
                      <div className="mb-6">
                        <div className="text-sm text-slate-500 mb-1">Net Amount Received</div>
                        <div className="text-4xl font-light text-slate-900 tracking-tight">
                          {formatCurrency(selectedItem.evidence.amountNet)}
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                          <div className="col-span-1 text-sm text-slate-500">Payer Name</div>
                          <div className="col-span-2 text-sm font-medium text-slate-900">{selectedItem.evidence.payer}</div>
                        </div>
                        <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                          <div className="col-span-1 text-sm text-slate-500">Date</div>
                          <div className="col-span-2 text-sm font-medium text-slate-900 flex items-center gap-2">
                            <Clock className="h-3.5 w-3.5 text-slate-400" />
                            {formatDate(selectedItem.evidence.date)}
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                          <div className="col-span-1 text-sm text-slate-500">Reference</div>
                          <div className="col-span-2 text-sm font-medium text-slate-900 font-mono text-xs bg-slate-100 px-2 py-1 rounded inline-block w-fit">
                            {selectedItem.evidence.reference}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Settlement Lineage Strip */}
                    <div className="bg-slate-50/80 p-5 border-t border-slate-100">
                      <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                        <History className="h-3.5 w-3.5" />
                        Settlement Lineage
                      </h4>
                      <div className="flex items-center text-sm">
                        {selectedItem.evidence.lineage.map((node, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && <ChevronRight className="h-4 w-4 text-slate-300 mx-2 shrink-0" />}
                            <div className="flex flex-col">
                              <span className="text-xs text-slate-500">{node.type}</span>
                              <span className="font-mono text-xs text-slate-700">{formatCurrency(node.amount)}</span>
                            </div>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  </Card>

                  {/* RIGHT: CRM Record */}
                  <Card className={`shadow-sm overflow-hidden flex flex-col border-2 transition-colors ${
                    selectedItem.status === 'unlinked' ? 'border-dashed border-slate-200 bg-slate-50/50' :
                    selectedItem.status === 'conflict' ? 'border-amber-200' :
                    selectedItem.status === 'proposed' ? 'border-indigo-200' :
                    'border-slate-200'
                  }`}>
                    {selectedItem.crmGift ? (
                      <>
                        <div className={`px-5 py-3 flex justify-between items-center border-b ${
                          selectedItem.status === 'conflict' ? 'bg-amber-50 border-amber-100' :
                          selectedItem.status === 'proposed' ? 'bg-indigo-50 border-indigo-100' :
                          'bg-white border-slate-100'
                        }`}>
                          <h3 className="font-semibold text-slate-700 flex items-center gap-2 text-sm">
                            <FileText className="h-4 w-4 text-slate-400" />
                            CRM Gift Record
                          </h3>
                          <Badge variant="outline" className={
                            selectedItem.crmGift.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' :
                            selectedItem.crmGift.status === 'Pledged' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                            'bg-slate-100 text-slate-700 border-slate-200'
                          }>
                            {selectedItem.crmGift.status}
                          </Badge>
                        </div>

                        <div className="p-6 flex-1 bg-white">
                          <div className="mb-6 flex items-start justify-between">
                            <div>
                              <div className="text-sm text-slate-500 mb-1">Gross Gift Amount</div>
                              <div className="text-4xl font-light text-slate-900 tracking-tight">
                                {formatCurrency(selectedItem.crmGift.amountGross)}
                              </div>
                            </div>
                            
                            {/* Fee Band Meter (Only if amounts differ) */}
                            {selectedItem.feeAmount && (
                              <div className="text-right">
                                <div className="text-xs text-slate-500 flex items-center justify-end gap-1 mb-1">
                                  Processor Fee <Info className="h-3 w-3" />
                                </div>
                                <div className="text-sm font-medium text-slate-700">
                                  -{formatCurrency(selectedItem.feeAmount)}
                                </div>
                                <div className="mt-2 w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden flex">
                                  <div className="bg-emerald-400 h-full" style={{ width: '97%' }}></div>
                                  <div className="bg-rose-400 h-full" style={{ width: '3%' }}></div>
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">Balanced</div>
                              </div>
                            )}
                          </div>

                          <div className="space-y-4">
                            <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                              <div className="col-span-1 text-sm text-slate-500">Donor</div>
                              <div className="col-span-2 text-sm font-medium text-indigo-600 hover:underline cursor-pointer flex items-center gap-1.5">
                                <User className="h-3.5 w-3.5" />
                                {selectedItem.crmGift.donor}
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                              <div className="col-span-1 text-sm text-slate-500">Date</div>
                              <div className="col-span-2 text-sm font-medium text-slate-900 flex items-center gap-2">
                                <Clock className="h-3.5 w-3.5 text-slate-400" />
                                {formatDate(selectedItem.crmGift.date)}
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                              <div className="col-span-1 text-sm text-slate-500">Allocation</div>
                              <div className="col-span-2 text-sm font-medium text-slate-900">
                                {selectedItem.crmGift.allocations.map(a => (
                                  <Badge key={a} variant="secondary" className="mr-1 bg-slate-100 font-normal">{a}</Badge>
                                ))}
                              </div>
                            </div>
                            {selectedItem.crmGift.restrictions.length > 0 && (
                              <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
                                <div className="col-span-1 text-sm text-slate-500">Restrictions</div>
                                <div className="col-span-2 text-sm font-medium text-amber-700 flex items-center gap-1.5">
                                  <AlertCircle className="h-3.5 w-3.5" />
                                  {selectedItem.crmGift.restrictions.join(", ")}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {/* Conflict Warning if applicable */}
                        {selectedItem.status === 'conflict' && (
                          <div className="bg-amber-50 p-4 border-t border-amber-100 flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                            <div>
                              <h4 className="text-sm font-medium text-amber-900">Gift is already marked Paid</h4>
                              <p className="text-xs text-amber-700 mt-1">
                                Applying this payment will create a double-payment. You may need to reverse a previous payment or link to a different pledge.
                              </p>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                          <Search className="h-8 w-8 text-slate-300" />
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-2">No CRM Record Linked</h3>
                        <p className="text-sm text-slate-500 max-w-sm mb-6">
                          We couldn't automatically match this payment to an existing gift or pledge in the CRM.
                        </p>
                        <div className="flex gap-3 w-full max-w-sm">
                          <Button className="flex-1 bg-white text-indigo-600 border border-indigo-200 hover:bg-indigo-50">
                            <Search className="mr-2 h-4 w-4" />
                            Search CRM
                          </Button>
                          <Button className="flex-1 bg-indigo-600 text-white hover:bg-indigo-700">
                            <Plus className="mr-2 h-4 w-4" />
                            Create Gift
                          </Button>
                        </div>
                      </div>
                    )}
                  </Card>
                </div>
              </ScrollArea>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              Select an item to triage
            </div>
          )}
        </section>
      </main>
      
      {/* Toast Notification Area placeholder */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-50">
         {/* Toast elements would go here */}
      </div>
    </div>
  );
}
