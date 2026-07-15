import React from "react";
import "./_board.css";
import { Search, Check, ArrowRight, DollarSign, RefreshCw, AlertCircle, Link as LinkIcon, MoreHorizontal, FileText, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export function StateBoard() {
  return (
    <div className="flex flex-col h-screen max-h-screen bg-[#f8fafc] wb-font-sans text-[#0f172a] overflow-hidden">
      {/* Header / Scoreboard */}
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reconciliation Board</h1>
          <p className="text-sm text-slate-500 mt-0.5">Walton Family Foundation, June-July 2026</p>
        </div>
        
        <div className="flex gap-8">
          <ScoreItem label="Needs Match" amount="$12,425.00" count={3} color="text-slate-600" />
          <ScoreItem label="Proposed" amount="$9,712.88" count={1} color="text-blue-600" />
          <ScoreItem label="Staged" amount="$1,100.00" count={2} color="text-amber-600" />
          <ScoreItem label="Settled" amount="$54,200.00" count={18} color="text-green-600" />
        </div>
        
        <div className="flex items-center gap-3">
          <Button variant="outline" className="h-9">
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button className="h-9 bg-blue-600 hover:bg-blue-700">
            Apply 2 Staged
          </Button>
        </div>
      </header>

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-6">
        <div className="flex gap-6 h-full items-start w-max min-w-full">
          
          <BoardColumn title="Needs Match" count={3} amount="$12,425.00" color="bg-slate-100">
            <Card 
              evidence={{ source: "QuickBooks", amount: "$5,000.00", date: "Jul 12", detail: "Direct Deposit" }}
              action={{ label: "Search CRM", icon: <Search className="w-3.5 h-3.5" />, primary: true }}
            />
            <Card 
              evidence={{ source: "Stripe", amount: "$2,425.00", date: "Jul 10", detail: "Payout STR-882" }}
              action={{ label: "Search CRM", icon: <Search className="w-3.5 h-3.5" />, primary: true }}
            />
            <Card 
              evidence={{ source: "Donorbox", amount: "$5,000.00", date: "Jul 09", detail: "Campaign: Summer" }}
              action={{ label: "Search CRM", icon: <Search className="w-3.5 h-3.5" />, primary: true }}
            />
          </BoardColumn>

          <BoardColumn title="Proposed" count={1} amount="$9,712.88" color="bg-blue-50/50">
            <Card 
              evidence={{ source: "QuickBooks", amount: "$9,712.88", date: "Jul 15", detail: "Deposit" }}
              crm={{ name: "Walton Family Foundation", amount: "$10,000.00", detail: "General Ops" }}
              balanced={true}
              fee="$287.12 fee"
              action={{ label: "Stage Match", icon: <ArrowRight className="w-3.5 h-3.5" />, primary: true, color: "bg-blue-600 hover:bg-blue-700 text-white" }}
            />
          </BoardColumn>

          <BoardColumn title="Staged" count={2} amount="$1,100.00" color="bg-amber-50/50 border-amber-200 border-dashed border-2">
            <Card 
              evidence={{ source: "Donorbox", amount: "$100.00", date: "Jul 14", detail: "Recurring" }}
              crm={{ name: "Maria Torres", amount: "$100.00", detail: "Scholarship Fund" }}
              balanced={true}
              action={{ label: "Unstage", icon: <RefreshCw className="w-3.5 h-3.5" />, primary: false }}
            />
            <Card 
              evidence={{ source: "Stripe", amount: "$1,000.00", date: "Jul 14", detail: "Charge" }}
              crm={{ name: "David Chen", amount: "$1,000.00", detail: "Annual Gala" }}
              balanced={true}
              action={{ label: "Unstage", icon: <RefreshCw className="w-3.5 h-3.5" />, primary: false }}
            />
          </BoardColumn>

          <BoardColumn title="Settled" count={18} amount="$54,200.00" color="bg-green-50/50 opacity-75">
            <Card 
              evidence={{ source: "QuickBooks", amount: "$15,000.00", date: "Jul 01", detail: "Check #1042" }}
              crm={{ name: "Gates Foundation", amount: "$15,000.00", detail: "Restricted" }}
              balanced={true}
              settled={true}
            />
            <Card 
              evidence={{ source: "Stripe", amount: "$4,850.00", date: "Jun 28", detail: "Payout" }}
              crm={{ name: "Multiple Donors", amount: "$5,000.00", detail: "Split 5 ways" }}
              balanced={true}
              fee="$150.00 fee"
              settled={true}
            />
          </BoardColumn>

        </div>
      </div>
    </div>
  );
}

function ScoreItem({ label, amount, count, color }: { label: string, amount: string, count: number, color: string }) {
  return (
    <div className="flex flex-col items-end">
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-0.5 flex items-center gap-1.5">
        {label}
        <span className="bg-slate-100 text-slate-600 px-1.5 py-0 rounded-full text-[10px]">{count}</span>
      </div>
      <div className={`wb-font-mono text-lg font-semibold ${color}`}>
        {amount}
      </div>
    </div>
  );
}

function BoardColumn({ title, count, amount, color, children }: { title: string, count: number, amount: string, color: string, children: React.ReactNode }) {
  return (
    <div className={`flex flex-col w-[340px] shrink-0 rounded-xl max-h-full ${color}`}>
      <div className="p-4 flex items-center justify-between border-b border-black/5 shrink-0">
        <h2 className="font-semibold text-sm flex items-center gap-2">
          {title}
          <Badge variant="secondary" className="font-mono text-xs">{count}</Badge>
        </h2>
        <div className="text-xs font-mono font-medium text-slate-500">{amount}</div>
      </div>
      <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-3 custom-scrollbar">
        {children}
      </div>
    </div>
  );
}

function Card({ evidence, crm, balanced, fee, action, settled }: any) {
  return (
    <div className={`bg-white rounded-lg border shadow-sm flex flex-col overflow-hidden transition-all hover:shadow-md ${settled ? 'border-green-200' : 'border-slate-200'}`}>
      
      {/* Evidence vs CRM lanes */}
      <div className="flex flex-col p-3 gap-3">
        {/* Evidence Lane */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium flex items-center gap-1.5 text-slate-700">
              <div className="w-2 h-2 rounded-full bg-slate-400" />
              {evidence.source}
            </span>
            <span className="text-slate-500">{evidence.date}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-sm text-slate-600 truncate mr-2">{evidence.detail}</span>
            <span className="font-mono font-semibold text-sm">{evidence.amount}</span>
          </div>
        </div>

        {/* Link / Status indicator */}
        <div className="flex items-center gap-2 relative py-1">
          <div className="h-px bg-slate-100 flex-1 absolute top-1/2 left-0 right-0 -z-10" />
          {crm ? (
            <div className="mx-auto bg-white px-2 flex items-center gap-1.5">
              {balanced ? (
                 <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 font-normal border-green-200 bg-green-50 text-green-700`}>
                   <Check className="w-3 h-3 mr-1" /> Balanced {fee && <span className="ml-1 opacity-70">({fee})</span>}
                 </Badge>
              ) : (
                 <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-normal border-amber-200 bg-amber-50 text-amber-700">
                   <AlertCircle className="w-3 h-3 mr-1" /> Unbalanced
                 </Badge>
              )}
            </div>
          ) : (
            <div className="mx-auto bg-white px-2">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-normal text-slate-400 border-dashed">
                Unlinked
              </Badge>
            </div>
          )}
        </div>

        {/* CRM Lane */}
        {crm ? (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center text-xs">
              <span className="font-medium flex items-center gap-1.5 text-slate-700">
                <div className="w-2 h-2 rounded-full bg-blue-400" />
                CRM Record
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-medium text-slate-900 truncate mr-2">{crm.name}</span>
              <span className="font-mono font-semibold text-sm">{crm.amount}</span>
            </div>
            <div className="text-xs text-slate-500 truncate">{crm.detail}</div>
          </div>
        ) : (
          <div className="h-12 border border-dashed border-slate-200 rounded bg-slate-50 flex items-center justify-center text-xs text-slate-400">
            No CRM record selected
          </div>
        )}
      </div>

      {/* Action Footer */}
      {!settled && action && (
        <div className="bg-slate-50 border-t border-slate-100 p-2 flex items-center justify-between">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem>Split across gifts</DropdownMenuItem>
              <DropdownMenuItem>Group deposits</DropdownMenuItem>
              <DropdownMenuItem>Flag for research</DropdownMenuItem>
              <DropdownMenuItem className="text-red-600">Exclude (with reason)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button 
            size="sm" 
            variant={action.primary ? "default" : "secondary"}
            className={`h-7 text-xs ${action.color || ''}`}
          >
            {action.label}
            {action.icon && <span className="ml-1.5">{action.icon}</span>}
          </Button>
        </div>
      )}
    </div>
  );
}
