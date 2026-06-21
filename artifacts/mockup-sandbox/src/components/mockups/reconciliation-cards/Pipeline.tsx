import "./_group.css";
import React, { useState } from "react";
import {
  CheckCircle2,
  Circle,
  HelpCircle,
  ChevronRight,
  Search,
  Check,
  X,
  CreditCard,
  Landmark,
  FileText,
  DollarSign,
  AlertCircle,
  Link2,
  Building,
  User,
  HeartHandshake,
  ArrowRight,
  Settings2,
  GripHorizontal
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ----------------------------------------------------------------------
// TYPES & DATA
// ----------------------------------------------------------------------

type Status = "done" | "awaiting" | "empty" | "anchor";

interface NodeData {
  id: string;
  type: "source" | "qb" | "gift" | "pledge";
  status: Status;
  title: string;
  subtitle?: string;
  icon?: React.ElementType;
}

interface CardData {
  id: string;
  qbAmount: string;
  qbDate: string;
  qbPayer: string;
  qbMethod: string;
  qbIcon: React.ElementType;
  nodes: NodeData[];
  expanded?: boolean;
}

const CARDS: CardData[] = [
  {
    id: "1",
    qbAmount: "$5,000.00",
    qbDate: "Oct 12, 2023",
    qbPayer: "Patagonia Inc.",
    qbMethod: "Visa",
    qbIcon: CreditCard,
    nodes: [
      { id: "s1", type: "source", status: "done", title: "Stripe charge", subtitle: "$5,000.00 (Net $4,850.00)" },
      { id: "q1", type: "qb", status: "anchor", title: "QuickBooks", subtitle: "Patagonia Inc." },
      { id: "g1", type: "gift", status: "done", title: "Confirmed gift", subtitle: "Patagonia Inc." },
      { id: "p1", type: "pledge", status: "done", title: "FY24 Grant", subtitle: "Fulfilled" }
    ]
  },
  {
    id: "2",
    qbAmount: "$250.00",
    qbDate: "Oct 14, 2023",
    qbPayer: "J. Rivera",
    qbMethod: "Visa",
    qbIcon: CreditCard,
    nodes: [
      { id: "s2", type: "source", status: "awaiting", title: "Proposed Stripe", subtitle: "$250.00 (Net $242.00)" },
      { id: "q2", type: "qb", status: "anchor", title: "QuickBooks", subtitle: "J. Rivera" },
      { id: "g2", type: "gift", status: "awaiting", title: "Proposed gift", subtitle: "J. Rivera" },
      { id: "p2", type: "pledge", status: "empty", title: "No pledge", subtitle: "Optional" }
    ]
  },
  {
    id: "3",
    qbAmount: "$1,200.00",
    qbDate: "Oct 15, 2023",
    qbPayer: "Unknown",
    qbMethod: "Visa",
    qbIcon: CreditCard,
    nodes: [
      { id: "s3", type: "source", status: "empty", title: "No Stripe match", subtitle: "Search records" },
      { id: "q3", type: "qb", status: "anchor", title: "QuickBooks", subtitle: "Unknown Payer" },
      { id: "g3", type: "gift", status: "awaiting", title: "Proposed gift", subtitle: "Anonymous Donor" },
      { id: "p3", type: "pledge", status: "empty", title: "No pledge", subtitle: "Optional" }
    ]
  },
  {
    id: "4",
    qbAmount: "$80,000.00",
    qbDate: "Oct 16, 2023",
    qbPayer: "Fidelity Brokerage",
    qbMethod: "Stock/Wire",
    qbIcon: Landmark,
    expanded: true,
    nodes: [
      { id: "s4", type: "source", status: "done", title: "Brokerage transfer", subtitle: "No Stripe needed" },
      { id: "q4", type: "qb", status: "anchor", title: "QuickBooks", subtitle: "Fidelity Brokerage" },
      { id: "g4", type: "gift", status: "awaiting", title: "Proposed gift", subtitle: "Smith Family Trust" },
      { id: "p4", type: "pledge", status: "done", title: "FY24 Major Gift", subtitle: "Committed" }
    ]
  },
  {
    id: "5",
    qbAmount: "$25,000.00",
    qbDate: "Oct 18, 2023",
    qbPayer: "Helen Mott Trust",
    qbMethod: "Check",
    qbIcon: FileText,
    nodes: [
      { id: "s5", type: "source", status: "done", title: "Mailed check", subtitle: "No Stripe needed" },
      { id: "q5", type: "qb", status: "anchor", title: "QuickBooks", subtitle: "Helen Mott Trust" },
      { id: "g5", type: "gift", status: "done", title: "Confirmed gift", subtitle: "Helen Mott Trust" },
      { id: "p5", type: "pledge", status: "empty", title: "No pledge", subtitle: "Optional" }
    ]
  },
  {
    id: "6",
    qbAmount: "$500.00",
    qbDate: "Oct 19, 2023",
    qbPayer: "Cash Deposit",
    qbMethod: "Cash/ACH",
    qbIcon: DollarSign,
    nodes: [
      { id: "s6", type: "source", status: "done", title: "Bank deposit", subtitle: "No Stripe needed" },
      { id: "q6", type: "qb", status: "anchor", title: "QuickBooks", subtitle: "Cash Deposit" },
      { id: "g6", type: "gift", status: "empty", title: "No gift linked", subtitle: "Needs review" },
      { id: "p6", type: "pledge", status: "empty", title: "No pledge", subtitle: "Optional" }
    ]
  }
];

// ----------------------------------------------------------------------
// COMPONENTS
// ----------------------------------------------------------------------

function StatusIcon({ status }: { status: Status }) {
  if (status === "anchor") {
    return <div className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center border-2 border-primary"><Circle className="w-2.5 h-2.5 fill-current" /></div>;
  }
  if (status === "done") {
    return <CheckCircle2 className="w-5 h-5 text-emerald-600" />;
  }
  if (status === "awaiting") {
    return <AlertCircle className="w-5 h-5 text-amber-500" />;
  }
  return <Circle className="w-5 h-5 text-slate-300" />;
}

function PipelineNode({ 
  node, 
  isActive, 
  onClick 
}: { 
  node: NodeData; 
  isActive: boolean; 
  onClick: () => void;
}) {
  const isAnchor = node.status === "anchor";
  
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col flex-1 min-w-0 p-3 rounded-md transition-all text-left group outline-none",
        isAnchor ? "cursor-default" : "cursor-pointer hover:bg-slate-50",
        isActive && !isAnchor ? "bg-slate-50 ring-1 ring-slate-200 shadow-sm" : ""
      )}
      disabled={isAnchor}
    >
      <div className="flex items-center gap-2 mb-1">
        <StatusIcon status={node.status} />
        <span className={cn(
          "text-xs font-semibold truncate",
          node.status === "done" ? "text-emerald-700" :
          node.status === "awaiting" ? "text-amber-700" :
          node.status === "anchor" ? "text-primary" :
          "text-slate-500"
        )}>
          {node.title}
        </span>
      </div>
      <div className={cn(
        "text-sm truncate",
        node.status === "empty" ? "text-slate-400" : "text-slate-700"
      )}>
        {node.subtitle}
      </div>
    </button>
  );
}

