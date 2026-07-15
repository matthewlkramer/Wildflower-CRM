import React, { useState } from "react";
import { 
  Check, 
  ChevronRight, 
  Search, 
  AlertCircle, 
  ArrowRight, 
  MoreHorizontal,
  Building,
  User,
  CreditCard,
  Landmark,
  FileText,
  X
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";

// --- Mock Data ---
type LaneStatus = "Confirmed" | "Proposed" | "Unlinked" | "Exempt";

interface LedgerRow {
  id: string;
  date: string;
  source: "QuickBooks" | "Stripe" | "Donorbox";
  payer: string;
  payerType: "individual" | "org";
  netAmount: number;
  grossAmount: number | null;
  evidenceStatus: LaneStatus;
  crmStatus: LaneStatus;
  crmDonor: string | null;
  crmGiftId: string | null;
  balanced: boolean;
  actionRequired: string;
  actionLabel: string;
  staged?: boolean;
}

const mockData: LedgerRow[] = [
  {
    id: "1",
    date: "Jun 12, 2026",
    source: "Stripe",
    payer: "Maria Torres",
    payerType: "individual",
    netAmount: 9712.88,
    grossAmount: 10000.00,
    evidenceStatus: "Confirmed",
    crmStatus: "Proposed",
    crmDonor: "Maria Torres",
    crmGiftId: "G-10492",
    balanced: true,
    actionRequired: "confirm_match",
    actionLabel: "Confirm Match"
  },
  {
    id: "2",
    date: "Jun 14, 2026",
    source: "QuickBooks",
    payer: "Walton Family Foundation",
    payerType: "org",
    netAmount: 50000.00,
    grossAmount: 50000.00,
    evidenceStatus: "Confirmed",
    crmStatus: "Confirmed",
    crmDonor: "Walton Family Foundation",
    crmGiftId: "G-10488",
    balanced: true,
    actionRequired: "none",
    actionLabel: "Settled"
  },
  {
    id: "3",
    date: "Jun 15, 2026",
    source: "Donorbox",
    payer: "James Wilson",
    payerType: "individual",
    netAmount: 48.20,
    grossAmount: 50.00,
    evidenceStatus: "Confirmed",
    crmStatus: "Unlinked",
    crmDonor: null,
    crmGiftId: null,
    balanced: false,
    actionRequired: "create_gift",
    actionLabel: "Create Gift"
  },
  {
    id: "4",
    date: "Jun 18, 2026",
    source: "QuickBooks",
    payer: "Anonymous",
    payerType: "individual",
    netAmount: 500.00,
    grossAmount: null,
    evidenceStatus: "Confirmed",
    crmStatus: "Unlinked",
    crmDonor: null,
    crmGiftId: null,
    balanced: false,
    actionRequired: "search_gift",
    actionLabel: "Pick Gift"
  },
  {
    id: "5",
    date: "Jul 02, 2026",
    source: "Stripe",
    payer: "Sarah Jenkins",
    payerType: "individual",
    netAmount: 242.50,
    grossAmount: 250.00,
    evidenceStatus: "Proposed",
    crmStatus: "Proposed",
    crmDonor: "Sarah Jenkins",
    crmGiftId: "G-10501",
    balanced: true,
    actionRequired: "confirm_match",
    actionLabel: "Confirm Match"
  },
];

const formatCurrency = (amount: number | null) => {
  if (amount === null) return "--";
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
};

const getStatusColor = (status: LaneStatus) => {
  switch (status) {
    case "Confirmed": return "bg-green-100 text-green-800 border-green-200";
    case "Proposed": return "bg-blue-100 text-blue-800 border-blue-200";
    case "Unlinked": return "bg-amber-100 text-amber-800 border-amber-200";
    case "Exempt": return "bg-slate-100 text-slate-800 border-slate-200";
  }
};

const SourceIcon = ({ source }: { source: string }) => {
  switch (source) {
    case "QuickBooks": return <Landmark className="w-4 h-4 text-green-600" />;
    case "Stripe": return <CreditCard className="w-4 h-4 text-indigo-500" />;
    case "Donorbox": return <FileText className="w-4 h-4 text-orange-500" />;
    default: return null;
  }
};

export function LedgerInspector() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stagedIds, setStagedIds] = useState<Set<string>>(new Set(["5"]));

  const selectedRow = mockData.find(r => r.id === selectedId);

  const handleStageAction = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setStagedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans overflow-hidden">
      {/* Top Header */}
      <header className="px-6 py-4 bg-white border-b flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Reconciliation Workbench</h1>
          <p className="text-sm text-slate-500 mt-1">Reviewing June–July 2026 settlements</p>
        </div>
        <div className="flex items-center space-x-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9 w-64" placeholder="Search payer, amount, or gift..." />
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Ledger Panel */}
        <div className={`flex flex-col h-full transition-all duration-300 ease-in-out ${selectedRow ? 'w-2/3 border-r' : 'w-full'}`}>
          <div className="px-4 pt-3 pb-2 shrink-0">
            <Tabs defaultValue="gift-payment">
              <TabsList>
                <TabsTrigger value="qb-stripe">QB ↔ Stripe</TabsTrigger>
                <TabsTrigger value="gift-payment">Gift ↔ Payment</TabsTrigger>
                <TabsTrigger value="excluded">Excluded</TabsTrigger>
                <TabsTrigger value="incomplete">Incomplete</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="flex-1 overflow-auto">
            <Table>
              <TableHeader className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                <TableRow>
                  <TableHead className="w-10"></TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead className="text-right">Net Dep.</TableHead>
                  <TableHead className="text-right">Gross Gift</TableHead>
                  <TableHead>CRM Record</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Next Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mockData.map((row) => {
                  const isStaged = stagedIds.has(row.id);
                  const isSelected = selectedId === row.id;
                  
                  return (
                    <TableRow 
                      key={row.id}
                      onClick={() => setSelectedId(isSelected ? null : row.id)}
                      className={`cursor-pointer group ${isSelected ? 'bg-blue-50/50' : ''} ${isStaged ? 'bg-slate-50 opacity-60' : 'bg-white'}`}
                    >
                      <TableCell>
                        <div className={`w-1.5 h-1.5 rounded-full ${row.balanced ? 'bg-green-500' : 'bg-amber-400'}`} title={row.balanced ? "Balanced" : "Unbalanced"} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{row.date}</TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <SourceIcon source={row.source} />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{row.payer}</span>
                            <span className="text-xs text-slate-500">{row.source}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(row.netAmount)}</TableCell>
                      <TableCell className="text-right text-slate-600">{formatCurrency(row.grossAmount)}</TableCell>
                      <TableCell>
                        {row.crmDonor ? (
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{row.crmDonor}</span>
                            <span className="text-xs text-slate-500">{row.crmGiftId}</span>
                          </div>
                        ) : (
                          <span className="text-sm text-slate-400 italic">Unlinked</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant="outline" className={`text-[10px] uppercase px-1.5 py-0 h-4 w-fit ${getStatusColor(row.evidenceStatus)}`}>
                            Ev: {row.evidenceStatus}
                          </Badge>
                          <Badge variant="outline" className={`text-[10px] uppercase px-1.5 py-0 h-4 w-fit ${getStatusColor(row.crmStatus)}`}>
                            CRM: {row.crmStatus}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {row.actionRequired !== "none" ? (
                          <Button 
                            size="sm" 
                            variant={isStaged ? "outline" : "default"}
                            className={isStaged ? "border-dashed" : ""}
                            onClick={(e) => handleStageAction(row.id, e)}
                          >
                            {isStaged ? "Staged" : row.actionLabel}
                          </Button>
                        ) : (
                          <span className="text-sm text-slate-400 flex items-center justify-end"><Check className="w-4 h-4 mr-1"/> Settled</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Inspector Panel */}
        {selectedRow && (
          <div className="w-1/3 bg-white h-full flex flex-col shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)] z-20">
            <div className="px-6 py-4 border-b flex justify-between items-start bg-slate-50/50 shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Settlement Details</h2>
                <p className="text-sm text-slate-500">{selectedRow.date} • {selectedRow.source}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedId(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            
            <div className="flex-1 p-6 overflow-auto">
              {/* Lineage */}
              <div className="mb-8">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3">Lineage</h3>
                <div className="flex items-center text-sm bg-slate-50 p-3 rounded-md border border-slate-100">
                  <span className="font-medium text-slate-700">Donorbox</span>
                  <ArrowRight className="w-3 h-3 mx-2 text-slate-400" />
                  <span className="font-medium text-slate-700">Stripe Charge</span>
                  <ArrowRight className="w-3 h-3 mx-2 text-slate-400" />
                  <span className="font-medium text-slate-900">QBO Deposit</span>
                </div>
              </div>

              {/* Two-Sided Detail */}
              <div className="grid grid-cols-2 gap-6 mb-8 relative">
                {/* Visual Connector */}
                <div className="absolute left-1/2 top-4 bottom-4 w-px bg-slate-200 -translate-x-1/2"></div>
                <div className="absolute left-1/2 top-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center -translate-x-1/2 -translate-y-1/2 z-10 shadow-sm">
                  {selectedRow.balanced ? (
                    <Check className="w-3 h-3 text-green-500" />
                  ) : (
                    <AlertCircle className="w-3 h-3 text-amber-500" />
                  )}
                </div>

                {/* Evidence Lane */}
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center">
                    <div className={`w-2 h-2 rounded-full mr-2 ${getStatusColor(selectedRow.evidenceStatus).split(' ')[0]}`} />
                    Evidence
                  </h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-slate-500">Payer</label>
                      <p className="font-medium text-slate-900 flex items-center">
                        {selectedRow.payerType === 'org' ? <Building className="w-3.5 h-3.5 mr-1.5 text-slate-400" /> : <User className="w-3.5 h-3.5 mr-1.5 text-slate-400" />}
                        {selectedRow.payer}
                      </p>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500">Net Amount</label>
                      <p className="text-lg font-medium text-slate-900">{formatCurrency(selectedRow.netAmount)}</p>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500">Source ID</label>
                      <p className="text-sm text-slate-600 font-mono">txn_3490218...</p>
                    </div>
                  </div>
                </div>

                {/* CRM Lane */}
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center">
                    <div className={`w-2 h-2 rounded-full mr-2 ${getStatusColor(selectedRow.crmStatus).split(' ')[0]}`} />
                    CRM Record
                  </h3>
                  {selectedRow.crmDonor ? (
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs text-slate-500">Donor</label>
                        <p className="font-medium text-slate-900">{selectedRow.crmDonor}</p>
                      </div>
                      <div>
                        <label className="text-xs text-slate-500">Gross Amount</label>
                        <p className="text-lg font-medium text-slate-900">{formatCurrency(selectedRow.grossAmount)}</p>
                        {selectedRow.balanced && (
                          <p className="text-xs text-green-600 mt-1">Delta matches processor fee</p>
                        )}
                      </div>
                      <div>
                        <label className="text-xs text-slate-500">Gift Record</label>
                        <p className="text-sm text-blue-600 font-mono hover:underline cursor-pointer">{selectedRow.crmGiftId}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full py-8 text-center text-slate-500 border border-dashed rounded bg-slate-50">
                      <Search className="w-6 h-6 mb-2 text-slate-400" />
                      <p className="text-sm">No linked gift</p>
                      <Button variant="link" size="sm" className="mt-1 h-auto py-1">Search CRM</Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Actions Section */}
              <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
                <h3 className="text-sm font-semibold text-slate-900 mb-3">Actions</h3>
                <div className="flex flex-col space-y-2">
                  <Button className="w-full justify-start">
                    <Check className="w-4 h-4 mr-2" />
                    {selectedRow.actionLabel}
                  </Button>
                  
                  <div className="grid grid-cols-2 gap-2 pt-2">
                    <Button variant="outline" size="sm" className="justify-start">Record on Pledge</Button>
                    <Button variant="outline" size="sm" className="justify-start">Exclude Payment</Button>
                    <Button variant="outline" size="sm" className="justify-start">Re-target</Button>
                    <Button variant="outline" size="sm" className="justify-start">Split Across Gifts</Button>
                  </div>
                  
                  <Separator className="my-2" />
                  
                  <Button variant="ghost" size="sm" className="text-slate-500 justify-start">
                    <AlertCircle className="w-4 h-4 mr-2" />
                    Flag for Research
                  </Button>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* Persistent Footer Tray */}
      <div className={`shrink-0 bg-slate-900 text-white px-6 py-4 flex items-center justify-between transition-transform duration-300 ${stagedIds.size > 0 ? 'translate-y-0' : 'translate-y-full absolute bottom-0 left-0 right-0'}`}>
        <div className="flex items-center">
          <div className="bg-blue-500 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold mr-3">
            {stagedIds.size}
          </div>
          <span className="font-medium">Changes Staged</span>
          <span className="text-slate-400 text-sm ml-4">({stagedIds.size} {stagedIds.size === 1 ? 'item' : 'items'} ready to process)</span>
        </div>
        <div className="flex space-x-3">
          <Button variant="ghost" className="text-slate-300 hover:text-white hover:bg-slate-800" onClick={() => setStagedIds(new Set())}>
            Clear All
          </Button>
          <Button className="bg-blue-500 hover:bg-blue-600 text-white border-0 shadow-md">
            Apply to CRM
          </Button>
        </div>
      </div>
    </div>
  );
}
