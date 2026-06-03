import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePledgeAllocation,
  useUpdatePledgeAllocation,
  useDeletePledgeAllocation,
  useCreateGiftAllocation,
  useUpdateGiftAllocation,
  useDeleteGiftAllocation,
  useListEntities,
  useListFiscalYears,
  useListFundableProjects,
  getGetOpportunityOrPledgeQueryKey,
  getGetGiftOrPaymentQueryKey,
  type PledgeAllocation,
  type GiftAllocation,
  type IntendedUsage,
  type PledgeAllocationStatus,
  type UpdatePledgeAllocationBody,
  type UpdateGiftAllocationBody,
} from "@workspace/api-client-react";
import {
  InlineEditBoolean,
  InlineEditCurrency,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatEnum } from "@/lib/format";

const INTENDED_USAGE_OPTIONS = [
  { value: "gen_ops", label: "Gen ops" },
  { value: "growth", label: "Growth" },
  { value: "school_startup", label: "School startup" },
  { value: "teacher_training", label: "Teacher training" },
  { value: "project", label: "Project" },
] as const satisfies ReadonlyArray<InlineSelectOption<IntendedUsage>>;

const PLEDGE_ALLOCATION_STATUS_OPTIONS = [
  { value: "working", label: "Working" },
  { value: "committed", label: "Committed" },
  { value: "committed_with_conditions", label: "Committed (conditions)" },
  { value: "superseded", label: "Superseded" },
  { value: "superseded_by_pledge", label: "Superseded by pledge" },
  { value: "superseded_by_gift", label: "Superseded by gift" },
  { value: "abandoned", label: "Abandoned" },
] as const satisfies ReadonlyArray<InlineSelectOption<PledgeAllocationStatus>>;

function useEntityOptions(): ReadonlyArray<InlineSelectOption<string>> {
  const { data } = useListEntities();
  return (data ?? []).map((e) => ({ value: e.id, label: e.name }));
}

function useFiscalYearOptions(): ReadonlyArray<InlineSelectOption<string>> {
  const { data } = useListFiscalYears();
  return (data ?? [])
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((fy) => ({ value: fy.id, label: fy.label }));
}

function useFundableProjectOptions(currentId: string | null = null): ReadonlyArray<InlineSelectOption<string>> {
  const { data } = useListFundableProjects();
  const projects = data ?? [];
  const options: InlineSelectOption<string>[] = projects
    .filter((p) => p.active || p.id === currentId)
    .map((p) => ({
      value: p.id,
      label: p.active ? p.name : `${p.name} (retired)`,
    }));
  if (currentId && !options.some((o) => o.value === currentId)) {
    options.push({ value: currentId, label: currentId });
  }
  return options;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-2 text-sm">
      <span className="text-muted-foreground pt-1">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function DialogField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3">
      <Label htmlFor={htmlFor} className="pt-2 text-sm text-muted-foreground text-right">
        {label}
      </Label>
      <div>{children}</div>
    </div>
  );
}

function DialogSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder = "— None —",
}: {
  id?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="h-8 text-sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Dropdown for the allocation's fundable project. Shows active projects plus the
// currently-selected one even if it has since been retired, so an existing
// selection never silently disappears. Clearing it saves null.
function FundableProjectField({
  value,
  testIdBase,
  onSave,
}: {
  value: string | null;
  testIdBase: string;
  onSave: (next: string | null) => unknown;
}) {
  const { data } = useListFundableProjects();
  const projects = data ?? [];
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  const options: InlineSelectOption<string>[] = projects
    .filter((p) => p.active || p.id === value)
    .map((p) => ({
      value: p.id,
      label: p.active ? p.name : `${p.name} (retired)`,
    }));
  // Selected project missing entirely from the list (e.g. deleted) — keep its id
  // visible so the field doesn't blank out.
  if (value && !options.some((o) => o.value === value)) {
    options.push({ value, label: value });
  }

  const display = value ? (nameById.get(value) ?? value) : "—";

  return (
    <Field label="Fundable project">
      <InlineEditSelect
        label="Fundable project"
        testIdBase={`${testIdBase}-project`}
        value={value}
        options={options}
        display={display}
        onSave={onSave}
      />
    </Field>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* New pledge allocation dialog                                             */
/* ──────────────────────────────────────────────────────────────────────── */

function NewPledgeAllocationDialog({
  open,
  onClose,
  pledgeOrOpportunityId,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  pledgeOrOpportunityId: string;
  onCreate: (data: {
    pledgeOrOpportunityId: string;
    subAmount?: string;
    grantYear?: string;
    entityId?: string;
    intendedUsage?: IntendedUsage;
    fundableProjectId?: string;
    directToSchool?: boolean;
    status?: PledgeAllocationStatus;
    conditions?: string;
    notes?: string;
  }) => Promise<void>;
}) {
  const entityOptions = useEntityOptions();
  const fiscalYearOptions = useFiscalYearOptions();
  const fundableProjectOptions = useFundableProjectOptions();

  const [subAmount, setSubAmount] = useState("");
  const [grantYear, setGrantYear] = useState("");
  const [entityId, setEntityId] = useState("");
  const [intendedUsage, setIntendedUsage] = useState("");
  const [fundableProjectId, setFundableProjectId] = useState("");
  const [directToSchool, setDirectToSchool] = useState("");
  const [status, setStatus] = useState("");
  const [conditions, setConditions] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setSubAmount("");
    setGrantYear("");
    setEntityId("");
    setIntendedUsage("");
    setFundableProjectId("");
    setDirectToSchool("");
    setStatus("");
    setConditions("");
    setNotes("");
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const payload: Parameters<typeof onCreate>[0] = {
        pledgeOrOpportunityId,
      };
      const amtNum = Number(subAmount.replace(/[,$\s]/g, ""));
      if (subAmount.trim() && Number.isFinite(amtNum) && amtNum >= 0) {
        payload.subAmount = String(amtNum);
      }
      if (grantYear && grantYear !== "__none__") payload.grantYear = grantYear;
      if (entityId && entityId !== "__none__") payload.entityId = entityId;
      if (intendedUsage && intendedUsage !== "__none__") {
        payload.intendedUsage = intendedUsage as IntendedUsage;
      }
      if (fundableProjectId && fundableProjectId !== "__none__") {
        payload.fundableProjectId = fundableProjectId;
      }
      if (directToSchool !== "") {
        payload.directToSchool = directToSchool === "true";
      }
      if (status && status !== "__none__") {
        payload.status = status as PledgeAllocationStatus;
      }
      if (conditions.trim()) payload.conditions = conditions.trim();
      if (notes.trim()) payload.notes = notes.trim();
      await onCreate(payload);
      reset();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add allocation</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <DialogField label="Amount" htmlFor="pa-amount">
            <Input
              id="pa-amount"
              className="h-8 text-sm"
              value={subAmount}
              onChange={(e) => setSubAmount(e.target.value)}
              placeholder="e.g. 50000"
              inputMode="decimal"
            />
          </DialogField>
          <DialogField label="Entity" htmlFor="pa-entity">
            <DialogSelect
              id="pa-entity"
              value={entityId}
              onValueChange={setEntityId}
              options={entityOptions}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Intended usage" htmlFor="pa-usage">
            <DialogSelect
              id="pa-usage"
              value={intendedUsage}
              onValueChange={setIntendedUsage}
              options={INTENDED_USAGE_OPTIONS}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Grant year" htmlFor="pa-year">
            <DialogSelect
              id="pa-year"
              value={grantYear}
              onValueChange={setGrantYear}
              options={fiscalYearOptions}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Status" htmlFor="pa-status">
            <DialogSelect
              id="pa-status"
              value={status}
              onValueChange={setStatus}
              options={PLEDGE_ALLOCATION_STATUS_OPTIONS}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Direct to school" htmlFor="pa-direct">
            <DialogSelect
              id="pa-direct"
              value={directToSchool}
              onValueChange={setDirectToSchool}
              options={[
                { value: "false", label: "No" },
                { value: "true", label: "Yes" },
              ]}
              placeholder="No"
            />
          </DialogField>
          <DialogField label="Fundable project" htmlFor="pa-project">
            <DialogSelect
              id="pa-project"
              value={fundableProjectId}
              onValueChange={setFundableProjectId}
              options={fundableProjectOptions}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Conditions" htmlFor="pa-conditions">
            <Textarea
              id="pa-conditions"
              className="text-sm min-h-[60px]"
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              placeholder="—"
              rows={2}
            />
          </DialogField>
          <DialogField label="Notes" htmlFor="pa-notes">
            <Textarea
              id="pa-notes"
              className="text-sm min-h-[60px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="—"
              rows={2}
            />
          </DialogField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* New gift allocation dialog                                               */
/* ──────────────────────────────────────────────────────────────────────── */

function NewGiftAllocationDialog({
  open,
  onClose,
  giftId,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  giftId: string;
  onCreate: (data: {
    giftId: string;
    subAmount?: string;
    grantYear?: string;
    entityId?: string;
    intendedUsage?: IntendedUsage;
    fundableProjectId?: string;
    formalRegionalRestriction?: boolean;
    formalFundUseRestriction?: boolean;
    schoolRecipientId?: string;
    spendingStart?: string;
    spendingEnd?: string;
  }) => Promise<void>;
}) {
  const entityOptions = useEntityOptions();
  const fiscalYearOptions = useFiscalYearOptions();
  const fundableProjectOptions = useFundableProjectOptions();

  const [subAmount, setSubAmount] = useState("");
  const [grantYear, setGrantYear] = useState("");
  const [entityId, setEntityId] = useState("");
  const [intendedUsage, setIntendedUsage] = useState("");
  const [fundableProjectId, setFundableProjectId] = useState("");
  const [formalRegionalRestriction, setFormalRegionalRestriction] = useState("");
  const [formalFundUseRestriction, setFormalFundUseRestriction] = useState("");
  const [schoolRecipientId, setSchoolRecipientId] = useState("");
  const [spendingStart, setSpendingStart] = useState("");
  const [spendingEnd, setSpendingEnd] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setSubAmount("");
    setGrantYear("");
    setEntityId("");
    setIntendedUsage("");
    setFundableProjectId("");
    setFormalRegionalRestriction("");
    setFormalFundUseRestriction("");
    setSchoolRecipientId("");
    setSpendingStart("");
    setSpendingEnd("");
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const payload: Parameters<typeof onCreate>[0] = { giftId };
      const amtNum = Number(subAmount.replace(/[,$\s]/g, ""));
      if (subAmount.trim() && Number.isFinite(amtNum) && amtNum >= 0) {
        payload.subAmount = String(amtNum);
      }
      if (grantYear && grantYear !== "__none__") payload.grantYear = grantYear;
      if (entityId && entityId !== "__none__") payload.entityId = entityId;
      if (intendedUsage && intendedUsage !== "__none__") {
        payload.intendedUsage = intendedUsage as IntendedUsage;
      }
      if (fundableProjectId && fundableProjectId !== "__none__") {
        payload.fundableProjectId = fundableProjectId;
      }
      if (formalRegionalRestriction !== "") {
        payload.formalRegionalRestriction = formalRegionalRestriction === "true";
      }
      if (formalFundUseRestriction !== "") {
        payload.formalFundUseRestriction = formalFundUseRestriction === "true";
      }
      if (schoolRecipientId.trim()) payload.schoolRecipientId = schoolRecipientId.trim();
      if (spendingStart.trim()) payload.spendingStart = spendingStart;
      if (spendingEnd.trim()) payload.spendingEnd = spendingEnd;
      await onCreate(payload);
      reset();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add allocation</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <DialogField label="Amount" htmlFor="ga-amount">
            <Input
              id="ga-amount"
              className="h-8 text-sm"
              value={subAmount}
              onChange={(e) => setSubAmount(e.target.value)}
              placeholder="e.g. 50000"
              inputMode="decimal"
            />
          </DialogField>
          <DialogField label="Entity" htmlFor="ga-entity">
            <DialogSelect
              id="ga-entity"
              value={entityId}
              onValueChange={setEntityId}
              options={entityOptions}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Intended usage" htmlFor="ga-usage">
            <DialogSelect
              id="ga-usage"
              value={intendedUsage}
              onValueChange={setIntendedUsage}
              options={INTENDED_USAGE_OPTIONS}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Grant year" htmlFor="ga-year">
            <DialogSelect
              id="ga-year"
              value={grantYear}
              onValueChange={setGrantYear}
              options={fiscalYearOptions}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="School recipient" htmlFor="ga-school">
            <Input
              id="ga-school"
              className="h-8 text-sm"
              value={schoolRecipientId}
              onChange={(e) => setSchoolRecipientId(e.target.value)}
              placeholder="School ID"
            />
          </DialogField>
          <DialogField label="Fundable project" htmlFor="ga-project">
            <DialogSelect
              id="ga-project"
              value={fundableProjectId}
              onValueChange={setFundableProjectId}
              options={fundableProjectOptions}
              placeholder="— None —"
            />
          </DialogField>
          <DialogField label="Regional restriction" htmlFor="ga-region-rest">
            <DialogSelect
              id="ga-region-rest"
              value={formalRegionalRestriction}
              onValueChange={setFormalRegionalRestriction}
              options={[
                { value: "false", label: "No" },
                { value: "true", label: "Yes" },
              ]}
              placeholder="No"
            />
          </DialogField>
          <DialogField label="Use restriction" htmlFor="ga-use-rest">
            <DialogSelect
              id="ga-use-rest"
              value={formalFundUseRestriction}
              onValueChange={setFormalFundUseRestriction}
              options={[
                { value: "false", label: "No" },
                { value: "true", label: "Yes" },
              ]}
              placeholder="No"
            />
          </DialogField>
          <DialogField label="Spending start" htmlFor="ga-start">
            <Input
              id="ga-start"
              type="date"
              className="h-8 text-sm"
              value={spendingStart}
              onChange={(e) => setSpendingStart(e.target.value)}
            />
          </DialogField>
          <DialogField label="Spending end" htmlFor="ga-end">
            <Input
              id="ga-end"
              type="date"
              className="h-8 text-sm"
              value={spendingEnd}
              onChange={(e) => setSpendingEnd(e.target.value)}
            />
          </DialogField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Pledge allocations                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

export function PledgeAllocationsEditor({
  pledgeOrOpportunityId,
  allocations,
}: {
  pledgeOrOpportunityId: string;
  allocations: ReadonlyArray<PledgeAllocation>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const entityOptions = useEntityOptions();
  const entityNameById = new Map(entityOptions.map((o) => [o.value, o.label]));
  const [dialogOpen, setDialogOpen] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetOpportunityOrPledgeQueryKey(pledgeOrOpportunityId),
    });

  const create = useCreatePledgeAllocation({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Allocation added" });
      },
      onError: (e) =>
        toast({
          title: "Add failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  return (
    <div className="space-y-3">
      {allocations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No allocations.</p>
      ) : (
        <ul className="space-y-3">
          {allocations.map((a) => (
            <li
              key={a.id}
              className="rounded-md border bg-card p-3"
              data-testid={`row-opp-alloc-${a.id}`}
            >
              <PledgeAllocationRow
                alloc={a}
                pledgeOrOpportunityId={pledgeOrOpportunityId}
                entityOptions={entityOptions}
                entityNameById={entityNameById}
              />
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDialogOpen(true)}
        data-testid="button-add-opp-alloc"
      >
        <Plus className="h-4 w-4 mr-1" />
        Add allocation
      </Button>
      <NewPledgeAllocationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        pledgeOrOpportunityId={pledgeOrOpportunityId}
        onCreate={async (data) => {
          await create.mutateAsync({ data });
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function PledgeAllocationRow({
  alloc,
  pledgeOrOpportunityId,
  entityOptions,
  entityNameById,
}: {
  alloc: PledgeAllocation;
  pledgeOrOpportunityId: string;
  entityOptions: ReadonlyArray<InlineSelectOption<string>>;
  entityNameById: Map<string, string>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fiscalYearOptions = useFiscalYearOptions();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetOpportunityOrPledgeQueryKey(pledgeOrOpportunityId),
    });

  const update = useUpdatePledgeAllocation({
    mutation: {
      onSuccess: async () => {
        await invalidate();
      },
      onError: (e) =>
        toast({
          title: "Update failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });
  const del = useDeletePledgeAllocation({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Allocation removed" });
      },
      onError: (e) =>
        toast({
          title: "Delete failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });
  const [confirming, setConfirming] = useState(false);

  function patch(body: UpdatePledgeAllocationBody) {
    return update.mutateAsync({ id: alloc.id, data: body });
  }

  const tid = `opp-alloc-${alloc.id}`;
  const entityLabel = alloc.entityId
    ? (entityNameById.get(alloc.entityId) ?? alloc.entityId)
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium truncate">
          {formatCurrency(alloc.subAmount)}
          {entityLabel ? <span className="text-muted-foreground"> • {entityLabel}</span> : null}
        </div>
        {confirming ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={del.isPending}
              onClick={() => del.mutate({ id: alloc.id })}
              data-testid={`button-confirm-delete-${tid}`}
            >
              Delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={del.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            aria-label="Delete allocation"
            onClick={() => setConfirming(true)}
            data-testid={`button-delete-${tid}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Field label="Amount">
        <InlineEditCurrency
          label="Amount"
          testIdBase={`${tid}-amount`}
          value={alloc.subAmount ?? null}
          display={formatCurrency(alloc.subAmount)}
          onSave={(next) => patch({ subAmount: next })}
        />
      </Field>
      <Field label="Entity">
        <InlineEditSelect
          label="Entity"
          testIdBase={`${tid}-entity`}
          value={alloc.entityId ?? null}
          options={entityOptions}
          display={entityLabel ?? "—"}
          onSave={(next) => patch({ entityId: next })}
        />
      </Field>
      <Field label="Intended usage">
        <InlineEditSelect
          label="Intended usage"
          testIdBase={`${tid}-usage`}
          value={alloc.intendedUsage ?? null}
          options={INTENDED_USAGE_OPTIONS}
          display={formatEnum(alloc.intendedUsage) || "—"}
          onSave={(next) => patch({ intendedUsage: next })}
        />
      </Field>
      <Field label="Grant year">
        <InlineEditSelect
          label="Grant year"
          testIdBase={`${tid}-year`}
          value={alloc.grantYear ?? null}
          options={fiscalYearOptions}
          display={alloc.grantYear ?? "—"}
          onSave={(next) => patch({ grantYear: next })}
        />
      </Field>
      <Field label="Status">
        <InlineEditSelect
          label="Status"
          testIdBase={`${tid}-status`}
          value={alloc.status ?? null}
          options={PLEDGE_ALLOCATION_STATUS_OPTIONS}
          display={formatEnum(alloc.status) || "—"}
          onSave={(next) => patch({ status: next })}
        />
      </Field>
      <Field label="Direct to school">
        <InlineEditBoolean
          label="Direct to school"
          testIdBase={`${tid}-direct`}
          value={alloc.directToSchool}
          display={alloc.directToSchool ? "Yes" : "No"}
          onSave={(next) => patch({ directToSchool: next ?? false })}
          allowNull={false}
        />
      </Field>
      <FundableProjectField
        value={alloc.fundableProjectId ?? null}
        testIdBase={tid}
        onSave={(next) => patch({ fundableProjectId: next })}
      />
      <Field label="Conditions">
        <InlineEditText
          label="Conditions"
          testIdBase={`${tid}-conditions`}
          value={alloc.conditions ?? null}
          placeholder="—"
          display={alloc.conditions ?? "—"}
          onSave={(next) => patch({ conditions: next })}
        />
      </Field>
      <Field label="Notes">
        <InlineEditText
          label="Notes"
          testIdBase={`${tid}-notes`}
          value={alloc.notes ?? null}
          placeholder="—"
          display={alloc.notes ?? "—"}
          onSave={(next) => patch({ notes: next })}
        />
      </Field>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Gift allocations                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

export function GiftAllocationsEditor({
  giftId,
  allocations,
}: {
  giftId: string;
  allocations: ReadonlyArray<GiftAllocation>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const entityOptions = useEntityOptions();
  const entityNameById = new Map(entityOptions.map((o) => [o.value, o.label]));
  const [dialogOpen, setDialogOpen] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetGiftOrPaymentQueryKey(giftId),
    });

  const create = useCreateGiftAllocation({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Allocation added" });
      },
      onError: (e) =>
        toast({
          title: "Add failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  return (
    <div className="space-y-3">
      {allocations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No allocations.</p>
      ) : (
        <ul className="space-y-3">
          {allocations.map((a) => (
            <li
              key={a.id}
              className="rounded-md border bg-card p-3"
              data-testid={`row-gift-alloc-${a.id}`}
            >
              <GiftAllocationRow
                alloc={a}
                giftId={giftId}
                entityOptions={entityOptions}
                entityNameById={entityNameById}
              />
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDialogOpen(true)}
        data-testid="button-add-gift-alloc"
      >
        <Plus className="h-4 w-4 mr-1" />
        Add allocation
      </Button>
      <NewGiftAllocationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        giftId={giftId}
        onCreate={async (data) => {
          await create.mutateAsync({ data });
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function GiftAllocationRow({
  alloc,
  giftId,
  entityOptions,
  entityNameById,
}: {
  alloc: GiftAllocation;
  giftId: string;
  entityOptions: ReadonlyArray<InlineSelectOption<string>>;
  entityNameById: Map<string, string>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fiscalYearOptions = useFiscalYearOptions();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetGiftOrPaymentQueryKey(giftId),
    });

  const update = useUpdateGiftAllocation({
    mutation: {
      onSuccess: async () => {
        await invalidate();
      },
      onError: (e) =>
        toast({
          title: "Update failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });
  const del = useDeleteGiftAllocation({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Allocation removed" });
      },
      onError: (e) =>
        toast({
          title: "Delete failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });
  const [confirming, setConfirming] = useState(false);

  function patch(body: UpdateGiftAllocationBody) {
    return update.mutateAsync({ id: alloc.id, data: body });
  }

  const tid = `gift-alloc-${alloc.id}`;
  const entityLabel = alloc.entityId
    ? (entityNameById.get(alloc.entityId) ?? alloc.entityId)
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium truncate">
          {formatCurrency(alloc.subAmount)}
          {alloc.displayUsage ? (
            <span className="text-muted-foreground"> • {alloc.displayUsage}</span>
          ) : entityLabel ? (
            <span className="text-muted-foreground"> • {entityLabel}</span>
          ) : null}
        </div>
        {confirming ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={del.isPending}
              onClick={() => del.mutate({ id: alloc.id })}
              data-testid={`button-confirm-delete-${tid}`}
            >
              Delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={del.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            aria-label="Delete allocation"
            onClick={() => setConfirming(true)}
            data-testid={`button-delete-${tid}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Field label="Amount">
        <InlineEditCurrency
          label="Amount"
          testIdBase={`${tid}-amount`}
          value={alloc.subAmount ?? null}
          display={formatCurrency(alloc.subAmount)}
          onSave={(next) => patch({ subAmount: next })}
        />
      </Field>
      <Field label="Entity">
        <InlineEditSelect
          label="Entity"
          testIdBase={`${tid}-entity`}
          value={alloc.entityId ?? null}
          options={entityOptions}
          display={entityLabel ?? "—"}
          onSave={(next) => patch({ entityId: next })}
        />
      </Field>
      <Field label="Intended usage">
        <InlineEditSelect
          label="Intended usage"
          testIdBase={`${tid}-usage`}
          value={alloc.intendedUsage ?? null}
          options={INTENDED_USAGE_OPTIONS}
          display={formatEnum(alloc.intendedUsage) || "—"}
          onSave={(next) => patch({ intendedUsage: next })}
        />
      </Field>
      <Field label="Grant year">
        <InlineEditSelect
          label="Grant year"
          testIdBase={`${tid}-year`}
          value={alloc.grantYear ?? null}
          options={fiscalYearOptions}
          display={alloc.grantYear ?? "—"}
          onSave={(next) => patch({ grantYear: next })}
        />
      </Field>
      <Field label="School recipient">
        <InlineEditText
          label="School recipient"
          testIdBase={`${tid}-school`}
          value={alloc.schoolRecipientId ?? null}
          placeholder="School ID"
          display={alloc.schoolRecipientId ?? "—"}
          onSave={(next) => patch({ schoolRecipientId: next })}
        />
      </Field>
      <FundableProjectField
        value={alloc.fundableProjectId ?? null}
        testIdBase={tid}
        onSave={(next) => patch({ fundableProjectId: next })}
      />
      <Field label="Regional restriction">
        <InlineEditBoolean
          label="Regional restriction"
          testIdBase={`${tid}-region-rest`}
          value={alloc.formalRegionalRestriction}
          display={alloc.formalRegionalRestriction ? "Yes" : "No"}
          onSave={(next) => patch({ formalRegionalRestriction: next ?? false })}
          allowNull={false}
        />
      </Field>
      <Field label="Use restriction">
        <InlineEditBoolean
          label="Use restriction"
          testIdBase={`${tid}-use-rest`}
          value={alloc.formalFundUseRestriction}
          display={alloc.formalFundUseRestriction ? "Yes" : "No"}
          onSave={(next) => patch({ formalFundUseRestriction: next ?? false })}
          allowNull={false}
        />
      </Field>
      <Field label="Spending start">
        <InlineEditDate
          label="Spending start"
          testIdBase={`${tid}-start`}
          value={alloc.spendingStart ?? null}
          display={alloc.spendingStart ?? "—"}
          onSave={(next) => patch({ spendingStart: next })}
        />
      </Field>
      <Field label="Spending end">
        <InlineEditDate
          label="Spending end"
          testIdBase={`${tid}-end`}
          value={alloc.spendingEnd ?? null}
          display={alloc.spendingEnd ?? "—"}
          onSave={(next) => patch({ spendingEnd: next })}
        />
      </Field>
    </div>
  );
}