function NodeEditorSource() {
  return (
    <div className="p-5 bg-slate-50 border-t border-slate-100 flex gap-6">
      <div className="flex-1">
        <h4 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-slate-500" />
          Stripe source
        </h4>
        <div className="bg-white border border-slate-200 rounded-md p-3 shadow-sm flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-900">Charge ch_3N2j...</div>
            <div className="text-xs text-slate-500 mt-0.5">$80,000.00 Gross • Oct 16, 2023</div>
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded shadow-sm hover:bg-slate-50 transition-colors">
              Search other
            </button>
            <button className="px-3 py-1.5 text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 rounded shadow-sm hover:bg-emerald-100 transition-colors flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              Confirm match
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NodeEditorGift() {
  return (
    <div className="p-5 bg-slate-50 border-t border-slate-100">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <HeartHandshake className="w-4 h-4 text-slate-500" />
          Proposed Gift
        </h4>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded shadow-sm hover:bg-slate-50 transition-colors">
            Search CRM
          </button>
          <button className="px-3 py-1.5 text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 rounded shadow-sm hover:bg-emerald-100 transition-colors flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" />
            Confirm Gift
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
          <div className="text-xs text-slate-500 font-medium mb-1">Donor</div>
          <div className="flex items-center gap-2 mb-3">
            <Building className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-medium text-slate-900">Smith Family Trust</span>
          </div>
          
          <div className="text-xs text-slate-500 font-medium mb-1 mt-4">Linked Pledge</div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-700">FY24 Major Gift</span>
            <span className="text-xs text-slate-500">$200,000 committed</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
          <div className="text-xs text-slate-500 font-medium mb-2">Split Allocation</div>
          
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-900">General Operating</div>
                <div className="text-xs text-slate-500 mt-0.5">Unrestricted</div>
              </div>
              <div className="text-sm font-medium text-slate-900">$65,000.00</div>
            </div>
            
            <div className="h-px bg-slate-100"></div>
            
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-900">Colorado Region</div>
                <div className="text-xs text-slate-500 mt-0.5">Restricted Fund</div>
              </div>
              <div className="text-sm font-medium text-slate-900">$15,000.00</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReconciliationCard({ data }: { data: CardData }) {
  const [expandedNode, setExpandedNode] = useState<string | null>(data.expanded ? "g4" : null);

  const toggleNode = (nodeId: string, isAnchor: boolean) => {
    if (isAnchor) return;
    setExpandedNode(prev => prev === nodeId ? null : nodeId);
  };

  const isResolved = data.nodes.every(n => n.status === "done" || n.status === "anchor" || n.status === "empty");
  const isFullyDone = data.nodes[0].status === "done" && data.nodes[2].status === "done";

  const { qbIcon: QbIcon } = data;

  return (
    <div className={cn(
      "bg-white rounded-lg shadow-sm border transition-all duration-200 overflow-hidden",
      isFullyDone ? "border-emerald-100 bg-emerald-50/10" : "border-slate-200 hover:border-slate-300"
    )}>
      {/* QB Anchor Header (left side of the pipeline visually, or top) */}
      <div className="px-5 py-4 flex items-center justify-between border-b border-slate-100">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <QbIcon className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-baseline gap-3">
              <h3 className="text-lg font-semibold text-slate-900 tracking-tight">{data.qbAmount}</h3>
              <span className="text-sm font-medium text-slate-600">{data.qbPayer}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
              <span>{data.qbDate}</span>
              <span>•</span>
              <span className="font-medium text-slate-600">{data.qbMethod}</span>
            </div>
          </div>
        </div>
        
        <div>
          {isFullyDone ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-100">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Reconciled
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-medium border border-amber-100">
              <AlertCircle className="w-3.5 h-3.5" />
              Needs review
            </div>
          )}
        </div>
      </div>

      {/* The Pipeline */}
      <div className="px-3 py-3 flex items-center gap-1 relative overflow-x-auto hide-scrollbar">
        {data.nodes.map((node, i) => (
          <React.Fragment key={node.id}>
            <PipelineNode 
              node={node} 
              isActive={expandedNode === node.id}
              onClick={() => toggleNode(node.id, node.status === "anchor")}
            />
            {i < data.nodes.length - 1 && (
              <div className="shrink-0 px-1 text-slate-300">
                <ChevronRight className="w-4 h-4" />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Expanded Inline Editor */}
      {expandedNode && (
        <div className="animate-in slide-in-from-top-2 fade-in duration-200">
          {data.nodes.find(n => n.id === expandedNode)?.type === "source" && <NodeEditorSource />}
          {data.nodes.find(n => n.id === expandedNode)?.type === "gift" && <NodeEditorGift />}
          {data.nodes.find(n => n.id === expandedNode)?.type === "pledge" && <NodeEditorGift />}
        </div>
      )}
    </div>
  );
}

export function Pipeline() {
  return (
    <div className="rc-root py-12 px-6">
      <div className="max-w-[760px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Reconciliation Queue</h1>
          <p className="text-sm text-slate-500 mt-1">Review and link QuickBooks deposits to the CRM.</p>
        </div>
        
        <div className="flex flex-col gap-4">
          {CARDS.map(card => (
            <ReconciliationCard key={card.id} data={card} />
          ))}
        </div>
      </div>
    </div>
  );
}
