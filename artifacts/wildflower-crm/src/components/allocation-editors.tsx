import { useState } from "react";
import { Plus, Trash2, ChevronDown, Lock } from "lucide-react";
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
  useListSchools,
  getGetOpportunityOrPledgeQueryKey,
  getGetGiftOrPaymentQueryKey,
  type PledgeAllocation,
  type GiftAllocation,
  type IntendedUsage,
  type PledgeAllocationStatus,
  type ReimbursementType,
  type RestrictionAxis,
  type OpportunityConditional,
  type OpportunityConditionsMet,
  type CreatePledgeAllocationBody,
  type UpdatePledgeAllocationBody,
  type CreateGiftAllocationBody,
  type UpdateGiftAllocationBody,
} from "@workspace/api-client-react";
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { RegionMultiCombobox } from "@/components/region-multi-combobox";
import { useRegionNameMap } from "@/components/region-picker";
import { formatCurrency, formatEnum } from "@/lib/format";

/* ──────────────────────────────────────────────────────────────────────── */
/* Shared options + helpers                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

type Option = { value: string; label: string };

const INTENDED_USAGE_OPTIONS: ReadonlyArray<Option> = [
  { value: "gen_ops", label: "Gen ops" },
  { value: "growth", label: "Growth" },
  { value: "school_startup", label: "School startup" },
  { value: "teacher_training", label: "Teacher training" },
  { value: "project", label: "Project" },
];

// The superseded family (superseded / superseded_by_pledge / superseded_by_gift)
// is retired (Task #665) — users keep pledge allocations accurate directly.
const PLEDGE_ALLOCATION_STATUS_OPTIONS: ReadonlyArray<Option> = [
  { value: "working", label: "Working" },
  { value: "committed", label: "Committed" },
  { value: "committed_with_conditions", label: "Committed (conditions)" },
  { value: "abandoned", label: "Abandoned" },
];

// Per-axis restriction taxonomy (Task #449). Applied independently to the
// regional / fund-use / time axes. donor_restricted = the funder imposed it (a
// true GAAP restriction); wf_restricted = Wildflower board-designated (NOT a GAAP
// restriction — counts as unrestricted for restriction rollups); unrestricted.
const RESTRICTION_AXIS_OPTIONS: ReadonlyArray<Option> = [
  { value: "unrestricted", label: "Unrestricted" },
  { value: "donor_restricted", label: "Donor-restricted" },
  { value: "wf_restricted", label: "WF board-designated" },
];

const RESTRICTION_AXIS_HINT =
  "Set each axis independently. Donor-restricted means the funder formally imposed it (a true restriction); WF board-designated is an internal designation that still counts as unrestricted for accounting.";

// Per-allocation grant condition + whether the conditions have been met.
const CONDITIONAL_OPTIONS: ReadonlyArray<Option> = [
  { value: "unconditional", label: "Unconditional" },
  { value: "conditional_unspecified", label: "Conditional (unspecified)" },
  { value: "reimbursable", label: "Reimbursable" },
  { value: "conditional_on_funder_determination", label: "Conditional on funder determination" },
  { value: "conditional_on_target", label: "Conditional on target / match" },
];

const CONDITIONS_MET_OPTIONS: ReadonlyArray<Option> = [
  { value: "no", label: "No" },
  { value: "partial", label: "Partial" },
  { value: "yes", label: "Yes" },
];

// Direct vs indirect share on a reimbursable grant. DIRECT-tagged allocations are
// EXCLUDED from goal analytics (received, committed, open ask, weighted); the
// full award/reimbursement amount is still recorded on the line. Untagged (the
// default) and indirect both still count toward goals.
const REIMBURSEMENT_TYPE_OPTIONS: ReadonlyArray<Option> = [
  { value: "direct", label: "Direct (excluded from goals)" },
  { value: "indirect", label: "Indirect (counts toward goals)" },
];

const REIMBURSEMENT_TYPE_HINT =
  "Tag the direct vs indirect share on a reimbursable grant. The full amount is still recorded; only DIRECT-tagged shares are excluded from goal totals.";

const NONE = "__none__";

function useEntityOptions(): ReadonlyArray<Option> {
  const { data } = useListEntities();
  return (data ?? []).map((e) => ({ value: e.id, label: e.name }));
}

function useFiscalYearOptions(): ReadonlyArray<Option> {
  const { data } = useListFiscalYears();
  return (data ?? [])
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((fy) => ({ value: fy.id, label: fy.label }));
}

// Active fundable projects, plus the currently-selected one even if retired so an
// existing selection never silently disappears.
function useFundableProjectOptions(currentId: string | null = null): ReadonlyArray<Option> {
  const { data } = useListFundableProjects();
  const projects = data ?? [];
  const options: Option[] = projects
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

function useFundableProjectNameMap(): Map<string, string> {
  const { data } = useListFundableProjects();
  return new Map((data ?? []).map((p) => [p.id, p.name]));
}

function useSchoolNameMap(): Map<string, string> {
  const { data } = useListSchools({ limit: 10000 });
  return new Map((data?.data ?? []).map((s) => [s.id, s.shortName || s.name]));
}

// Negative amounts are never valid for an allocation (or a parent total), so they
// parse to null and are omitted/cleared rather than persisted.
function parseAmount(s: string | null | undefined): number | null {
  if (s == null) return null;
  const trimmed = String(s).replace(/[,$\s]/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Percent of the parent total, or "—" when the total is missing / non-positive.
function pctLabel(part: number, total: number | null): string {
  if (total == null || !(total > 0)) return "—";
  return `${Math.round((part / total) * 1000) / 10}%`;
}

function noneToNull(v: string): string | null {
  return v && v !== NONE ? v : null;
}

function emptyToNull(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Dialog field primitives                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

function DialogField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3">
      <Label htmlFor={htmlFor} className="pt-2 text-sm text-muted-foreground text-right">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
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
  options: ReadonlyArray<Option>;
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="h-8 text-sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CheckboxField({
  id,
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5"
        data-testid={`checkbox-${id}`}
      />
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-normal leading-snug">
          {label}
        </Label>
        {hint ? <p className="text-xs text-muted-foreground leading-snug">{hint}</p> : null}
      </div>
    </div>
  );
}

function MoreDetails({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-1 text-muted-foreground"
          data-testid="button-more-details"
        >
          <ChevronDown
            className={`h-4 w-4 mr-1 transition-transform ${open ? "rotate-180" : ""}`}
          />
          More details
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Restriction axes (regional / fund-use / time)                             */
/* ──────────────────────────────────────────────────────────────────────── */

