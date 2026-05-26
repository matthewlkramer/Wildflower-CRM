import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListFunders,
  getListFundersQueryKey,
  type ListFundersParams,
  type FundingEntitySubtype,
  type ConnectionStatus,
  type ActiveStatus,
} from "@workspace/api-client-react";
import { formatCapacity, formatCurrency, formatEnum, formatFunderNameShort } from "@/lib/format";
import { useDebounce } from "@/hooks/use-debounce";
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
import { CreateFunderDialog } from "@/components/create-funder-dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

const SUBTYPES: FundingEntitySubtype[] = [
  "family_foundation",
  "institutional_foundation",
  "corporate_foundation",
  "community_foundation",
  "bank_foundation",
  "family_office_trust",
  "intermediary",
  "government",
  "nonprofit",
  "corporation",
  "capital_provider",
  "philanthropic_advisor",
  "cdfi",
  "education_forprofit",
  "competition",
  "public_private",
  "daf_platform",
  "platform",
];

const ACTIVE_STATUSES: ActiveStatus[] = ["active", "defunct", "spenddown"];
const CONNECTION_STATUSES: ConnectionStatus[] = [
  "connected",
  "have_a_connector",
  "no_connection",
];

const PAGE_SIZE = 50;
const ANY = "_any";

export default function FundingEntities() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [subtype, setSubtype] = useState<string>(ANY);
  const [activeStatus, setActiveStatus] = useState<string>(ANY);
  const [connectionStatus, setConnectionStatus] = useState<string>(ANY);
  const [page, setPage] = useState(1);

  const params: ListFundersParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(subtype !== ANY ? { subtype: subtype as FundingEntitySubtype } : {}),
    ...(activeStatus !== ANY
      ? { activeStatus: activeStatus as ActiveStatus }
      : {}),
    ...(connectionStatus !== ANY
      ? { connectionStatus: connectionStatus as ConnectionStatus }
      : {}),
  };

  const { data, isLoading, isError, error } = useListFunders(params, {
    query: { queryKey: getListFundersQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const ts = useTableState("funding-entities");
  const CAPACITY_ORDER: Record<string, number> = {
    tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => formatFunderNameShort(r.name).toLowerCase(),
          subtype: (r) => r.fundingEntitySubtype ?? null,
          active: (r) => r.activeStatus ?? null,
          connection: (r) => r.connectionStatus ?? null,
          enthusiasm: (r) => r.enthusiasm ?? null,
          capacity: (r) =>
            r.capacityRating ? (CAPACITY_ORDER[r.capacityRating] ?? 0) : null,
          primaryContact: (r) => r.primaryContactPersonName?.toLowerCase() ?? null,
          lifetimeGiving: (r) =>
            r.lifetimeGiving != null ? Number(r.lifetimeGiving) : null,
          openAsks: (r) => r.openOpportunityCount ?? null,
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );

  function resetToFirstPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Funders
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreateFunderDialog />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <Input
            placeholder="Search by name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search funders by name"
            data-testid="input-search-funders"
          />
        </div>

        <FilterSelect
          label="Subtype"
          value={subtype}
          onChange={resetToFirstPage(setSubtype)}
          options={SUBTYPES}
          testId="select-subtype"
        />
        <FilterSelect
          label="Active status"
          value={activeStatus}
          onChange={resetToFirstPage(setActiveStatus)}
          options={ACTIVE_STATUSES}
          testId="select-active-status"
        />
        <FilterSelect
          label="Connection"
          value={connectionStatus}
          onChange={resetToFirstPage(setConnectionStatus)}
          options={CONNECTION_STATUSES}
          testId="select-connection-status"
        />

        {(search ||
          subtype !== ANY ||
          activeStatus !== ANY ||
          connectionStatus !== ANY) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setSubtype(ANY);
              setActiveStatus(ANY);
              setConnectionStatus(ANY);
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
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="subtype" {...ts}>Subtype</SortableTH>
              <SortableTH colKey="active" {...ts}>Active</SortableTH>
              <SortableTH colKey="connection" {...ts}>Connection</SortableTH>
              <SortableTH colKey="enthusiasm" {...ts}>Enthusiasm</SortableTH>
              <SortableTH colKey="capacity" {...ts}>Capacity</SortableTH>
              <SortableTH colKey="primaryContact" {...ts}>Primary contact</SortableTH>
              <SortableTH colKey="lifetimeGiving" align="right" {...ts}>Lifetime giving</SortableTH>
              <SortableTH colKey="openAsks" align="right" {...ts}>Open asks</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center h-24 text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center h-24 text-destructive"
                >
                  {error instanceof Error
                    ? error.message
                    : "Failed to load funders."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center h-24 text-muted-foreground"
                >
                  No funders match these filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((f) => {
                const hasGiving = f.lifetimeGiving != null && Number(f.lifetimeGiving) > 0;
                const openAsks = f.openOpportunityCount ?? 0;
                return (
                  <TableRow
                    key={f.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    data-testid={`row-funder-${f.id}`}
                  >
                    <TableCell className="font-medium">
                      <Link
                        href={`/funding-entities/${f.id}`}
                        className="block w-full"
                      >
                        {formatFunderNameShort(f.name)}
                      </Link>
                    </TableCell>
                    <TableCell>{formatEnum(f.fundingEntitySubtype)}</TableCell>
                    <TableCell>
                      {f.activeStatus ? (
                        <Badge
                          variant={
                            f.activeStatus === "active" ? "default" : "outline"
                          }
                        >
                          {formatEnum(f.activeStatus)}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{formatEnum(f.connectionStatus)}</TableCell>
                    <TableCell>{formatEnum(f.enthusiasm)}</TableCell>
                    <TableCell>{formatCapacity(f.capacityRating)}</TableCell>
                    <TableCell>
                      {f.primaryContactPersonId ? (
                        <Link
                          href={`/individuals/${f.primaryContactPersonId}`}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {f.primaryContactPersonName ?? f.primaryContactPersonId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hasGiving ? formatCurrency(f.lifetimeGiving) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {openAsks > 0 ? openAsks : "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.max(1, p - 1));
                }}
                aria-disabled={page <= 1}
                className={
                  page <= 1 ? "pointer-events-none opacity-50" : undefined
                }
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>
                {page} / {totalPages}
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.min(totalPages, p + 1));
                }}
                aria-disabled={page >= totalPages}
                className={
                  page >= totalPages
                    ? "pointer-events-none opacity-50"
                    : undefined
                }
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
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
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={inputId} className="w-[180px]" aria-label={label} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {formatEnum(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
