import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Filter, CheckCircle2, AlertCircle, Circle, Banknote, CreditCard, Ban, Link as LinkIcon, Split, ArrowRight } from "lucide-react";

type SourceType = "QuickBooks Deposit" | "QuickBooks Payment" | "Stripe Payout";
type Status = "unreconciled" | "partial" | "linked" | "excluded";

interface QueueItem {
  id: string;
  source: SourceType;
  reference: string;
  date: string;
  amount: number;
  status: Status;
  crmLinked: "yes" | "no" | "partial" | "na";
  txProven: "yes" | "no" | "na";
  acctCoded: "yes" | "no" | "na";
  description: string;
  exclusionReason?: string;
}

const MOCK_DATA: QueueItem[] = [
  {
    id: "item-1",
    source: "QuickBooks Deposit",
    reference: "DEP-3410",
    date: "2026-10-18",
    amount: 150000.00,
    status: "unreconciled",
    crmLinked: "no",
    txProven: "yes", // For wires, QB deposit is the tx proof
    acctCoded: "no",
    description: "Wire Transfer - Unknown Origin"
  },
  {
    id: "item-2",
    source: "QuickBooks Deposit",
    reference: "DEP-3392",
    date: "2026-10-15",
    amount: 12500.00,
    status: "partial",
    crmLinked: "partial",
    txProven: "yes",
    acctCoded: "no",
    description: "Bulk check deposit (2 of 3 tied)"
  },
  {
    id: "item-3",
    source: "Stripe Payout",
    reference: "po_1Qxyz...",
    date: "2026-10-14",
    amount: 824.10,
    status: "partial",
    crmLinked: "yes",
    txProven: "yes",
    acctCoded: "no",
    description: "Stripe standard payout"
  },
  {
    id: "item-4",
    source: "QuickBooks Payment",
    reference: "CHK-8812",
    date: "2026-10-12",
    amount: 5000.00,
    status: "linked",
    crmLinked: "yes",
    txProven: "yes",
    acctCoded: "yes",
    description: "Check from Meadow Fund"
  },
  {
    id: "item-5",
    source: "QuickBooks Deposit",
    reference: "DEP-3388",
    date: "2026-10-10",
    amount: 45.00,
    status: "excluded",
    crmLinked: "na",
    txProven: "na",
    acctCoded: "yes",
    description: "Bank fee reversal",
    exclusionReason: "Non-donation: Operating revenue"
  }
];

const formatCurrency = (n: number) => 
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export function UnbrokenQueue() {
  const [search, setSearch] = useState("");

  const StatusIcon = ({ status }: { status: Status }) => {
    switch (status) {
      case "linked": return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
      case "partial": return <Split className="w-4 h-4 text-blue-600" />;
      case "unreconciled": return <AlertCircle className="w-4 h-4 text-amber-600" />;
      case "excluded": return <Ban className="w-4 h-4 text-slate-400" />;
    }
  };

  const StatusBadge = ({ status }: { status: Status }) => {
    const base = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium uppercase tracking-wider";
    switch (status) {
      case "linked": return <span className={`${base} bg-emerald-50 text-emerald-700 border border-emerald-200`}>Linked</span>;
      case "partial": return <span className={`${base} bg-blue-50 text-blue-700 border border-blue-200`}>Partial</span>;
      case "unreconciled": return <span className={`${base} bg-amber-50 text-amber-700 border border-amber-200`}>Unreconciled</span>;
      case "excluded": return <span className={`${base} bg-slate-100 text-slate-600 border border-slate-200`}>Excluded</span>;
    }
  };

  const EnrichmentState = ({ state, label }: { state: "yes" | "no" | "partial" | "na", label: string }) => {
    if (state === "na") {
      return (
        <div className="flex flex-col gap-1 items-center opacity-40">
          <Circle className="w-4 h-4 text-slate-300" />
          <span className="text-[10px] text-slate-400 font-medium tracking-wide uppercase">N/A</span>
        </div>
      );
    }
    
    let Icon = Circle;
    let iconClass = "text-slate-300";
    
    if (state === "yes") {
      Icon = CheckCircle2;
      iconClass = "text-emerald-500 fill-emerald-50";
    } else if (state === "partial") {
      Icon = Split;
      iconClass = "text-blue-500";
    } else {
      Icon = AlertCircle;
      iconClass = "text-amber-500";
    }

    return (
      <div className="flex flex-col gap-1 items-center">
        <Icon className={`w-4 h-4 ${iconClass}`} />
        <span className="text-[10px] text-slate-500 font-medium tracking-wide uppercase">{label}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-900 rounded flex items-center justify-center shadow-sm">
            <LinkIcon className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight text-slate-900">Unbroken Queue</h1>
            <p className="text-sm text-slate-500 font-medium">Reconciliation Workbench</p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          
          {/* Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative w-72">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search deposits, checks, payouts..." 
                  className="pl-9 bg-white shadow-sm border-slate-200 h-9 text-sm"
                />
              </div>
              <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 border-slate-200 bg-white">
                <Filter className="w-4 h-4" />
                Filters
              </Button>
            </div>
            <div className="flex gap-2">
              <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-100 rounded-md px-3 py-1 text-xs font-semibold uppercase tracking-wider">
                12 Action Required
              </Badge>
              <Badge variant="secondary" className="bg-slate-200 text-slate-700 hover:bg-slate-200 rounded-md px-3 py-1 text-xs font-semibold uppercase tracking-wider">
                45 Total Items
              </Badge>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <Table>
              <TableHeader className="bg-slate-50/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[300px]">Money Unit</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead className="text-center">CRM Linked</TableHead>
                  <TableHead className="text-center">Tx Proven</TableHead>
                  <TableHead className="text-center">Acct Coded</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {MOCK_DATA.map((item) => (
                  <TableRow key={item.id} className={`group cursor-pointer ${item.status === 'excluded' ? 'opacity-60 bg-slate-50/50' : 'hover:bg-slate-50'}`}>
                    <TableCell>
                      <div className="flex flex-col gap-1.5 py-1">
                        <div className="flex items-center gap-2">
                          {item.source.includes("Stripe") ? (
                            <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
                          ) : (
                            <Banknote className="w-4 h-4 text-slate-400 shrink-0" />
                          )}
                          <span className="font-semibold text-sm text-slate-900">{item.source}</span>
                          <span className="text-slate-300">•</span>
                          <span className="text-sm font-mono text-slate-500">{item.reference}</span>
                        </div>
                        <div className="text-xs text-slate-500">{item.date} • {item.description}</div>
                        {item.exclusionReason && (
                          <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mt-1 bg-slate-100 inline-flex self-start px-2 py-0.5 rounded">
                            {item.exclusionReason}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-mono font-medium text-slate-900">{formatCurrency(item.amount)}</span>
                    </TableCell>
                    <TableCell>
                      <EnrichmentState state={item.crmLinked} label="CRM" />
                    </TableCell>
                    <TableCell>
                      <EnrichmentState state={item.txProven} label="TX" />
                    </TableCell>
                    <TableCell>
                      <EnrichmentState state={item.acctCoded} label="ACCT" />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-2 py-1">
                        <StatusBadge status={item.status} />
                        {item.status !== 'excluded' && item.status !== 'linked' && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                            Resolve <ArrowRight className="w-3 h-3 ml-1" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

        </div>
      </div>
    </div>
  );
}
