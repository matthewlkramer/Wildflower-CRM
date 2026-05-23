import { useState } from "react";
import { Link } from "wouter";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
  type OpportunityStage,
  type OpportunityType,
} from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

const STATUSES: OpportunityStatus[] = ["open", "won", "dormant", "lost"];
const STAGES: OpportunityStage[] = [
  "cold_lead",
  "warm_lead",
  "in_conversation",
  "convince",
  "conditional_commitment",
  "probable_renewal",
  "verbal_commitment",
  "written_commitment",
  "cash_in",
];
const TYPES: OpportunityType[] = ["solicitation", "renewal", "open_application"];

const PAGE_SIZE = 50;
const ANY = "_any";

type Props = {
  title?: string;
  /** When set, locks the status filter to this value and hides the control. */
  lockedStatus?: OpportunityStatus;
  /** Default for the status filter when not locked. */
  defaultStatus?: OpportunityStatus | null;
  basePath?: string;
};

export default function Opportunities({
  title = "Opportunities",
  lockedStatus,
  defaultStatus = null,
  basePath = "/opportunities",
}: Props) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [status, setStatus] = useState<string>(defaultStatus ?? ANY);
  const [stage, setStage] = useState<string>(ANY);
  const [type, setType] = useState<string>(ANY);
  const [page, setPage] = useState(1);

  const effectiveStatus = lockedStatus ?? (status !== ANY ? (status as OpportunityStatus) : undefined);

  const params: ListOpportunitiesAndPledgesParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(stage !== ANY ? { stage: stage as OpportunityStage } : {}),
    ...(type !== ANY ? { type: type as OpportunityType } : {}),
  };

  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(params, {
    query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <Input
            placeholder="Search by name…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            aria-label="Search opportunities by name"
            data-testid="input-search-opportunities"
          />
        </div>
        {!lockedStatus && (
          <FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUSES} testId="select-opp-status" />
        )}
        <FilterSelect label="Stage" value={stage} onChange={(v) => { setStage(v); setPage(1); }} options={STAGES} testId="select-opp-stage" />
        <FilterSelect label="Type" value={type} onChange={(v) => { setType(v); setPage(1); }} options={TYPES} testId="select-opp-type" />
        {(search || (!lockedStatus && status !== (defaultStatus ?? ANY)) || stage !== ANY || type !== ANY) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              if (!lockedStatus) setStatus(defaultStatus ?? ANY);
              setStage(ANY);
              setType(ANY);
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ask</TableHead>
              <TableHead className="text-right">Awarded</TableHead>
              <TableHead>Projected close</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center h-24 text-muted-foreground">No opportunities match these filters.</TableCell></TableRow>
            ) : (
              rows.map((o) => (
                <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-opp-${o.id}`}>
                  <TableCell className="font-medium">
                    <Link href={`${basePath}/${o.id}`} className="block w-full">{o.name ?? `Untitled ${o.id}`}</Link>
                  </TableCell>
                  <TableCell>{formatEnum(o.stage)}</TableCell>
                  <TableCell>
                    {o.status ? <Badge variant={o.status === "won" ? "default" : "outline"}>{formatEnum(o.status)}</Badge> : "—"}
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(o.askAmount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(o.awardedAmount)}</TableCell>
                  <TableCell>{formatDate(o.projectedCloseDate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)); }} aria-disabled={page <= 1} className={page <= 1 ? "pointer-events-none opacity-50" : undefined} />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>{page} / {totalPages}</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#" onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(totalPages, p + 1)); }} aria-disabled={page >= totalPages} className={page >= totalPages ? "pointer-events-none opacity-50" : undefined} />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}

function FilterSelect({
  label, value, onChange, options, testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  testId: string;
}) {
  const inputId = `filter-${testId}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={inputId} className="w-[170px]" aria-label={label} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>{formatEnum(o)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
