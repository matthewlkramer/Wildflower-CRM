import { useState } from "react";
import { useListOpportunities, getListOpportunitiesQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency, formatFund, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LayoutGrid, List } from "lucide-react";

const STAGES = [
  "pre_conversation",
  "conversation",
  "solicitation",
  "negotiation",
  "committed",
  "funded",
  "stewarding",
  "declined",
  "withdrawn"
];

function formatStageName(stage: string) {
  return stage.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export default function Opportunities() {
  const [view, setView] = useState<"kanban" | "list">("kanban");
  
  const { data, isLoading } = useListOpportunities(undefined, {
    query: {
      queryKey: getListOpportunitiesQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Opportunities</h1>
        <div className="flex items-center gap-4">
          <div className="flex items-center rounded-md border p-1 bg-muted/50">
            <Button 
              variant={view === "kanban" ? "secondary" : "ghost"} 
              size="sm" 
              className="h-7 px-2"
              onClick={() => setView("kanban")}
            >
              <LayoutGrid className="h-4 w-4 mr-2" /> Kanban
            </Button>
            <Button 
              variant={view === "list" ? "secondary" : "ghost"} 
              size="sm" 
              className="h-7 px-2"
              onClick={() => setView("list")}
            >
              <List className="h-4 w-4 mr-2" /> List
            </Button>
          </div>
          <Link href="/opportunities/new" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
            Add Opportunity
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-muted-foreground animate-pulse">Loading opportunities...</div>
      ) : view === "list" ? (
        <div className="rounded-md border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Opportunity</TableHead>
                <TableHead>Donor</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Fund</TableHead>
                <TableHead>Close Date</TableHead>
                <TableHead className="text-right">Expected Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">No opportunities found.</TableCell>
                </TableRow>
              ) : (
                data?.data.map((opp) => (
                  <TableRow key={opp.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                    <TableCell className="font-medium">
                      <Link href={`/opportunities/${opp.id}`} className="block w-full">
                        {opp.name || `${opp.donorName} Opportunity`}
                      </Link>
                    </TableCell>
                    <TableCell>{opp.donorName}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{formatStageName(opp.stage)}</Badge>
                    </TableCell>
                    <TableCell>{formatFund(opp.fund)}</TableCell>
                    <TableCell>{formatDate(opp.expectedCloseDate)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(opp.amountExpected)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 h-[calc(100vh-12rem)]">
          {STAGES.map(stage => {
            const stageOpps = data?.data.filter(opp => opp.stage === stage) || [];
            return (
              <div key={stage} className="flex-shrink-0 w-80 flex flex-col bg-muted/30 rounded-lg border border-border">
                <div className="p-3 border-b flex items-center justify-between bg-muted/50 rounded-t-lg">
                  <h3 className="font-medium text-sm text-foreground">{formatStageName(stage)}</h3>
                  <Badge variant="secondary" className="text-xs font-normal">{stageOpps.length}</Badge>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {stageOpps.map(opp => (
                    <Card key={opp.id} className="cursor-pointer hover:border-primary/50 transition-colors shadow-sm">
                      <Link href={`/opportunities/${opp.id}`}>
                        <CardHeader className="p-3 pb-2">
                          <CardTitle className="text-sm font-medium leading-none">
                            {opp.name || `${opp.donorName} Opportunity`}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-3 pt-0 text-xs space-y-1.5 text-muted-foreground">
                          <div className="flex justify-between items-center text-foreground font-medium">
                            <span>{opp.donorName}</span>
                            <span>{formatCurrency(opp.amountExpected)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>{formatFund(opp.fund)}</span>
                            <span>{formatDate(opp.expectedCloseDate)}</span>
                          </div>
                        </CardContent>
                      </Link>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