// The restriction slice of an allocation form. Shared by pledge + gift dialogs
// since the three axes + verbatim purpose are identical on both. Revenue-coding
// capture moved off allocations onto staged_payments in Task #449.
type RestrictionAxisState = {
  regionalRestrictionType: string;
  usageRestrictionType: string;
  timeRestrictionType: string;
  purposeVerbatim: string;
};

function restrictionAxisStateFrom(
  a: Pick<
    PledgeAllocation | GiftAllocation,
    | "regionalRestrictionType"
    | "usageRestrictionType"
    | "timeRestrictionType"
    | "purposeVerbatim"
  > | null,
): RestrictionAxisState {
  return {
    regionalRestrictionType: a?.regionalRestrictionType ?? "unrestricted",
    usageRestrictionType: a?.usageRestrictionType ?? "unrestricted",
    timeRestrictionType: a?.timeRestrictionType ?? "unrestricted",
    purposeVerbatim: a?.purposeVerbatim ?? "",
  };
}

// The three axes are required (non-null, default unrestricted) on both create +
// update bodies, so they are always sent.
type RestrictionAxisBody = {
  regionalRestrictionType: RestrictionAxis;
  usageRestrictionType: RestrictionAxis;
  timeRestrictionType: RestrictionAxis;
};

function restrictionAxisBody(s: RestrictionAxisState): RestrictionAxisBody {
  return {
    regionalRestrictionType: s.regionalRestrictionType as RestrictionAxis,
    usageRestrictionType: s.usageRestrictionType as RestrictionAxis,
    timeRestrictionType: s.timeRestrictionType as RestrictionAxis,
  };
}

