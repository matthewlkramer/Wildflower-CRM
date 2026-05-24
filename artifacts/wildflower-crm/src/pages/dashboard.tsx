import { useMemo, useState } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { Check, ChevronsUpDown, X } from "lucide-react";
import {
  useGetDashboardSummary,
  useListEntities,
  getGetDashboardSummaryQueryKey,
  getListEntitiesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

// URL key for the entity multi-filter. Comma-separated entity ids. Empty/missing
// = all entities. Persisted in the URL so the filtered view is shareable and
// survives reloads / back-forward navigation.
const ENTITIES_QUERY_KEY = "entities";

function parseEntitiesFromSearch(search: string): string[] {
  const raw = new URLSearchParams(search).get(ENTITIES_QUERY_KEY) ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const search = useSearch();
  // Normalize the order so {a,b} and {b,a} share a single query-cache bucket
  // and produce identical canonical URLs.
  const selectedEntityIds = useMemo(() => {
    const ids = parseEntitiesFromSearch(search);
    ids.sort();
    return ids;
  }, [search]);

  // Pass entityIds only when the user has narrowed the filter. Omitting keeps
  // the unfiltered query (and query-cache key) stable.
  const summaryParams = selectedEntityIds.length > 0 ? { entityIds: selectedEntityIds } : undefined;
  const { data, isLoading, isError, error } = useGetDashboardSummary(summaryParams, {
    query: { queryKey: getGetDashboardSummaryQueryKey(summaryParams) },
  });
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });

  const counts = data?.counts;
  const fy = data?.currentFiscalYear;
  const byFy = data?.byFiscalYear ?? [];
  const entityOptions = useMemo(
    () => (entitiesQ.data ?? []).map((e) => ({ id: e.id, name: e.name })),
    [entitiesQ.data],
  );

  const setEntities = (next: string[]) => {
    const sp = new URLSearchParams(search);
    if (next.length === 0) sp.delete(ENTITIES_QUERY_KEY);
    else sp.set(ENTITIES_QUERY_KEY, next.join(","));
    const qs = sp.toString();
    navigate(qs ? `/dashboard?${qs}` : "/dashboard", { replace: true });
  };

  // Forward entity scope to the FY detail page. The detail view has a
  // single-entity dropdown, so we can only forward when exactly one entity is
  // selected. With 0 selected we pass nothing (detail falls back to its
  // Wildflower Foundation default). With 2+ selected we DISABLE the drilldown
  // link entirely — opening the detail page filtered to a different entity
  // than the dashboard would silently mismatch the tile totals and break
  // user trust. Users can narrow to a single entity first to drill in.
  const multiEntityFilterActive = selectedEntityIds.length > 1;
  const forwardedEntityParam =
    selectedEntityIds.length === 1 ? `&entity=${encodeURIComponent(selectedEntityIds[0])}` : "";
  const entityFilterActive = selectedEntityIds.length > 0;

  const countTiles = [
    { label: "People", value: counts?.people, href: "/individuals", testId: "tile-people" },
    { label: "Funding entities", value: counts?.funders, href: "/funding-entities", testId: "tile-funders" },
    { label: "Households", value: counts?.households, href: "/households", testId: "tile-households" },
    { label: "Organizations", value: counts?.organizations, href: "/organizations", testId: "tile-orgs" },
    { label: "Opportunities", value: counts?.opportunities, href: "/opportunities", testId: "tile-opps" },
    { label: "Open opps", value: counts?.openOpportunities, href: "/opportunities", testId: "tile-open-opps" },
    { label: "Won pledges", value: counts?.wonPledges, href: "/pledges", testId: "tile-pledges" },
    { label: "Gifts & payments", value: counts?.gifts, href: "/gifts", testId: "tile-gifts" },
  ];

  // Goal has no drilldown (it's a single seeded number, no rows behind it).
  // The other three tiles all link to the same detail page, with `metric`
  // controlling which table + total is highlighted — same destination, different
  // filter/sum, so users learn one page that backs all the money tiles.
  type MoneyTile = {
    label: string;
    value: string | undefined;
    sub: string;
    testId: string;
    href?: string;
  };
  const moneyTiles: MoneyTile[] = byFy.flatMap((m) => {
    const fySlug = m.fiscalYear.id; // e.g. "fy2026"
    const fyLabel = m.fiscalYear.label;
    // The goal_amount column is org-wide (not per-entity), so when an entity
    // filter is active we make that explicit in the tile subtitle so users
    // don't read it as "WF Foundation's goal" by mistake.
    const goalSub = m.goal
      ? entityFilterActive
        ? `Org-wide fundraising goal for ${fyLabel} (not entity-filtered)`
        : `Fundraising goal for ${fyLabel}`
      : `No goal set for ${fyLabel}`;
    return [
      {
        label: `Goal ${fyLabel}`,
        value: m.goal ?? undefined,
        sub: goalSub,
        testId: `tile-goal-${fySlug}`,
      },
      {
        label: `Received ${fyLabel}`,
        value: m.received,
        sub: multiEntityFilterActive
          ? `Sum across ${selectedEntityIds.length} entities — narrow to one entity to drill in`
          : `Gift allocations booked to ${fyLabel}`,
        testId: `tile-received-${fySlug}`,
        href: multiEntityFilterActive
          ? undefined
          : `/fiscal-year/${fySlug}?metric=received${forwardedEntityParam}`,
      },
      {
        label: `Open asks ${fyLabel}`,
        value: m.openPipelineAsk,
        sub: multiEntityFilterActive
          ? `Sum across ${selectedEntityIds.length} entities — narrow to one entity to drill in`
          : `Open allocations booked to ${fyLabel}`,
        testId: `tile-pipeline-ask-${fySlug}`,
        href: multiEntityFilterActive
          ? undefined
          : `/fiscal-year/${fySlug}?metric=open-asks${forwardedEntityParam}`,
      },
      {
        label: `Weighted asks ${fyLabel}`,
        value: m.openPipelineWeighted,
        sub: multiEntityFilterActive
          ? `Sum across ${selectedEntityIds.length} entities — narrow to one entity to drill in`
          : `${fyLabel} open allocations × win probability`,
        testId: `tile-pipeline-weighted-${fySlug}`,
        href: multiEntityFilterActive
          ? undefined
          : `/fiscal-year/${fySlug}?metric=weighted-asks${forwardedEntityParam}`,
      },
    ];
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            A quick snapshot of the CRM. Fiscal year runs July 1 – June 30; currently{" "}
            <span className="font-medium">{fy?.label ?? "…"}</span>.
          </p>
        </div>
        <EntityMultiFilter
          options={entityOptions}
          value={selectedEntityIds}
          onChange={setEntities}
        />
      </div>

      {isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive" data-testid="dashboard-error">
          {error instanceof Error ? error.message : "Failed to load dashboard summary."}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {moneyTiles.map((t) => {
          const card = (
            <Card
              data-testid={t.testId}
              className={t.href ? "cursor-pointer hover:bg-muted/30 transition-colors h-full" : "h-full"}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-serif font-bold text-foreground">
                  {isLoading || t.value === undefined ? "…" : formatCurrency(t.value)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{t.sub}</p>
              </CardContent>
            </Card>
          );
          return t.href ? (
            <Link key={t.label} href={t.href}>{card}</Link>
          ) : (
            <div key={t.label}>{card}</div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {countTiles.map((t) => (
          <Link key={t.label} href={t.href} data-testid={t.testId}>
            <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-serif font-bold text-foreground">
                  {t.value === undefined ? "…" : t.value.toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/projections">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Projections</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Open-pipeline allocations by fiscal year and fund entity.
            </CardContent>
          </Card>
        </Link>
        <Link href="/grants-calendar">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Grants calendar</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Upcoming application deadlines and projected close dates.
            </CardContent>
          </Card>
        </Link>
        <Link href="/moves">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Moves</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              People who haven't been contacted recently.
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}

// Multi-select entity filter for the money tiles. Renders a popover with
// checkbox-style options and a chip strip showing the active selection. An
// empty selection means "all entities" (no filter applied).
function EntityMultiFilter({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ id: string; name: string }>;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(value);
  const labelFor = (id: string) => options.find((o) => o.id === id)?.name ?? id;
  const triggerLabel =
    value.length === 0
      ? "All entities"
      : value.length === 1
        ? labelFor(value[0])
        : `${value.length} entities`;

  const toggle = (id: string) => {
    onChange(
      selectedSet.has(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };
  const clear = () => onChange([]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            size="sm"
            className="h-8 min-w-[12rem] justify-between font-normal"
            data-testid="filter-entities"
          >
            <span className="truncate">
              <span className="text-muted-foreground mr-1">Entities:</span>
              {triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[--radix-popover-trigger-width] min-w-[16rem]" align="end">
          <Command>
            <CommandList>
              <CommandGroup>
                {options.map((o) => {
                  const selected = selectedSet.has(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      value={o.id}
                      onSelect={() => toggle(o.id)}
                      data-testid={`filter-entities-option-${o.id}`}
                    >
                      <Check className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{o.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {value.length > 0 ? (
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    onSelect={clear}
                    data-testid="filter-entities-clear"
                    className="text-muted-foreground"
                  >
                    <X className="mr-2 h-4 w-4" />
                    Clear filter (all entities)
                  </CommandItem>
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1 justify-end max-w-[24rem]">
          {value.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 pr-1"
              data-testid={`filter-entities-chip-${id}`}
            >
              {labelFor(id)}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label={`Remove ${labelFor(id)}`}
                className="rounded hover:bg-muted-foreground/10"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
