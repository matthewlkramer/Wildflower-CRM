import "./_group.css";
import React, { useState } from "react";
import { 
  CheckCircle2, 
  CircleDashed, 
  Link as LinkIcon, 
  AlertCircle, 
  ChevronDown, 
  ChevronUp, 
  Search, 
  Building, 
  CreditCard,
  Banknote,
  Landmark,
  User,
  ArrowRight,
  Split,
  ChevronRight
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Status = "confirmed" | "proposed" | "unlinked";

interface CardData {
  id: string;
  qb: {
    payer: string;
    date: string;
    amount: string;
    method: "Visa" | "Stock" | "Check" | "ACH";
  };
  funding: {
    type: "Stripe" | "QuickBooks" | "None";
    status: Status;
    detail?: string;
    fee?: string;
  };
  crm: {
    status: Status;
    donor?: string;
    donorType?: "org" | "individual";
    giftName?: string;
    pledge?: string;
    allocations?: { fund: string; amount: string }[];
  };
  expandedDefault?: boolean;
}

const mockData: CardData[] = [
  {
    id: "1",
    qb: { payer: "Patagonia Inc.", date: "Oct 12, 2026", amount: "$5,000.00", method: "Visa" },
    funding: { type: "Stripe", status: "confirmed", detail: "ch_3P9Z...", fee: "-$145.30 fee" },
    crm: { status: "confirmed", donor: "Patagonia Inc.", donorType: "org", giftName: "Online Donation", pledge: "FY26 Corporate Giving" },
  },
  {
    id: "2",
    qb: { payer: "J. Rivera", date: "Oct 12, 2026", amount: "$250.00", method: "Visa" },
    funding: { type: "Stripe", status: "proposed", detail: "ch_3P8X...", fee: "-$7.55 fee" },
    crm: { status: "proposed", donor: "Julian Rivera", donorType: "individual", giftName: "Online Donation" },
  },
  {
    id: "3",
    qb: { payer: "Stripe Transfer", date: "Oct 11, 2026", amount: "$1,200.00", method: "Visa" },
    funding: { type: "None", status: "unlinked" },
    crm: { status: "proposed", donor: "Unknown Online Donor", donorType: "individual", giftName: "Proposed Web Gift" },
  },
  {
    id: "4",
    qb: { payer: "Fidelity Investments", date: "Oct 10, 2026", amount: "$80,000.00", method: "Stock" },
    funding: { type: "QuickBooks", status: "confirmed", detail: "Deposit #8829" },
    crm: { 
      status: "proposed", 
      donor: "The Chen Family Trust", 
      donorType: "org", 
      giftName: "Stock Transfer", 
      pledge: "Chen Major Gift 2026",
      allocations: [
        { fund: "General Operating", amount: "$65,000.00" },
        { fund: "Southeast Region", amount: "$15,000.00" }
      ]
    },
    expandedDefault: true
  },
  {
    id: "5",
    qb: { payer: "Helen Mott Trust", date: "Oct 09, 2026", amount: "$25,000.00", method: "Check" },
    funding: { type: "QuickBooks", status: "confirmed", detail: "Check #1042" },
    crm: { status: "confirmed", donor: "Helen Mott Trust", donorType: "org", giftName: "Check Donation" },
  },
  {
    id: "6",
    qb: { payer: "Anonymous", date: "Oct 08, 2026", amount: "$1,500.00", method: "ACH" },
    funding: { type: "QuickBooks", status: "proposed", detail: "Wire Transfer" },
    crm: { status: "unlinked" },
  }
];

function MethodIcon({ method }: { method: string }) {
  switch (method) {
    case "Visa": return <CreditCard className="w-4 h-4 text-slate-400" />;
    case "Stock": return <Landmark className="w-4 h-4 text-slate-400" />;
    case "Check": return <Banknote className="w-4 h-4 text-slate-400" />;
    case "ACH": return <Landmark className="w-4 h-4 text-slate-400" />;
    default: return <Banknote className="w-4 h-4 text-slate-400" />;
  }
}

function StatusIndicator({ status }: { status: Status }) {
  if (status === "confirmed") return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
  if (status === "proposed") return <CircleDashed className="w-4 h-4 text-amber-500" />;
  return <CircleDashed className="w-4 h-4 text-slate-300" />;
}

function StatusBadge({ status, text }: { status: Status; text: string }) {
  if (status === "confirmed") {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">{text}</span>;
  }
  if (status === "proposed") {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">{text}</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">{text}</span>;
}

export function TwoLanes() {
  const [expandedId, setExpandedId] = useState<string | null>("4");

  return (
    <div className="rc-root rc-bg-background min-h-screen py-12 px-4 flex flex-col items-center">
      <div className="w-full max-w-[800px] space-y-4">
        
        <div className="mb-8">
          <h1 className="text-2xl font-semibold rc-text-primary tracking-tight">Reconciliation Queue</h1>
          <p className="rc-text-muted mt-1 text-sm">Confirm funding sources and match them to CRM records.</p>
        </div>

        {mockData.map((card) => {
          const isExpanded = expandedId === card.id;
          const isFullyResolved = card.funding.status === "confirmed" && card.crm.status === "confirmed";

          return (
            <div 
              key={card.id} 
              className={cn(
                "rc-bg-card rounded-xl border transition-all duration-200 flex flex-col relative",
                isExpanded ? "border-slate-300 shadow-md ring-1 ring-slate-100 ring-offset-0" : "rc-border shadow-sm hover:border-slate-300",
                isFullyResolved && !isExpanded ? "bg-slate-50/50" : ""
              )}
            >
              {/* ABSOLUTE STATUS BAR (Left Edge) */}
              <div className={cn(
                "absolute left-0 top-0 bottom-0 w-1 rounded-l-xl",
                isFullyResolved ? "bg-emerald-500" : "bg-amber-400"
              )} />

              {/* HEADER - Always visible */}
              <div 
                className="flex items-center justify-between p-4 pl-5 cursor-pointer group"
                onClick={() => setExpandedId(isExpanded ? null : card.id)}
              >
                <div className="flex items-center gap-4 flex-1">
                  <div className="flex items-center gap-3 w-1/3 min-w-[200px]">
                    <div className="p-2 bg-slate-50 rounded-lg border border-slate-100">
                      <MethodIcon method={card.qb.method} />
                    </div>
                    <div>
                      <div className="font-medium text-sm text-slate-900 line-clamp-1">{card.qb.payer}</div>
                      <div className="text-xs rc-text-muted flex items-center gap-1.5 mt-0.5">
                        <span>{card.qb.date}</span>
                        <span className="w-1 h-1 rounded-full bg-slate-300" />
                        <span>{card.qb.method}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="text-base font-semibold text-slate-900 tabular-nums w-[100px]">
                    {card.qb.amount}
                  </div>

                  {!isExpanded && (
                    <div className="flex-1 flex items-center gap-6 pr-4 opacity-100 transition-opacity">
                      {/* Collapsed Summaries */}
                      <div className="flex items-center gap-2 flex-1">
                        <StatusIndicator status={card.funding.status} />
                        <span className="text-sm text-slate-600 truncate">
                          {card.funding.type === "None" ? "No funding source linked" : `${card.funding.type} ${card.funding.detail ? `· ${card.funding.detail}` : ''}`}
                        </span>
                      </div>
                      
                      <div className="text-slate-300"><LinkIcon className="w-3.5 h-3.5" /></div>

                      <div className="flex items-center gap-2 flex-1">
                        <StatusIndicator status={card.crm.status} />
                        <span className="text-sm text-slate-600 truncate">
                          {card.crm.status === "unlinked" ? "No CRM record linked" : `${card.crm.donor}`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end w-8 text-slate-400 group-hover:text-slate-600">
                  {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </div>
              </div>

              {/* EXPANDED BODY */}
              {isExpanded && (
                <div className="border-t rc-border bg-slate-50/30 flex relative">
                  
                  {/* Connective Line Down the Middle */}
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-200 -translate-x-1/2 z-0" />
                  <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-slate-200 rounded-full p-1.5 z-10 shadow-sm text-slate-400">
                    <LinkIcon className="w-4 h-4" />
                  </div>

                  {/* LEFT LANE: Funding Source */}
                  <div className="w-1/2 p-6 pr-8 z-0">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-slate-900">Funding Source</h3>
                      <StatusBadge 
                        status={card.funding.status} 
                        text={card.funding.status === "confirmed" ? "Confirmed" : card.funding.status === "proposed" ? "Proposed Match" : "Not Linked"} 
                      />
                    </div>

                    {card.funding.status !== "unlinked" ? (
                      <div className="bg-white border rc-border rounded-lg p-4 shadow-sm">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="text-sm font-medium text-slate-900">{card.funding.type} Charge</div>
                            <div className="text-xs text-slate-500 mt-1">{card.funding.detail}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium tabular-nums text-slate-900">{card.qb.amount}</div>
                            {card.funding.fee && <div className="text-xs text-slate-500 mt-1">{card.funding.fee}</div>}
                          </div>
                        </div>
                        
                        <div className="mt-5 pt-4 border-t rc-border flex items-center gap-2">
                          {card.funding.status === "confirmed" ? (
                            <button className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded bg-slate-100 hover:bg-slate-200 transition-colors">
                              Unlink
                            </button>
                          ) : (
                            <>
                              <button className="text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 rounded transition-colors shadow-sm">
                                Confirm match
                              </button>
                              <button className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded hover:bg-slate-100 transition-colors">
                                Reject
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-white border border-dashed border-slate-300 rounded-lg p-4 flex flex-col items-center justify-center text-center h-[120px]">
                        <Search className="w-5 h-5 text-slate-400 mb-2" />
                        <span className="text-sm text-slate-600">Search Stripe or QuickBooks</span>
                        <button className="mt-2 text-xs font-medium rc-text-primary hover:underline">Find match</button>
                      </div>
                    )}
                  </div>

                  {/* RIGHT LANE: CRM Record */}
                  <div className="w-1/2 p-6 pl-8 z-0">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-slate-900">CRM Record</h3>
                      <StatusBadge 
                        status={card.crm.status} 
                        text={card.crm.status === "confirmed" ? "Confirmed" : card.crm.status === "proposed" ? "Proposed Gift" : "Not Linked"} 
                      />
                    </div>

                    {card.crm.status !== "unlinked" ? (
                      <div className="bg-white border rc-border rounded-lg p-4 shadow-sm">
                        <div className="flex items-start gap-3">
                          <div className="p-2 bg-emerald-50 text-emerald-700 rounded-md shrink-0 mt-0.5">
                            {card.crm.donorType === "org" ? <Building className="w-4 h-4" /> : <User className="w-4 h-4" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">{card.crm.donor}</div>
                            <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
                              {card.crm.giftName}
                            </div>
                            
                            {card.crm.pledge && (
                              <div className="mt-2 text-xs flex items-center gap-1.5 text-slate-600 bg-slate-50 border border-slate-100 rounded px-2 py-1 inline-flex">
                                <ArrowRight className="w-3 h-3 text-slate-400" />
                                <span>Pays toward: <span className="font-medium text-slate-700">{card.crm.pledge}</span></span>
                              </div>
                            )}

                            {card.crm.allocations && (
                              <div className="mt-3 space-y-1.5">
                                <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider flex items-center gap-1">
                                  <Split className="w-3 h-3" /> Allocations
                                </div>
                                {card.crm.allocations.map((alloc, i) => (
                                  <div key={i} className="flex items-center justify-between text-xs bg-slate-50 px-2 py-1.5 rounded border border-slate-100">
                                    <span className="text-slate-600">{alloc.fund}</span>
                                    <span className="font-medium text-slate-700 tabular-nums">{alloc.amount}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="mt-5 pt-4 border-t rc-border flex items-center gap-2">
                          {card.crm.status === "confirmed" ? (
                            <>
                              <button className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded bg-slate-100 hover:bg-slate-200 transition-colors">
                                Edit gift
                              </button>
                              <button className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded hover:bg-slate-100 transition-colors ml-auto">
                                Change donor
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 rounded transition-colors shadow-sm">
                                Confirm gift
                              </button>
                              <button className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded hover:bg-slate-100 transition-colors">
                                Switch donor
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-white border border-dashed border-slate-300 rounded-lg p-4 flex flex-col items-center justify-center text-center h-[120px]">
                        <Search className="w-5 h-5 text-slate-400 mb-2" />
                        <span className="text-sm text-slate-600">Search for a donor or gift</span>
                        <button className="mt-2 text-xs font-medium rc-text-primary hover:underline">Find record</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TwoLanes;
