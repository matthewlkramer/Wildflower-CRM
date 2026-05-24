import { useState } from "react";
import { Link } from "wouter";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  type ListGiftsAndPaymentsParams,
  type GiftType,
  type GiftPaymentMethod,
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
import { DonorCell } from "@/components/donor-cell";

const TYPES: GiftType[] = [
  "standard_gift",
  "pledge_payment",
  "directed_gift",
  "loan_fund_investment",
  "matching_gift",
];
const METHODS: GiftPaymentMethod[] = [
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
];

const PAGE_SIZE = 50;
const ANY = "_any";

export default function Gifts() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [type, setType] = useState<string>(ANY);
  const [method, setMethod] = useState<string>(ANY);
  const [page, setPage] = useState(1);

  const params: ListGiftsAndPaymentsParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(type !== ANY ? { type: type as GiftType } : {}),
    ...(method !== ANY ? { paymentMethod: method as GiftPaymentMethod } : {}),
  };

  const { data, isLoading, isError, error } = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Gifts & payments</h1>
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
            aria-label="Search gifts by name"
            data-testid="input-search-gifts"
          />
        </div>
        <FilterSelect label="Type" value={type} onChange={(v) => { setType(v); setPage(1); }} options={TYPES} testId="select-gift-type" />
        <FilterSelect label="Method" value={method} onChange={(v) => { setMethod(v); setPage(1); }} options={METHODS} testId="select-gift-method" />
        {(search || type !== ANY || method !== ANY) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setType(ANY);
              setMethod(ANY);
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
              <TableHead>Donor</TableHead>
              <TableHead>Date received</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load gifts."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center h-24 text-muted-foreground">No gifts match these filters.</TableCell></TableRow>
            ) : (
              rows.map((g) => (
                <TableRow key={g.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-gift-${g.id}`}>
                  <TableCell className="font-medium">
                    <Link href={`/gifts/${g.id}`} className="block w-full">{g.name ?? `Gift ${g.id}`}</Link>
                  </TableCell>
                  <TableCell>
                    <DonorCell
                      funderId={g.funderId}
                      funderName={g.funderName}
                      householdId={g.householdId}
                      householdName={g.householdName}
                      individualGiverPersonId={g.individualGiverPersonId}
                      individualGiverPersonName={g.individualGiverPersonName}
                    />
                  </TableCell>
                  <TableCell>{formatDate(g.dateReceived)}</TableCell>
                  <TableCell>{formatEnum(g.type)}</TableCell>
                  <TableCell>{formatEnum(g.paymentMethod)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(g.amount)}</TableCell>
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
