import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { format } from "date-fns";
import { 
  useListWildflowerUpdateItems,
  getListWildflowerUpdateItemsQueryKey,
  useListRelevantWildflowerUpdateItems,
  getListRelevantWildflowerUpdateItemsQueryKey,
  WildflowerUpdateItem,
  WildflowerUpdateDatePrecision,
  WildflowerUpdateEventDate
} from "@workspace/api-client-react";
import { DonorFieldPicker } from "@/components/entity-picker";
import { CreateWildflowerUpdateDialog } from "@/components/create-wildflower-update-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatEnum } from "@/lib/format";
import { ShowArchivedToggle } from "@/components/show-archived-toggle";
import { ListPageHeader } from "@/components/list-page-header";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, FileText, MapPin } from "lucide-react";

export function formatLocalDateStr(dateStr: string | null | undefined): string {
  if (!dateStr) return "?";
  const parts = dateStr.split("T")[0].split("-");
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      return format(new Date(y, m - 1, d), "MMM d, yyyy");
    }
  }
  return dateStr;
}

export function formatUpdateDate(date: WildflowerUpdateEventDate): string {
  if (!date) return "Unknown";
  switch (date.precision as string) {
    case "exact":
      return date.startDate ? formatLocalDateStr(date.startDate) : "Exact";
    case "month":
      if (date.year && date.month) {
        return format(new Date(date.year, date.month - 1), "MMMM yyyy");
      }
      return "Month";
    case "month_range": {
      const v = date as any;
      const sY = v.startYear;
      const sM = v.startMonth;
      const eY = v.endYear;
      const eM = v.endMonth;
      
      const sMonthStr = sM ? new Date(2000, sM - 1).toLocaleString('default', { month: 'long' }) : "?";
      const eMonthStr = eM ? new Date(2000, eM - 1).toLocaleString('default', { month: 'long' }) : "?";
      
      if (sY && eY && sY !== eY) {
        return `${sMonthStr} ${sY}–${eMonthStr} ${eY}`;
      } else if (sY || eY) {
        return `${sMonthStr}–${eMonthStr} ${sY || eY}`;
      }
      return `${sMonthStr}–${eMonthStr}`;
    }
    case "year":
      return date.year ? date.year.toString() : "Year";
    case "season":
      return `${date.season ?? ""} ${date.year ?? ""}`.trim() || "Season";
    case "date_range":
      return `${date.startDate ? formatLocalDateStr(date.startDate) : "?"} to ${date.endDate ? formatLocalDateStr(date.endDate) : "?"}`;
    case "unknown":
      return "Unknown";
    default:
      return "Unknown";
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-700">Completed</Badge>;
  if (status === "work_in_progress") return <Badge variant="outline" className="text-amber-600 border-amber-600">Work in Progress</Badge>;
  if (status === "reported_progress") return <Badge variant="outline" className="text-blue-600 border-blue-600">Reported Progress</Badge>;
  if (status === "proposed_work") return <Badge variant="secondary" className="text-purple-700">Proposed Work</Badge>;
  return <Badge variant="outline">{formatEnum(status)}</Badge>;
}

export default function WildflowerUpdates() {
  const [tab, setTab] = usePersistedState("wf.updates.tab", "all");
  const [showArchived, setShowArchived] = usePersistedState("wf.updates.archived", false);
  const [donorType, setDonorType] = useState<"individual" | "organization" | "household">("individual");
  const [donorId, setDonorId] = useState<string | null>(null);

  const updatesQuery = useListWildflowerUpdateItems(
    { includeArchived: showArchived, limit: 100 }, 
    { query: { queryKey: getListWildflowerUpdateItemsQueryKey({ includeArchived: showArchived, limit: 100 }), enabled: tab === "all" } }
  );

  const relevantParams = { 
    ...(donorType === "individual" ? { personId: donorId! } : {}),
    ...(donorType === "organization" ? { organizationId: donorId! } : {})
  };
  const relevantQuery = useListRelevantWildflowerUpdateItems(
    relevantParams,
    { 
      query: { 
        queryKey: getListRelevantWildflowerUpdateItemsQueryKey(relevantParams),
        enabled: tab === "relevant" && donorId !== null && donorType !== "household",
        retry: false
      } 
    }
  );

  return (
    <div className="flex h-full flex-col gap-4">
      <ListPageHeader 
        title="Wildflower Updates"
        addAction={<CreateWildflowerUpdateDialog />}
      />

      <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="all">All Updates</TabsTrigger>
            <TabsTrigger value="relevant">Donor Relevance</TabsTrigger>
          </TabsList>
          {tab === "all" && (
            <ShowArchivedToggle value={showArchived} onChange={setShowArchived} />
          )}
        </div>

        <TabsContent value="all" className="flex-1 overflow-auto mt-4 outline-none">
          <div className="rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Date</TableHead>
                  <TableHead>Title & Details</TableHead>
                  <TableHead className="w-40">Status</TableHead>
                  <TableHead className="w-40">Preparation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {updatesQuery.isLoading ? (
                  <SkeletonRows rows={5} cols={4} />
                ) : updatesQuery.data?.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center">
                      No updates found.
                    </TableCell>
                  </TableRow>
                ) : (
                  updatesQuery.data?.data.map((item) => (
                    <TableRow key={item.id} className={item.archivedAt ? "opacity-50" : ""}>
                      <TableCell className="whitespace-nowrap text-muted-foreground text-sm">
                        {formatUpdateDate(item.eventDate)}
                      </TableCell>
                      <TableCell>
                        <Link href={`/wildflower-updates/${item.id}`} className="font-medium text-primary hover:underline">
                          {item.title}
                        </Link>
                        <div className="mt-1 text-xs text-muted-foreground line-clamp-1">{item.details}</div>
                        {item.archivedAt && <Badge variant="secondary" className="mt-2">Archived</Badge>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={item.status} />
                      </TableCell>
                      <TableCell>
                        {item.preparationStatus === 'hold_for_confirmation' ? (
                           <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                             <AlertCircle className="h-3 w-3" /> Excluded (Hold)
                           </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Eligible</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="relevant" className="flex-1 flex flex-col gap-4 mt-4 outline-none">
          <div className="p-4 bg-muted/30 rounded-lg border max-w-2xl">
            <h3 className="text-sm font-medium mb-3">Find Relevant Updates</h3>
            <DonorFieldPicker 
              type={donorType}
              id={donorId}
              onChange={(t, id) => { setDonorType(t); setDonorId(id); }}
            />
            {donorType === "household" && (
              <p className="text-xs text-muted-foreground mt-2">Relevance is computed at the individual or organization level. Please select an individual or organization.</p>
            )}
          </div>

          <div className="flex-1 overflow-auto rounded-md border bg-card">
            {tab === "relevant" && donorId && donorType !== "household" ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Date</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Match Reason</TableHead>
                    <TableHead className="w-40">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {relevantQuery.isFetching ? (
                    <SkeletonRows rows={3} cols={4} />
                  ) : relevantQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-destructive">
                        Error computing relevance. {String(relevantQuery.error)}
                      </TableCell>
                    </TableRow>
                  ) : relevantQuery.data?.data.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center">
                        No eligible updates match this donor's interests or funding regions.
                      </TableCell>
                    </TableRow>
                  ) : (
                    relevantQuery.data?.data.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground text-sm">
                          {formatUpdateDate(item.eventDate)}
                        </TableCell>
                        <TableCell>
                          <Link href={`/wildflower-updates/${item.id}`} className="font-medium text-primary hover:underline">
                            {item.title}
                          </Link>
                          <div className="mt-1 text-xs text-muted-foreground line-clamp-1">{item.details}</div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {item.topicMatches?.length > 0 && (
                              <div className="flex flex-wrap gap-1 items-center">
                                <FileText className="h-3 w-3 text-muted-foreground" />
                                {item.topicMatches.map(m => (
                                  <Badge key={m} variant="secondary" className="text-[10px] py-0">{m}</Badge>
                                ))}
                              </div>
                            )}
                            {item.geographyMatches?.length > 0 && (
                              <div className="flex flex-wrap gap-1 items-center mt-1">
                                <MapPin className="h-3 w-3 text-muted-foreground" />
                                {item.geographyMatches.map(m => (
                                  <Badge key={m} variant="secondary" className="text-[10px] py-0">{m}</Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={item.status} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            ) : (
              <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">
                Select a donor above to see relevant updates.
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
