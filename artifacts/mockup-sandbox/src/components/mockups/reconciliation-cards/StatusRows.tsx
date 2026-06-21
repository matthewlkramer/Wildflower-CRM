import "./_group.css";
import React, { useState } from "react";
import { ChevronDown, ChevronUp, CheckCircle2, AlertCircle, Circle, Search, Link as LinkIcon, Split, CreditCard, Landmark, Banknote, HelpCircle } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Status = "confirmed" | "proposed" | "unlinked";

interface CardProps {
  id: string;
  payerName: string;
  date: string;
  amount: string;
  paymentMethod: "Visa" | "Stock" | "Check" | "ACH" | "Unknown";
  fundingStatus: Status;
  fundingSummary: string;
  crmStatus: Status;
  crmSummary: string;
  defaultExpanded?: boolean;
  expandedContent?: React.ReactNode;
}

function StatusChip({ status, text }: { status: Status; text: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border",
        status === "confirmed" && "bg-emerald-50 text-emerald-700 border-emerald-200",
        status === "proposed" && "bg-amber-50 text-amber-700 border-amber-200",
        status === "unlinked" && "bg-slate-50 text-slate-600 border-slate-200"
      )}
    >
      {status === "confirmed" && <CheckCircle2 className="w-3 h-3" />}
      {status === "proposed" && <AlertCircle className="w-3 h-3" />}
      {status === "unlinked" && <Circle className="w-3 h-3" />}
      {text}
    </span>
  );
}

function MethodBadge({ method }: { method: CardProps["paymentMethod"] }) {
  const Icon = method === "Visa" ? CreditCard : method === "Stock" ? Landmark : method === "Check" ? Banknote : HelpCircle;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium bg-slate-100 text-slate-600">
      <Icon className="w-3.5 h-3.5" />
      {method}
    </span>
  );
}