// A required-value select (no "None" item) for a restriction axis.
function AxisSelect({
  id,
  value,
  onValueChange,
}: {
  id?: string;
  value: string;
  onValueChange: (v: string) => void;
}) {
  return (
    <Select value={value || "unrestricted"} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="h-8 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {RESTRICTION_AXIS_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// The restriction section rendered inside each allocation dialog's "More
// details": three per-axis dropdowns + the donor's verbatim purpose.
function RestrictionAxisFields({
  s,
  setAxis,
}: {
  s: RestrictionAxisState;
  setAxis: (k: keyof RestrictionAxisState, v: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-muted-foreground">Restriction</p>
      <p className="text-xs text-muted-foreground">{RESTRICTION_AXIS_HINT}</p>
      <DialogField label="Regional" htmlFor="ra-regional">
        <AxisSelect
          id="ra-regional"
          value={s.regionalRestrictionType}
          onValueChange={(v) => setAxis("regionalRestrictionType", v)}
        />
      </DialogField>
      <DialogField label="Fund use" htmlFor="ra-usage">
        <AxisSelect
          id="ra-usage"
          value={s.usageRestrictionType}
          onValueChange={(v) => setAxis("usageRestrictionType", v)}
        />
      </DialogField>
      <DialogField label="Time" htmlFor="ra-time">
        <AxisSelect
          id="ra-time"
          value={s.timeRestrictionType}
          onValueChange={(v) => setAxis("timeRestrictionType", v)}
        />
      </DialogField>
      <DialogField label="Purpose (verbatim)" htmlFor="ra-purpose">
        <Textarea
          id="ra-purpose"
          className="text-sm min-h-[48px]"
          value={s.purposeVerbatim}
          onChange={(e) => setAxis("purposeVerbatim", e.target.value)}
          placeholder="Donor's stated purpose, copied verbatim"
          rows={2}
        />
      </DialogField>
    </div>
  );
}

// Restriction badges for a list row: one badge per donor-restricted axis (a true
// GAAP restriction). WF board-designated + unrestricted show no badge. "Intent"
// when no axis is donor-restricted.
function RestrictionBadges({
  a,
}: {
  a: Pick<
    PledgeAllocation | GiftAllocation,
    "regionalRestrictionType" | "usageRestrictionType" | "timeRestrictionType"
  >;
}) {
  const labels: string[] = [];
  if (a.usageRestrictionType === "donor_restricted") labels.push("Use");
  if (a.regionalRestrictionType === "donor_restricted") labels.push("Region");
  if (a.timeRestrictionType === "donor_restricted") labels.push("Time");
  if (!labels.length) return <span className="text-muted-foreground">Intent</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <Badge key={label} variant="secondary" className="gap-1 whitespace-nowrap">
          <Lock className="h-3 w-3" />
          {label}
        </Badge>
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Table shell                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

function AllocationTable({
  headers,
  children,
  allocated,
  total,
}: {
  headers: ReadonlyArray<{ key: string; label: string; align?: "right" }>;
  children: React.ReactNode;
  allocated: number;
  total: number | null;
  /** number of leading numeric columns (amount, %) — footer aligns to them */
}) {
  const remaining = total == null ? null : Math.round((total - allocated) * 100) / 100;
  return (
    <div className="overflow-x-auto">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            {headers.map((h) => (
              <TableHead
                key={h.key}
                className={`h-8 ${h.align === "right" ? "text-right" : ""}`}
              >
                {h.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-right font-medium">
              {formatCurrency(allocated)}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {total != null ? pctLabel(allocated, total) : "—"}
            </TableCell>
            <TableCell colSpan={headers.length - 2} className="text-muted-foreground">
              {total == null
                ? "Total allocated"
                : remaining === 0
                  ? "Fully allocated"
                  : remaining! > 0
                    ? `${formatCurrency(remaining)} of ${formatCurrency(total)} unallocated`
                    : `Over-allocated by ${formatCurrency(Math.abs(remaining!))}`}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

const PLEDGE_HEADERS = [
  { key: "amount", label: "Amount", align: "right" as const },
  { key: "pct", label: "%", align: "right" as const },
  { key: "fund", label: "Fund" },
  { key: "usage", label: "Usage" },
  { key: "fy", label: "FY" },
  { key: "expected", label: "Expected" },
  { key: "regions", label: "Regions" },
  { key: "share", label: "Share" },
  { key: "restriction", label: "Restriction" },
];

const GIFT_HEADERS = [
  { key: "amount", label: "Amount", align: "right" as const },
  { key: "pct", label: "%", align: "right" as const },
  { key: "fund", label: "Fund" },
  { key: "usage", label: "Usage" },
  { key: "fy", label: "FY" },
  { key: "regions", label: "Regions" },
  { key: "share", label: "Share" },
  { key: "restriction", label: "Restriction" },
];

// Small badge for a direct/indirect reimbursement-type tag, or an em-dash when
// untagged. Direct is the visually distinct one since it's excluded from goals.
function ReimbursementTypeCell({ value }: { value: string | null | undefined }) {
  if (value === "direct") {
    return (
      <Badge variant="outline" className="whitespace-nowrap border-amber-500 text-amber-700">
        Direct
      </Badge>
    );
  }
  if (value === "indirect") {
    return (
      <Badge variant="outline" className="whitespace-nowrap">
        Indirect
      </Badge>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

// Sum of subAmounts on direct-tagged allocations — the portion excluded from
// goal analytics. Returns null when nothing is direct-tagged.
function directExcludedTotal(
  allocations: ReadonlyArray<{ reimbursementType?: string | null; subAmount?: string | null }>,
): number | null {
  let sum = 0;
  let any = false;
  for (const a of allocations) {
    if (a.reimbursementType === "direct") {
      any = true;
      sum += parseAmount(a.subAmount ?? null) ?? 0;
    }
  }
  return any ? sum : null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Pledge allocation dialog (add + edit)                                     */
/* ──────────────────────────────────────────────────────────────────────── */

type PledgeFormState = RestrictionAxisState & {
  subAmount: string;
  entityId: string;
  intendedUsage: string;
  grantYear: string;
  expectedPaymentDate: string;
  regionIds: string[];
  reimbursementType: string;
  conditional: string;
  conditionsMet: string;
  status: string;
  fundableProjectId: string;
  directToSchool: boolean;
  schoolRecipientId: string;
  contingent: boolean;
  conditions: string;
  notes: string;
};

function pledgeStateFrom(a: PledgeAllocation | null): PledgeFormState {
  return {
    ...restrictionAxisStateFrom(a),
    subAmount: a?.subAmount ?? "",
    entityId: a?.entityId ?? "",
    intendedUsage: a?.intendedUsage ?? "",
    grantYear: a?.grantYear ?? "",
    expectedPaymentDate: a?.expectedPaymentDate ?? "",
    regionIds: a?.regionIds ?? [],
    reimbursementType: a?.reimbursementType ?? "",
    conditional: a?.conditional ?? "",
    conditionsMet: a?.conditionsMet ?? "no",
    status: a?.status ?? "",
    fundableProjectId: a?.fundableProjectId ?? "",
    directToSchool: a?.directToSchool ?? false,
    schoolRecipientId: a?.schoolRecipientId ?? "",
    contingent: a?.contingent ?? false,
    conditions: a?.conditions ?? "",
    notes: a?.notes ?? "",
  };
}

function PledgeAllocationDialog({
  open,
  mode,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: {
  open: boolean;
  mode: "add" | "edit";
  initial: PledgeAllocation | null;
  onClose: () => void;
  onSubmit: (body: CreatePledgeAllocationBody | UpdatePledgeAllocationBody) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const entityOptions = useEntityOptions();
  const fiscalYearOptions = useFiscalYearOptions();
  const fundableProjectOptions = useFundableProjectOptions(initial?.fundableProjectId ?? null);
  const [s, setS] = useState<PledgeFormState>(() => pledgeStateFrom(initial));
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Reset form whenever the dialog opens for a different row / mode.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedKey = `${mode}:${initial?.id ?? "new"}`;
  if (open && seededFor !== seedKey) {
    setS(pledgeStateFrom(initial));
    setConfirmingDelete(false);
    setSeededFor(seedKey);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  const set = <K extends keyof PledgeFormState>(k: K, v: PledgeFormState[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  function buildBody(): CreatePledgeAllocationBody | UpdatePledgeAllocationBody {
    const amount = parseAmount(s.subAmount);
    const axes = restrictionAxisBody(s);
    if (mode === "edit") {
      const body: UpdatePledgeAllocationBody = {
        subAmount: amount == null ? null : String(amount),
        entityId: noneToNull(s.entityId),
        intendedUsage: (noneToNull(s.intendedUsage) as IntendedUsage | null) ?? null,
        grantYear: noneToNull(s.grantYear),
        expectedPaymentDate: emptyToNull(s.expectedPaymentDate),
        regionIds: s.regionIds,
        ...axes,
        reimbursementType: (noneToNull(s.reimbursementType) as ReimbursementType | null) ?? null,
        conditional: (noneToNull(s.conditional) as OpportunityConditional | null) ?? null,
        conditionsMet: s.conditionsMet as OpportunityConditionsMet,
        status: (noneToNull(s.status) as PledgeAllocationStatus | null) ?? null,
        fundableProjectId: noneToNull(s.fundableProjectId),
        directToSchool: s.directToSchool,
        schoolRecipientId: emptyToNull(s.schoolRecipientId),
        contingent: s.contingent,
        conditions: emptyToNull(s.conditions),
        notes: emptyToNull(s.notes),
        purposeVerbatim: emptyToNull(s.purposeVerbatim),
      };
      return body;
    }
    const body: CreatePledgeAllocationBody = {
      ...axes,
      conditionsMet: s.conditionsMet as OpportunityConditionsMet,
      directToSchool: s.directToSchool,
      contingent: s.contingent,
    };
    if (amount != null) body.subAmount = String(amount);
    if (noneToNull(s.entityId)) body.entityId = s.entityId;
    if (noneToNull(s.intendedUsage)) body.intendedUsage = s.intendedUsage as IntendedUsage;
    if (noneToNull(s.grantYear)) body.grantYear = s.grantYear;
    if (emptyToNull(s.expectedPaymentDate)) body.expectedPaymentDate = s.expectedPaymentDate;
    if (s.regionIds.length) body.regionIds = s.regionIds;
    if (noneToNull(s.reimbursementType)) body.reimbursementType = s.reimbursementType as ReimbursementType;
    if (noneToNull(s.conditional)) body.conditional = s.conditional as OpportunityConditional;
    if (noneToNull(s.status)) body.status = s.status as PledgeAllocationStatus;
    if (noneToNull(s.fundableProjectId)) body.fundableProjectId = s.fundableProjectId;
    if (emptyToNull(s.schoolRecipientId)) body.schoolRecipientId = s.schoolRecipientId.trim();
    if (emptyToNull(s.conditions)) body.conditions = s.conditions.trim();
    if (emptyToNull(s.notes)) body.notes = s.notes.trim();
    if (emptyToNull(s.purposeVerbatim)) body.purposeVerbatim = s.purposeVerbatim.trim();
    return body;
  }

  const setAxis = (k: keyof RestrictionAxisState, v: string) =>
    setS((prev) => ({ ...prev, [k]: v }));

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit(buildBody());
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete || saving) return;
    setSaving(true);
    try {
      await onDelete();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add allocation" : "Edit allocation"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <DialogField label="Amount" htmlFor="pa-amount">
            <Input
              id="pa-amount"
              className="h-8 text-sm"
              value={s.subAmount}
              onChange={(e) => set("subAmount", e.target.value)}
              placeholder="e.g. 50000"
              inputMode="decimal"
            />
          </DialogField>
          <DialogField label="Fund / Entity" htmlFor="pa-entity">
            <DialogSelect
              id="pa-entity"
              value={s.entityId || NONE}
              onValueChange={(v) => set("entityId", v)}
              options={entityOptions}
            />
          </DialogField>
          <DialogField label="Usage" htmlFor="pa-usage">
            <DialogSelect
              id="pa-usage"
              value={s.intendedUsage || NONE}
              onValueChange={(v) => set("intendedUsage", v)}
              options={INTENDED_USAGE_OPTIONS}
            />
          </DialogField>
          <DialogField label="Grant year" htmlFor="pa-year">
            <DialogSelect
              id="pa-year"
              value={s.grantYear || NONE}
              onValueChange={(v) => set("grantYear", v)}
              options={fiscalYearOptions}
            />
          </DialogField>
          <DialogField label="Expected payment" htmlFor="pa-expected">
            <Input
              id="pa-expected"
              type="date"
              className="h-8 text-sm"
              value={s.expectedPaymentDate}
              onChange={(e) => set("expectedPaymentDate", e.target.value)}
              data-testid="input-pa-expected-date"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              When this payment is expected. Allocations sharing a date roll up into one expected payment.
            </p>
          </DialogField>
          <DialogField label="Regions" htmlFor="pa-regions">
            <RegionMultiCombobox
              testId="pa-regions"
              value={s.regionIds}
              onChange={(v) => set("regionIds", v)}
            />
          </DialogField>

          <DialogField label="Conditional" htmlFor="pa-conditional">
            <DialogSelect
              id="pa-conditional"
              value={s.conditional || NONE}
              onValueChange={(v) => set("conditional", v)}
              options={CONDITIONAL_OPTIONS}
            />
          </DialogField>

          <DialogField label="Conditions met" htmlFor="pa-conditions-met">
            <Select
              value={s.conditionsMet || "no"}
              onValueChange={(v) => set("conditionsMet", v)}
            >
              <SelectTrigger id="pa-conditions-met" className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {CONDITIONS_MET_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DialogField>

          <DialogField label="Reimbursement type" htmlFor="pa-reimb">
            <DialogSelect
              id="pa-reimb"
              value={s.reimbursementType || NONE}
              onValueChange={(v) => set("reimbursementType", v)}
              options={REIMBURSEMENT_TYPE_OPTIONS}
            />
            <p className="mt-1 text-xs text-muted-foreground">{REIMBURSEMENT_TYPE_HINT}</p>
          </DialogField>

          <MoreDetails>
            <RestrictionAxisFields s={s} setAxis={setAxis} />
            <DialogField label="Status" htmlFor="pa-status">
              <DialogSelect
                id="pa-status"
                value={s.status || NONE}
                onValueChange={(v) => set("status", v)}
                options={PLEDGE_ALLOCATION_STATUS_OPTIONS}
              />
            </DialogField>
            <DialogField label="Fundable project" htmlFor="pa-project">
              <DialogSelect
                id="pa-project"
                value={s.fundableProjectId || NONE}
                onValueChange={(v) => set("fundableProjectId", v)}
                options={fundableProjectOptions}
              />
            </DialogField>
            <DialogField label="Direct to school">
              <CheckboxField
                id="pa-direct"
                checked={s.directToSchool}
                onCheckedChange={(v) =>
                  setS((prev) => ({
                    ...prev,
                    directToSchool: v,
                    schoolRecipientId: v ? prev.schoolRecipientId : "",
                  }))
                }
                label="Funds flow directly to a school"
              />
            </DialogField>
            <DialogField label="School recipient" htmlFor="pa-school">
              <Input
                id="pa-school"
                className="h-8 text-sm"
                value={s.schoolRecipientId}
                onChange={(e) => {
                  const v = e.target.value;
                  setS((prev) => ({
                    ...prev,
                    schoolRecipientId: v,
                    directToSchool: v.trim() ? true : prev.directToSchool,
                  }));
                }}
                placeholder="School ID"
              />
            </DialogField>
            <DialogField label="Payment type">
              <CheckboxField
                id="pa-contingent"
                checked={s.contingent}
                onCheckedChange={(v) => set("contingent", v)}
                label="Contingent (not a scheduled payment)"
                hint="Leave unchecked for a scheduled future payment; check when the payment depends on an unmet condition."
              />
            </DialogField>
            <DialogField label="Conditions" htmlFor="pa-conditions">
              <Textarea
                id="pa-conditions"
                className="text-sm min-h-[60px]"
                value={s.conditions}
                onChange={(e) => set("conditions", e.target.value)}
                placeholder="—"
                rows={2}
              />
            </DialogField>
            <DialogField label="Notes" htmlFor="pa-notes">
              <Textarea
                id="pa-notes"
                className="text-sm min-h-[60px]"
                value={s.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="—"
                rows={2}
              />
            </DialogField>
          </MoreDetails>
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {mode === "edit" && onDelete ? (
              confirmingDelete ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={saving}
                    onClick={handleDelete}
                    data-testid="button-confirm-delete-alloc"
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                  data-testid="button-delete-alloc"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving} data-testid="button-save-alloc">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Pledge allocations editor                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

type PledgeDialogState =
  | { mode: "add" }
  | { mode: "edit"; alloc: PledgeAllocation }
  | null;

export function PledgeAllocationsEditor({
  pledgeOrOpportunityId,
  allocations,
  totalAmount = null,
  reimbursablePrompt = false,
}: {
  pledgeOrOpportunityId: string;
  allocations: ReadonlyArray<PledgeAllocation>;
  totalAmount?: number | string | null;
  // True when the parent opportunity is `conditional = reimbursable`. Surfaces a
  // prompt to split each line into its direct vs indirect share so goal totals
  // exclude the direct portion.
  reimbursablePrompt?: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const entityOptions = useEntityOptions();
  const entityNameById = new Map(entityOptions.map((o) => [o.value, o.label]));
  const projectNameById = useFundableProjectNameMap();
  const schoolNameById = useSchoolNameMap();
  const regionNames = useRegionNameMap();
  const [dialog, setDialog] = useState<PledgeDialogState>(null);

  const rawTotal = parseAmount(typeof totalAmount === "number" ? String(totalAmount) : totalAmount);
  const total = rawTotal != null && rawTotal > 0 ? rawTotal : null;
  const allocated = allocations.reduce((sum, a) => sum + (parseAmount(a.subAmount) ?? 0), 0);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetOpportunityOrPledgeQueryKey(pledgeOrOpportunityId),
    });

  const create = useCreatePledgeAllocation();
  const update = useUpdatePledgeAllocation();
  const del = useDeletePledgeAllocation();

  async function submit(body: CreatePledgeAllocationBody | UpdatePledgeAllocationBody) {
    try {
      if (dialog?.mode === "edit") {
        await update.mutateAsync({ id: dialog.alloc.id, data: body as UpdatePledgeAllocationBody });
        toast({ title: "Allocation updated" });
      } else {
        await create.mutateAsync({
          data: { ...(body as CreatePledgeAllocationBody), pledgeOrOpportunityId },
        });
        toast({ title: "Allocation added" });
      }
      await invalidate();
      setDialog(null);
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  }

  async function remove(id: string) {
    try {
      await del.mutateAsync({ id });
      await invalidate();
      toast({ title: "Allocation removed" });
      setDialog(null);
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  }

  function usageLabel(a: PledgeAllocation): string {
    if (a.schoolRecipientId) {
      return schoolNameById.get(a.schoolRecipientId) ?? "School";
    }
    if (a.intendedUsage === "project") {
      return (a.fundableProjectId ? projectNameById.get(a.fundableProjectId) : null) ?? "Project";
    }
    return formatEnum(a.intendedUsage) || "—";
  }

  const directExcluded = directExcludedTotal(allocations);

  return (
    <div className="space-y-3">
      {reimbursablePrompt ? (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          data-testid="text-opp-reimbursable-prompt"
        >
          This is a reimbursable grant. Split each allocation into its direct and
          indirect shares and tag the direct share so it's excluded from goal
          totals (the full amount is still recorded).
        </p>
      ) : null}
      {allocations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No allocations.</p>
      ) : (
        <AllocationTable headers={PLEDGE_HEADERS} allocated={allocated} total={total}>
          {allocations.map((a) => {
            const amt = parseAmount(a.subAmount);
            const regionLabels = (a.regionIds ?? []).map((id) => regionNames.get(id) ?? id);
            return (
              <TableRow
                key={a.id}
                className="cursor-pointer"
                onClick={() => setDialog({ mode: "edit", alloc: a })}
                data-testid={`row-opp-alloc-${a.id}`}
              >
                <TableCell className="text-right font-medium whitespace-nowrap">
                  {formatCurrency(a.subAmount)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground whitespace-nowrap">
                  {amt == null ? "—" : pctLabel(amt, total)}
                </TableCell>
                <TableCell>{a.entityId ? entityNameById.get(a.entityId) ?? a.entityId : "—"}</TableCell>
                <TableCell>{usageLabel(a)}</TableCell>
                <TableCell className="whitespace-nowrap">{a.grantYear ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap" data-testid={`text-opp-alloc-${a.id}-expected`}>
                  {a.expectedPaymentDate ?? "—"}
                </TableCell>
                <TableCell
                  className="max-w-[10rem] truncate"
                  data-testid={`text-opp-alloc-${a.id}-regions`}
                >
                  {regionLabels.length ? regionLabels.join(", ") : "—"}
                </TableCell>
                <TableCell data-testid={`text-opp-alloc-${a.id}-share`}>
                  <ReimbursementTypeCell value={a.reimbursementType} />
                </TableCell>
                <TableCell>
                  <RestrictionBadges a={a} />
                </TableCell>
              </TableRow>
            );
          })}
        </AllocationTable>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDialog({ mode: "add" })}
        data-testid="button-add-opp-alloc"
      >
        <Plus className="h-4 w-4 mr-1" />
        Add allocation
      </Button>
      {directExcluded != null ? (
        <p className="text-xs text-muted-foreground" data-testid="text-opp-direct-excluded">
          {formatCurrency(String(directExcluded))} tagged direct — excluded from goal totals.
        </p>
      ) : null}
      <PledgeAllocationDialog
        open={dialog !== null}
        mode={dialog?.mode ?? "add"}
        initial={dialog?.mode === "edit" ? dialog.alloc : null}
        onClose={() => setDialog(null)}
        onSubmit={submit}
        onDelete={dialog?.mode === "edit" ? () => remove(dialog.alloc.id) : undefined}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Gift allocation dialog (add + edit)                                       */
/* ──────────────────────────────────────────────────────────────────────── */

type GiftFormState = RestrictionAxisState & {
  subAmount: string;
  entityId: string;
  intendedUsage: string;
  grantYear: string;
  regionIds: string[];
  reimbursementType: string;
  countsTowardGoal: boolean;
  fundableProjectId: string;
  schoolRecipientId: string;
  spendingStart: string;
  spendingEnd: string;
};

function giftStateFrom(a: GiftAllocation | null): GiftFormState {
  return {
    ...restrictionAxisStateFrom(a),
    subAmount: a?.subAmount ?? "",
    entityId: a?.entityId ?? "",
    intendedUsage: a?.intendedUsage ?? "",
    grantYear: a?.grantYear ?? "",
    regionIds: a?.regionIds ?? [],
    reimbursementType: a?.reimbursementType ?? "",
    countsTowardGoal: a?.countsTowardGoal ?? true,
    fundableProjectId: a?.fundableProjectId ?? "",
    schoolRecipientId: a?.schoolRecipientId ?? "",
    spendingStart: a?.spendingStart ?? "",
    spendingEnd: a?.spendingEnd ?? "",
  };
}

function GiftAllocationDialog({
  open,
  mode,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: {
  open: boolean;
  mode: "add" | "edit";
  initial: GiftAllocation | null;
  onClose: () => void;
  onSubmit: (body: CreateGiftAllocationBody | UpdateGiftAllocationBody) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const entityOptions = useEntityOptions();
  const fiscalYearOptions = useFiscalYearOptions();
  const fundableProjectOptions = useFundableProjectOptions(initial?.fundableProjectId ?? null);
  const [s, setS] = useState<GiftFormState>(() => giftStateFrom(initial));
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedKey = `${mode}:${initial?.id ?? "new"}`;
  if (open && seededFor !== seedKey) {
    setS(giftStateFrom(initial));
    setConfirmingDelete(false);
    setSeededFor(seedKey);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  const set = <K extends keyof GiftFormState>(k: K, v: GiftFormState[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  // NOTE: displayUsage is trigger-maintained in the DB and must never be written.
  function buildBody(): CreateGiftAllocationBody | UpdateGiftAllocationBody {
    const amount = parseAmount(s.subAmount);
    const axes = restrictionAxisBody(s);
    if (mode === "edit") {
      const body: UpdateGiftAllocationBody = {
        subAmount: amount == null ? null : String(amount),
        entityId: noneToNull(s.entityId),
        intendedUsage: (noneToNull(s.intendedUsage) as IntendedUsage | null) ?? null,
        grantYear: noneToNull(s.grantYear),
        regionIds: s.regionIds,
        ...axes,
        reimbursementType: (noneToNull(s.reimbursementType) as ReimbursementType | null) ?? null,
        countsTowardGoal: s.countsTowardGoal,
        fundableProjectId: noneToNull(s.fundableProjectId),
        schoolRecipientId: emptyToNull(s.schoolRecipientId),
        spendingStart: emptyToNull(s.spendingStart),
        spendingEnd: emptyToNull(s.spendingEnd),
        purposeVerbatim: emptyToNull(s.purposeVerbatim),
      };
      return body;
    }
    const body: CreateGiftAllocationBody = {
      ...axes,
      countsTowardGoal: s.countsTowardGoal,
    };
    if (amount != null) body.subAmount = String(amount);
    if (noneToNull(s.entityId)) body.entityId = s.entityId;
    if (noneToNull(s.intendedUsage)) body.intendedUsage = s.intendedUsage as IntendedUsage;
    if (noneToNull(s.grantYear)) body.grantYear = s.grantYear;
    if (s.regionIds.length) body.regionIds = s.regionIds;
    if (noneToNull(s.reimbursementType)) body.reimbursementType = s.reimbursementType as ReimbursementType;
    if (noneToNull(s.fundableProjectId)) body.fundableProjectId = s.fundableProjectId;
    if (emptyToNull(s.schoolRecipientId)) body.schoolRecipientId = s.schoolRecipientId.trim();
    if (emptyToNull(s.spendingStart)) body.spendingStart = s.spendingStart;
    if (emptyToNull(s.spendingEnd)) body.spendingEnd = s.spendingEnd;
    if (emptyToNull(s.purposeVerbatim)) body.purposeVerbatim = s.purposeVerbatim.trim();
    return body;
  }

  const setAxis = (k: keyof RestrictionAxisState, v: string) =>
    setS((prev) => ({ ...prev, [k]: v }));

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit(buildBody());
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete || saving) return;
    setSaving(true);
    try {
      await onDelete();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add allocation" : "Edit allocation"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <DialogField label="Amount" htmlFor="ga-amount">
            <Input
              id="ga-amount"
              className="h-8 text-sm"
              value={s.subAmount}
              onChange={(e) => set("subAmount", e.target.value)}
              placeholder="e.g. 50000"
              inputMode="decimal"
            />
          </DialogField>
          <DialogField label="Fund / Entity" htmlFor="ga-entity">
            <DialogSelect
              id="ga-entity"
              value={s.entityId || NONE}
              onValueChange={(v) => set("entityId", v)}
              options={entityOptions}
            />
          </DialogField>
          <DialogField label="Usage" htmlFor="ga-usage">
            <DialogSelect
              id="ga-usage"
              value={s.intendedUsage || NONE}
              onValueChange={(v) => set("intendedUsage", v)}
              options={INTENDED_USAGE_OPTIONS}
            />
          </DialogField>
          <DialogField label="Grant year" htmlFor="ga-year">
            <DialogSelect
              id="ga-year"
              value={s.grantYear || NONE}
              onValueChange={(v) => set("grantYear", v)}
              options={fiscalYearOptions}
            />
          </DialogField>
          <DialogField label="Regions" htmlFor="ga-regions">
            <RegionMultiCombobox
              testId="ga-regions"
              value={s.regionIds}
              onChange={(v) => set("regionIds", v)}
            />
          </DialogField>

          <DialogField label="Reimbursement type" htmlFor="ga-reimb">
            <DialogSelect
              id="ga-reimb"
              value={s.reimbursementType || NONE}
              onValueChange={(v) => set("reimbursementType", v)}
              options={REIMBURSEMENT_TYPE_OPTIONS}
            />
            <p className="mt-1 text-xs text-muted-foreground">{REIMBURSEMENT_TYPE_HINT}</p>
          </DialogField>

          <DialogField label="Goal tracking" htmlFor="ga-counts-goal">
            <CheckboxField
              id="ga-counts-goal"
              checked={s.countsTowardGoal}
              onCheckedChange={(v) => set("countsTowardGoal", v)}
              label="Counts toward goal"
              hint="Turn off for real money that shouldn't count against fundraising goals (e.g. government reimbursement)."
            />
          </DialogField>

          <MoreDetails>
            <RestrictionAxisFields s={s} setAxis={setAxis} />
            <DialogField label="Fundable project" htmlFor="ga-project">
              <DialogSelect
                id="ga-project"
                value={s.fundableProjectId || NONE}
                onValueChange={(v) => set("fundableProjectId", v)}
                options={fundableProjectOptions}
              />
            </DialogField>
            <DialogField label="School recipient" htmlFor="ga-school">
              <Input
                id="ga-school"
                className="h-8 text-sm"
                value={s.schoolRecipientId}
                onChange={(e) => set("schoolRecipientId", e.target.value)}
                placeholder="School ID"
              />
            </DialogField>
            <DialogField label="Spending start" htmlFor="ga-start">
              <Input
                id="ga-start"
                type="date"
                className="h-8 text-sm"
                value={s.spendingStart}
                onChange={(e) => set("spendingStart", e.target.value)}
              />
            </DialogField>
            <DialogField label="Spending end" htmlFor="ga-end">
              <Input
                id="ga-end"
                type="date"
                className="h-8 text-sm"
                value={s.spendingEnd}
                onChange={(e) => set("spendingEnd", e.target.value)}
              />
            </DialogField>
          </MoreDetails>
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {mode === "edit" && onDelete ? (
              confirmingDelete ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={saving}
                    onClick={handleDelete}
                    data-testid="button-confirm-delete-alloc"
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                  data-testid="button-delete-alloc"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving} data-testid="button-save-alloc">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Gift allocations editor                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

type GiftDialogState =
  | { mode: "add" }
  | { mode: "edit"; alloc: GiftAllocation }
  | null;

export function GiftAllocationsEditor({
  giftId,
  allocations,
  totalAmount = null,
}: {
  giftId: string;
  allocations: ReadonlyArray<GiftAllocation>;
  totalAmount?: number | string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const entityOptions = useEntityOptions();
  const entityNameById = new Map(entityOptions.map((o) => [o.value, o.label]));
  const projectNameById = useFundableProjectNameMap();
  const regionNames = useRegionNameMap();
  const [dialog, setDialog] = useState<GiftDialogState>(null);

  const rawTotal = parseAmount(typeof totalAmount === "number" ? String(totalAmount) : totalAmount);
  const total = rawTotal != null && rawTotal > 0 ? rawTotal : null;
  const allocated = allocations.reduce((sum, a) => sum + (parseAmount(a.subAmount) ?? 0), 0);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetGiftOrPaymentQueryKey(giftId),
    });

  const create = useCreateGiftAllocation();
  const update = useUpdateGiftAllocation();
  const del = useDeleteGiftAllocation();

  async function submit(body: CreateGiftAllocationBody | UpdateGiftAllocationBody) {
    try {
      if (dialog?.mode === "edit") {
        await update.mutateAsync({ id: dialog.alloc.id, data: body as UpdateGiftAllocationBody });
        toast({ title: "Allocation updated" });
      } else {
        await create.mutateAsync({ data: { ...(body as CreateGiftAllocationBody), giftId } });
        toast({ title: "Allocation added" });
      }
      await invalidate();
      setDialog(null);
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  }

  async function remove(id: string) {
    try {
      await del.mutateAsync({ id });
      await invalidate();
      toast({ title: "Allocation removed" });
      setDialog(null);
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  }

  function usageLabel(a: GiftAllocation): string {
    if (a.intendedUsage === "project") {
      return (a.fundableProjectId ? projectNameById.get(a.fundableProjectId) : null) ?? "Project";
    }
    const base = formatEnum(a.intendedUsage);
    return base || a.displayUsage || "—";
  }

  const directExcluded = directExcludedTotal(allocations);

  return (
    <div className="space-y-3">
      {allocations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No allocations.</p>
      ) : (
        <AllocationTable headers={GIFT_HEADERS} allocated={allocated} total={total}>
          {allocations.map((a) => {
            const amt = parseAmount(a.subAmount);
            const regionLabels = (a.regionIds ?? []).map((id) => regionNames.get(id) ?? id);
            return (
              <TableRow
                key={a.id}
                className="cursor-pointer"
                onClick={() => setDialog({ mode: "edit", alloc: a })}
                data-testid={`row-gift-alloc-${a.id}`}
              >
                <TableCell className="text-right font-medium whitespace-nowrap">
                  {formatCurrency(a.subAmount)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground whitespace-nowrap">
                  {amt == null ? "—" : pctLabel(amt, total)}
                </TableCell>
                <TableCell>{a.entityId ? entityNameById.get(a.entityId) ?? a.entityId : "—"}</TableCell>
                <TableCell>{usageLabel(a)}</TableCell>
                <TableCell className="whitespace-nowrap">{a.grantYear ?? "—"}</TableCell>
                <TableCell
                  className="max-w-[10rem] truncate"
                  data-testid={`text-gift-alloc-${a.id}-regions`}
                >
                  {regionLabels.length ? regionLabels.join(", ") : "—"}
                </TableCell>
                <TableCell data-testid={`text-gift-alloc-${a.id}-share`}>
                  <ReimbursementTypeCell value={a.reimbursementType} />
                </TableCell>
                <TableCell>
                  <RestrictionBadges a={a} />
                </TableCell>
              </TableRow>
            );
          })}
        </AllocationTable>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDialog({ mode: "add" })}
        data-testid="button-add-gift-alloc"
      >
        <Plus className="h-4 w-4 mr-1" />
        Add allocation
      </Button>
      {directExcluded != null ? (
        <p className="text-xs text-muted-foreground" data-testid="text-gift-direct-excluded">
          {formatCurrency(String(directExcluded))} tagged direct — excluded from goal totals.
        </p>
      ) : null}
      <GiftAllocationDialog
        open={dialog !== null}
        mode={dialog?.mode ?? "add"}
        initial={dialog?.mode === "edit" ? dialog.alloc : null}
        onClose={() => setDialog(null)}
        onSubmit={submit}
        onDelete={dialog?.mode === "edit" ? () => remove(dialog.alloc.id) : undefined}
      />
    </div>
  );
}
