import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListOpportunitiesAndPledges,
  useUpdateOpportunityOrPledge,
  getListOpportunitiesAndPledgesQueryKey,
  getGetOpportunityOrPledgeQueryKey,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityOrPledge,
  type OpportunityStage,
  type OpportunityType,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort, formatEnum, fiscalYearFromDate } from "@/lib/format";
import { DonorCell } from "@/components/donor-cell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";

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

const PAGE_LIMIT = 500;

export default function Pipeline() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [types, setTypes] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const params: ListOpportunitiesAndPledgesParams = {
    limit: PAGE_LIMIT,
    page: 1,
    status: ["open"],
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(types.length > 0 ? { type: [...types].sort() as OpportunityType[] } : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
  };

  const queryKey = getListOpportunitiesAndPledgesQueryKey(params);
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(params, {
    query: { queryKey },
  });

  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onError: (err: unknown) => {
        toast({
          title: "Couldn't move opportunity",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
        queryClient.invalidateQueries({ queryKey });
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const truncated = total > rows.length;

  const byStage = useMemo(() => {
    const map = new Map<OpportunityStage, OpportunityOrPledge[]>();
    for (const s of STAGES) map.set(s, []);
    for (const r of rows) {
      if (!r.stage) continue;
      const list = map.get(r.stage as OpportunityStage);
      if (list) list.push(r);
    }
    return map;
  }, [rows]);

  const activeOpp = activeId ? rows.find((r) => r.id === activeId) ?? null : null;
  const userNames = useUserNameMap();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const oppId = String(e.active.id);
    const nextStage = e.over?.id ? (String(e.over.id) as OpportunityStage) : null;
    if (!nextStage || !STAGES.includes(nextStage)) return;
    const moved = rows.find((r) => r.id === oppId);
    if (!moved || moved.stage === nextStage) return;

    queryClient.setQueryData<typeof data>(queryKey, (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        data: prev.data.map((r) =>
          r.id === oppId ? { ...r, stage: nextStage } : r,
        ),
      };
    });
    queryClient.invalidateQueries({
      queryKey: getGetOpportunityOrPledgeQueryKey(oppId),
    });

    update.mutate({ id: oppId, data: { stage: nextStage } });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? "Loading…"
            : `${total.toLocaleString()} open ${total === 1 ? "opportunity" : "opportunities"}`}
          {truncated && ` — showing first ${rows.length.toLocaleString()}`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px] max-w-md">
          <Input
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search opportunities by name"
            data-testid="input-search-pipeline"
          />
        </div>
        <MultiFilterSelect
          label="Type"
          selected={types}
          onChange={setTypes}
          options={TYPES}
          testId="select-pipeline-type"
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={setOwners}
          testId="select-pipeline-owner"
        />
        {(search || types.length > 0 || owners.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setTypes([]);
              setOwners([]);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {isError ? (
        <div className="rounded-md border bg-card p-8 text-center text-destructive">
          {error instanceof Error ? error.message : "Failed to load opportunities."}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="flex gap-3 overflow-x-auto pb-3">
            {STAGES.map((stage) => (
              <StageColumn
                key={stage}
                stage={stage}
                opps={byStage.get(stage) ?? []}
                loading={isLoading}
                draggingId={activeId}
                userNames={userNames}
              />
            ))}
          </div>
          <DragOverlay>
            {activeOpp ? <OppCard opp={activeOpp} userNames={userNames} isOverlay /> : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function StageColumn({
  stage,
  opps,
  loading,
  draggingId,
  userNames,
}: {
  stage: OpportunityStage;
  opps: OpportunityOrPledge[];
  loading: boolean;
  draggingId: string | null;
  userNames: Map<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const totalAsk = opps.reduce((sum, o) => sum + Number(o.askAmount ?? 0), 0);

  return (
    <div
      ref={setNodeRef}
      className={`flex w-[280px] shrink-0 flex-col rounded-md border bg-muted/30 transition-colors ${
        isOver ? "border-primary bg-primary/5" : ""
      }`}
      data-testid={`column-stage-${stage}`}
    >
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{formatEnum(stage)}</h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {opps.length}
          </span>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {totalAsk > 0 ? formatCurrency(totalAsk) : "—"}
        </div>
      </div>
      <div className="flex-1 space-y-2 p-2 min-h-[120px]">
        {loading ? (
          <div className="text-xs text-muted-foreground text-center py-6">Loading…</div>
        ) : opps.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-6">No opportunities</div>
        ) : (
          opps.map((o) => (
            <OppCard key={o.id} opp={o} userNames={userNames} hidden={draggingId === o.id} />
          ))
        )}
      </div>
    </div>
  );
}

function OppCard({
  opp,
  userNames,
  hidden = false,
  isOverlay = false,
}: {
  opp: OpportunityOrPledge;
  userNames: Map<string, string>;
  hidden?: boolean;
  isOverlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: opp.id,
    disabled: isOverlay,
  });
  const fy = opp.fiscalYear ?? fiscalYearFromDate(opp.projectedCloseDate);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-2.5 text-sm shadow-sm transition-shadow hover:shadow-md ${
        hidden || isDragging ? "opacity-30" : ""
      } ${isOverlay ? "cursor-grabbing shadow-lg" : "cursor-grab"}`}
      data-testid={`card-opp-${opp.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/opportunities/${opp.id}`}
          className="font-medium text-foreground hover:text-primary line-clamp-2"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {opp.name ?? `Untitled ${opp.id}`}
        </Link>
        {fy && (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums uppercase">
            {fy}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        <DonorCell
          funderId={opp.funderId}
          funderName={opp.funderName}
          funderIsPriority={opp.funderIsPriority}
          householdId={opp.householdId}
          householdName={opp.householdName}
          individualGiverPersonId={opp.individualGiverPersonId}
          individualGiverPersonName={opp.individualGiverPersonName}
          individualGiverPersonIsPriority={opp.individualGiverPersonIsPriority}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="font-medium tabular-nums text-foreground">
          {formatCurrency(opp.askAmount)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {formatDateShort(opp.projectedCloseDate)}
        </span>
      </div>
      {opp.ownerUserId && (
        <div className="mt-1 text-[11px] text-muted-foreground truncate">
          {userNames.get(opp.ownerUserId) ?? opp.ownerUserId}
        </div>
      )}
    </div>
  );
}