function StatusRowCard({ card }: { card: CardProps }) {
  const [expanded, setExpanded] = useState(card.defaultExpanded || false);

  const overallStatus =
    card.fundingStatus === "confirmed" && card.crmStatus === "confirmed"
      ? "done"
      : "review";

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden mb-4 transition-all">
      {/* Header Row */}
      <div
        className={cn(
          "px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition-colors",
          expanded && "border-b border-slate-100 bg-slate-50/50"
        )}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-slate-900">{card.payerName}</span>
            <span className="text-xs text-slate-500">{card.date}</span>
          </div>
          <div className="text-sm font-medium text-slate-900">{card.amount}</div>
          <MethodBadge method={card.paymentMethod} />
        </div>
        
        <div className="flex items-center gap-4">
          {overallStatus === "done" ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Done
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
              <AlertCircle className="w-3.5 h-3.5" />
              Needs Review
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {/* Collapsed Rows */}
      {!expanded && (
        <div className="px-4 pb-3 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="w-24 text-xs font-medium text-slate-500 uppercase tracking-wider">Funding</div>
            <StatusChip status={card.fundingStatus} text={card.fundingStatus === "confirmed" ? "Confirmed" : card.fundingStatus === "proposed" ? "Proposed" : "Not Linked"} />
            <span className="text-sm text-slate-700 truncate">{card.fundingSummary}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-24 text-xs font-medium text-slate-500 uppercase tracking-wider">CRM Record</div>
            <StatusChip status={card.crmStatus} text={card.crmStatus === "confirmed" ? "Confirmed" : card.crmStatus === "proposed" ? "Proposed" : "Not Linked"} />
            <span className="text-sm text-slate-700 truncate">{card.crmSummary}</span>
          </div>
        </div>
      )}

      {/* Expanded Content */}
      {expanded && (
        <div className="px-4 py-4 bg-slate-50/50 flex flex-col gap-4">
          {card.expandedContent ? (
            card.expandedContent
          ) : (
            <div className="text-sm text-slate-500 italic text-center py-4">
              Expandable resolver sections go here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const BROKERAGE_EXPANDED_CONTENT = (
  <div className="flex flex-col gap-4">
    {/* Funding Source Panel */}
    <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            Funding Source
            <StatusChip status="confirmed" text="Confirmed" />
          </h4>
          <p className="text-xs text-slate-500 mt-1">QuickBooks deposit via brokerage account. No Stripe linkage required.</p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 text-xs font-medium border border-slate-200 text-slate-600 rounded hover:bg-slate-50">Unlink</button>
        </div>
      </div>
      <div className="bg-slate-50 p-3 rounded border border-slate-100 text-sm flex justify-between items-center">
        <div>
          <span className="font-medium text-slate-900">Fidelity Brokerage Services</span>
          <span className="text-slate-500 ml-2">Deposit • Oct 12, 2025</span>
        </div>
        <span className="font-medium">$80,000.00</span>
      </div>
    </div>

    {/* CRM Record Panel */}
    <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm border-l-4 border-l-amber-400">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            CRM Record
            <StatusChip status="proposed" text="Proposed" />
          </h4>
          <p className="text-xs text-slate-500 mt-1">Gift attached to a pledge.</p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 text-xs font-medium border border-slate-200 text-slate-600 rounded hover:bg-slate-50">Switch donor</button>
          <button className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90">Confirm gift</button>
        </div>
      </div>

      <div className="relative">
        <div className="absolute left-3 top-3 bottom-0 w-px bg-slate-200"></div>
        
        <div className="flex gap-3 mb-4 relative">
          <div className="w-6 h-6 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center z-10 shrink-0 mt-0.5">
            <span className="text-[10px] font-medium text-slate-500">D</span>
          </div>
          <div>
            <div className="text-sm font-medium text-slate-900">Fidelity Charitable</div>
            <div className="text-xs text-slate-500">Organization donor</div>
          </div>
        </div>

        <div className="flex gap-3 relative">
          <div className="w-6 h-6 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center z-10 shrink-0 mt-0.5">
            <Split className="w-3 h-3 text-slate-500" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-slate-900 mb-2">Split Allocation</div>
            <div className="bg-slate-50 border border-slate-100 rounded-md p-3">
              <div className="flex justify-between items-center mb-2 pb-2 border-b border-slate-100">
                <span className="text-sm text-slate-700">General Operating (Pledge payment)</span>
                <span className="text-sm font-medium">$65,000.00</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-700">Southeast Region Fund</span>
                <span className="text-sm font-medium">$15,000.00</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

export function StatusRows() {
  const cards: CardProps[] = [
    {
      id: "1",
      payerName: "Patagonia Inc.",
      date: "Oct 15",
      amount: "$5,000.00",
      paymentMethod: "Visa",
      fundingStatus: "confirmed",
      fundingSummary: "Stripe charge #ch_1N...",
      crmStatus: "confirmed",
      crmSummary: "Gift to Patagonia Inc.",
    },
    {
      id: "2",
      payerName: "J. Rivera",
      date: "Oct 14",
      amount: "$250.00",
      paymentMethod: "Visa",
      fundingStatus: "proposed",
      fundingSummary: "Stripe charge #ch_8A...",
      crmStatus: "proposed",
      crmSummary: "Gift to J. Rivera",
    },
    {
      id: "3",
      payerName: "Online donor",
      date: "Oct 14",
      amount: "$100.00",
      paymentMethod: "Visa",
      fundingStatus: "unlinked",
      fundingSummary: "No Stripe match found",
      crmStatus: "proposed",
      crmSummary: "Gift to Unknown",
    },
    {
      id: "4",
      payerName: "Fidelity Brokerage Services",
      date: "Oct 12",
      amount: "$80,000.00",
      paymentMethod: "Stock",
      fundingStatus: "confirmed",
      fundingSummary: "QuickBooks deposit",
      crmStatus: "proposed",
      crmSummary: "Split gift attached to pledge",
      defaultExpanded: true,
      expandedContent: BROKERAGE_EXPANDED_CONTENT,
    },
    {
      id: "5",
      payerName: "Helen Mott Trust",
      date: "Oct 10",
      amount: "$25,000.00",
      paymentMethod: "Check",
      fundingStatus: "confirmed",
      fundingSummary: "QuickBooks deposit",
      crmStatus: "confirmed",
      crmSummary: "Gift to Helen Mott Trust",
    },
    {
      id: "6",
      payerName: "Unknown Payer",
      date: "Oct 08",
      amount: "$500.00",
      paymentMethod: "ACH",
      fundingStatus: "confirmed",
      fundingSummary: "QuickBooks deposit",
      crmStatus: "unlinked",
      crmSummary: "No gift linked",
    },
  ];

  return (
    <div className="rc-root py-12 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-slate-900">Reconciliation Queue</h2>
          <p className="text-sm text-slate-500">Review and confirm QuickBooks deposits.</p>
        </div>
        
        <div className="flex flex-col">
          {cards.map(card => (
            <StatusRowCard key={card.id} card={card} />
          ))}
        </div>
      </div>
    </div>
  );
}
