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
  useListRevenueAccounts,
  getGetOpportunityOrPledgeQueryKey,
  getGetGiftOrPaymentQueryKey,
  type PledgeAllocation,
  type GiftAllocation,
  type IntendedUsage,
  type PledgeAllocationStatus,
  type RestrictionType,
  type DeferredRevenue,
  type CreatePledgeAllocationBody,
  type UpdatePledgeAllocationBody,
  type CreateGiftAllocationBody,
  type UpdateGiftAllocationBody,
} from "@workspace/api-client-react";
import { LOCATIONS } from "@workspace/api-zod";
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

const PLEDGE_ALLOCATION_STATUS_OPTIONS: ReadonlyArray<Option> = [
  { value: "working", label: "Working" },
  { value: "committed", label: "Committed" },
  { value: "committed_with_conditions", label: "Committed (conditions)" },
  { value: "superseded", label: "Superseded" },
  { value: "superseded_by_pledge", label: "Superseded by pledge" },
  { value: "superseded_by_gift", label: "Superseded by gift" },
  { value: "abandoned", label: "Abandoned" },
];

const RESTRICTION_TYPE_OPTIONS: ReadonlyArray<Option> = [
  { value: "unrestricted", label: "Unrestricted" },
  { value: "purpose", label: "Purpose-restricted" },
  { value: "time", label: "Time-restricted" },
  { value: "both", label: "Purpose & time-restricted" },
  { value: "unclear", label: "Unclear (needs review)" },
  { value: "na", label: "N/A" },
];

const DEFERRED_REVENUE_OPTIONS: ReadonlyArray<Option> = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "na", label: "N/A" },
];

const NONE = "__none__";

// Human-readable hints for the coding flags surfaced by the derivation lib.
const CODING_FLAG_LABELS: Record<string, string> = {
  restriction_unclear: "Restriction unclear — set a restriction type so an Object Code can be derived.",
  restriction_na: "Restriction is N/A — no contribution Object Code is derived.",
  loan_no_revenue_account: "Loan-fund investment — principal movement, no revenue Object Code.",
  payer_type_assumed: "Payer type was assumed — confirm the donor type.",
  location_default: "Location defaulted to Foundation General — no entity/region signal.",
};

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

const RESTRICTED_HINT =
  "Check if the grant letter formally restricts this. Leave unchecked if it's just our documented understanding of the donor's intent.";

/* ──────────────────────────────────────────────────────────────────────── */
/* Revenue-coding capture + derived display                                  */
/* ──────────────────────────────────────────────────────────────────────── */

// The coding-related slice of an allocation form. Shared by pledge + gift
// dialogs since the revenue-accounting capture fields are identical.
type CodingFormState = {
  restrictionType: string;
  restrictionEvidence: string;
  purposeVerbatim: string;
  deferredRevenue: string;
  deferredRevenueReason: string;
  objectCodeOverride: string;
  revenueLocationOverride: string;
  revenueClassOverride: string;
};

function codingStateFrom(
  a: Pick<
    PledgeAllocation | GiftAllocation,
    | "restrictionType"
    | "restrictionEvidence"
    | "purposeVerbatim"
    | "deferredRevenue"
    | "deferredRevenueReason"
    | "objectCodeOverride"
    | "revenueLocationOverride"
    | "revenueClassOverride"
  > | null,
): CodingFormState {
  return {
    restrictionType: a?.restrictionType ?? "",
    restrictionEvidence: a?.restrictionEvidence ?? "",
    purposeVerbatim: a?.purposeVerbatim ?? "",
    deferredRevenue: a?.deferredRevenue ?? "",
    deferredRevenueReason: a?.deferredRevenueReason ?? "",
    objectCodeOverride: a?.objectCodeOverride ?? "",
    revenueLocationOverride: a?.revenueLocationOverride ?? "",
    revenueClassOverride: a?.revenueClassOverride ?? "",
  };
}

// Capture fields shared by the create + update bodies (both allocation types).
type CodingBody = {
  restrictionType?: RestrictionType | null;
  restrictionEvidence?: string | null;
  purposeVerbatim?: string | null;
  deferredRevenue?: DeferredRevenue | null;
  deferredRevenueReason?: string | null;
  objectCodeOverride?: string | null;
  revenueLocationOverride?: string | null;
  revenueClassOverride?: string | null;
};

function codingBodyFrom(s: CodingFormState): CodingBody {
  return {
    restrictionType: (noneToNull(s.restrictionType) as RestrictionType | null) ?? null,
    restrictionEvidence: emptyToNull(s.restrictionEvidence),
    purposeVerbatim: emptyToNull(s.purposeVerbatim),
    deferredRevenue: (noneToNull(s.deferredRevenue) as DeferredRevenue | null) ?? null,
    deferredRevenueReason: emptyToNull(s.deferredRevenueReason),
    objectCodeOverride: noneToNull(s.objectCodeOverride),
    revenueLocationOverride: noneToNull(s.revenueLocationOverride),
    revenueClassOverride: noneToNull(s.revenueClassOverride),
  };
}

// Object Code options from the live revenue_accounts table (active only).
function useRevenueAccountOptions(): ReadonlyArray<Option> {
  const { data } = useListRevenueAccounts({ activeOnly: true });
  return (data ?? []).map((acct) => ({
    value: acct.code,
    label: `${acct.code} — ${acct.name}`,
  }));
}

const LOCATION_OPTIONS: ReadonlyArray<Option> = LOCATIONS.map((loc) => ({
  value: loc,
  label: loc,
}));

// Read-only "Derived / Effective" line: shows the frozen snapshot and, when an
// override is set, the override that supersedes it.
function CodingValue({
  label,
  derived,
  override,
}: {
  label: string;
  derived: string | null | undefined;
  override: string | null | undefined;
}) {
  const hasOverride = override != null && override !== "";
  const effective = hasOverride ? override : (derived ?? null);
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">
        {effective ? (
          <span className="font-medium">{effective}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {hasOverride ? (
          <span className="ml-1 text-muted-foreground">
            (override{derived ? `; derived ${derived}` : ""})
          </span>
        ) : null}
      </span>
    </div>
  );
}

// The full revenue-coding section rendered inside each allocation dialog's
// "More details": capture inputs, the derived snapshot, review flags, and the
// manual overrides. `derived` is the snapshot on the existing row (add mode has
// none until the first save).
function RevenueCodingFields({
  s,
  set,
  derived,
}: {
  s: CodingFormState;
  set: <K extends keyof CodingFormState>(k: K, v: CodingFormState[K]) => void;
  derived: Pick<
    PledgeAllocation | GiftAllocation,
    "objectCode" | "revenueLocation" | "revenueClass" | "codingFlags"
  > | null;
}) {
  const accountOptions = useRevenueAccountOptions();
  const flags = derived?.codingFlags ?? [];
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-muted-foreground">Revenue accounting</p>

      <DialogField label="Restriction type" htmlFor="rc-restriction">
        <DialogSelect
          id="rc-restriction"
          value={s.restrictionType || NONE}
          onValueChange={(v) => set("restrictionType", v)}
          options={RESTRICTION_TYPE_OPTIONS}
        />
      </DialogField>
      <DialogField label="Restriction evidence" htmlFor="rc-evidence">
        <Textarea
          id="rc-evidence"
          className="text-sm min-h-[48px]"
          value={s.restrictionEvidence}
          onChange={(e) => set("restrictionEvidence", e.target.value)}
          placeholder="Where the restriction is documented (grant letter section, email…)"
          rows={2}
        />
      </DialogField>
      <DialogField label="Purpose (verbatim)" htmlFor="rc-purpose">
        <Textarea
          id="rc-purpose"
          className="text-sm min-h-[48px]"
          value={s.purposeVerbatim}
          onChange={(e) => set("purposeVerbatim", e.target.value)}
          placeholder="Donor's stated purpose, copied verbatim"
          rows={2}
        />
      </DialogField>
      <DialogField label="Deferred revenue" htmlFor="rc-deferred">
        <DialogSelect
          id="rc-deferred"
          value={s.deferredRevenue || NONE}
          onValueChange={(v) => set("deferredRevenue", v)}
          options={DEFERRED_REVENUE_OPTIONS}
        />
      </DialogField>
      <DialogField label="Deferred reason" htmlFor="rc-deferred-reason">
        <Textarea
          id="rc-deferred-reason"
          className="text-sm min-h-[48px]"
          value={s.deferredRevenueReason}
          onChange={(e) => set("deferredRevenueReason", e.target.value)}
          placeholder="Why this is (or isn't) deferred"
          rows={2}
        />
      </DialogField>

      <div className="space-y-1 rounded-md bg-muted/40 p-2">
        <p className="text-xs font-medium text-muted-foreground">Derived QuickBooks coding</p>
        <CodingValue label="Object Code" derived={derived?.objectCode} override={s.objectCodeOverride} />
        <CodingValue label="Location" derived={derived?.revenueLocation} override={s.revenueLocationOverride} />
        <CodingValue label="Class" derived={derived?.revenueClass} override={s.revenueClassOverride} />
        {flags.length ? (
          <ul className="mt-1 space-y-0.5">
            {flags.map((f) => (
              <li key={f} className="text-xs text-amber-600 dark:text-amber-500">
                {CODING_FLAG_LABELS[f] ?? f}
              </li>
            ))}
          </ul>
        ) : null}
        {derived == null ? (
          <p className="text-xs text-muted-foreground">Coding is derived on save.</p>
        ) : null}
      </div>

      <DialogField label="Object Code override" htmlFor="rc-oc-override">
        <DialogSelect
          id="rc-oc-override"
          value={s.objectCodeOverride || NONE}
          onValueChange={(v) => set("objectCodeOverride", v)}
          options={accountOptions}
          placeholder="— Use derived —"
        />
      </DialogField>
      <DialogField label="Location override" htmlFor="rc-loc-override">
        <DialogSelect
          id="rc-loc-override"
          value={s.revenueLocationOverride || NONE}
          onValueChange={(v) => set("revenueLocationOverride", v)}
          options={LOCATION_OPTIONS}
          placeholder="— Use derived —"
        />
      </DialogField>
      <DialogField label="Class override" htmlFor="rc-class-override">
        <Input
          id="rc-class-override"
          className="h-8 text-sm"
          value={s.revenueClassOverride}
          onChange={(e) => set("revenueClassOverride", e.target.value)}
          placeholder="— Use derived —"
        />
      </DialogField>
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
  { key: "regions", label: "Regions" },
  { key: "restriction", label: "Restriction" },
];

const GIFT_HEADERS = PLEDGE_HEADERS;

/* ──────────────────────────────────────────────────────────────────────── */
/* Pledge allocation dialog (add + edit)                                     */
/* ──────────────────────────────────────────────────────────────────────── */

type PledgeFormState = CodingFormState & {
  subAmount: string;
  entityId: string;
  intendedUsage: string;
  grantYear: string;
  regionIds: string[];
  formallyRestricted: boolean;
  status: string;
  fundableProjectId: string;
  directToSchool: boolean;
  contingent: boolean;
  conditions: string;
  notes: string;
};

function pledgeStateFrom(a: PledgeAllocation | null): PledgeFormState {
  return {
    ...codingStateFrom(a),
    subAmount: a?.subAmount ?? "",
    entityId: a?.entityId ?? "",
    intendedUsage: a?.intendedUsage ?? "",
    grantYear: a?.grantYear ?? "",
    regionIds: a?.regionIds ?? [],
    formallyRestricted: a?.formallyRestricted ?? false,
    status: a?.status ?? "",
    fundableProjectId: a?.fundableProjectId ?? "",
    directToSchool: a?.directToSchool ?? false,
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
    const coding = codingBodyFrom(s);
    if (mode === "edit") {
      const body: UpdatePledgeAllocationBody = {
        subAmount: amount == null ? null : String(amount),
        entityId: noneToNull(s.entityId),
        intendedUsage: (noneToNull(s.intendedUsage) as IntendedUsage | null) ?? null,
        grantYear: noneToNull(s.grantYear),
        regionIds: s.regionIds,
        formallyRestricted: s.formallyRestricted,
        status: (noneToNull(s.status) as PledgeAllocationStatus | null) ?? null,
        fundableProjectId: noneToNull(s.fundableProjectId),
        directToSchool: s.directToSchool,
        contingent: s.contingent,
        conditions: emptyToNull(s.conditions),
        notes: emptyToNull(s.notes),
        ...coding,
      };
      return body;
    }
    const body: CreatePledgeAllocationBody = {
      formallyRestricted: s.formallyRestricted,
      directToSchool: s.directToSchool,
      contingent: s.contingent,
    };
    if (amount != null) body.subAmount = String(amount);
    if (noneToNull(s.entityId)) body.entityId = s.entityId;
    if (noneToNull(s.intendedUsage)) body.intendedUsage = s.intendedUsage as IntendedUsage;
    if (noneToNull(s.grantYear)) body.grantYear = s.grantYear;
    if (s.regionIds.length) body.regionIds = s.regionIds;
    if (noneToNull(s.status)) body.status = s.status as PledgeAllocationStatus;
    if (noneToNull(s.fundableProjectId)) body.fundableProjectId = s.fundableProjectId;
    if (emptyToNull(s.conditions)) body.conditions = s.conditions.trim();
    if (emptyToNull(s.notes)) body.notes = s.notes.trim();
    if (coding.restrictionType != null) body.restrictionType = coding.restrictionType;
    if (coding.restrictionEvidence != null) body.restrictionEvidence = coding.restrictionEvidence;
    if (coding.purposeVerbatim != null) body.purposeVerbatim = coding.purposeVerbatim;
    if (coding.deferredRevenue != null) body.deferredRevenue = coding.deferredRevenue;
    if (coding.deferredRevenueReason != null) body.deferredRevenueReason = coding.deferredRevenueReason;
    if (coding.objectCodeOverride != null) body.objectCodeOverride = coding.objectCodeOverride;
    if (coding.revenueLocationOverride != null) body.revenueLocationOverride = coding.revenueLocationOverride;
    if (coding.revenueClassOverride != null) body.revenueClassOverride = coding.revenueClassOverride;
    return body;
  }

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
          <DialogField label="Regions" htmlFor="pa-regions">
            <RegionMultiCombobox
              testId="pa-regions"
              value={s.regionIds}
              onChange={(v) => set("regionIds", v)}
            />
          </DialogField>

          <MoreDetails>
            <DialogField label="Restriction">
              <CheckboxField
                id="pa-restricted"
                checked={s.formallyRestricted}
                onCheckedChange={(v) => set("formallyRestricted", v)}
                label="Formally restricted by grant letter"
                hint={RESTRICTED_HINT}
              />
            </DialogField>
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
                onCheckedChange={(v) => set("directToSchool", v)}
                label="Funds flow directly to a school"
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
            <RevenueCodingFields s={s} set={set} derived={initial} />
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
}: {
  pledgeOrOpportunityId: string;
  allocations: ReadonlyArray<PledgeAllocation>;
  totalAmount?: number | string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const entityOptions = useEntityOptions();
  const entityNameById = new Map(entityOptions.map((o) => [o.value, o.label]));
  const projectNameById = useFundableProjectNameMap();
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
    if (a.intendedUsage === "project") {
      return (a.fundableProjectId ? projectNameById.get(a.fundableProjectId) : null) ?? "Project";
    }
    return formatEnum(a.intendedUsage) || "—";
  }

  return (
    <div className="space-y-3">
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
                <TableCell
                  className="max-w-[10rem] truncate"
                  data-testid={`text-opp-alloc-${a.id}-regions`}
                >
                  {regionLabels.length ? regionLabels.join(", ") : "—"}
                </TableCell>
                <TableCell>
                  {a.formallyRestricted ? (
                    <Badge variant="secondary" className="gap-1 whitespace-nowrap">
                      <Lock className="h-3 w-3" />
                      Restricted
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">Intent</span>
                  )}
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

type GiftFormState = CodingFormState & {
  subAmount: string;
  entityId: string;
  intendedUsage: string;
  grantYear: string;
  regionIds: string[];
  formalRegionalRestriction: boolean;
  formalFundUseRestriction: boolean;
  fundableProjectId: string;
  schoolRecipientId: string;
  spendingStart: string;
  spendingEnd: string;
};

function giftStateFrom(a: GiftAllocation | null): GiftFormState {
  return {
    ...codingStateFrom(a),
    subAmount: a?.subAmount ?? "",
    entityId: a?.entityId ?? "",
    intendedUsage: a?.intendedUsage ?? "",
    grantYear: a?.grantYear ?? "",
    regionIds: a?.regionIds ?? [],
    formalRegionalRestriction: a?.formalRegionalRestriction ?? false,
    formalFundUseRestriction: a?.formalFundUseRestriction ?? false,
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
    const coding = codingBodyFrom(s);
    if (mode === "edit") {
      const body: UpdateGiftAllocationBody = {
        subAmount: amount == null ? null : String(amount),
        entityId: noneToNull(s.entityId),
        intendedUsage: (noneToNull(s.intendedUsage) as IntendedUsage | null) ?? null,
        grantYear: noneToNull(s.grantYear),
        regionIds: s.regionIds,
        formalRegionalRestriction: s.formalRegionalRestriction,
        formalFundUseRestriction: s.formalFundUseRestriction,
        fundableProjectId: noneToNull(s.fundableProjectId),
        schoolRecipientId: emptyToNull(s.schoolRecipientId),
        spendingStart: emptyToNull(s.spendingStart),
        spendingEnd: emptyToNull(s.spendingEnd),
        ...coding,
      };
      return body;
    }
    const body: CreateGiftAllocationBody = {
      formalRegionalRestriction: s.formalRegionalRestriction,
      formalFundUseRestriction: s.formalFundUseRestriction,
    };
    if (amount != null) body.subAmount = String(amount);
    if (noneToNull(s.entityId)) body.entityId = s.entityId;
    if (noneToNull(s.intendedUsage)) body.intendedUsage = s.intendedUsage as IntendedUsage;
    if (noneToNull(s.grantYear)) body.grantYear = s.grantYear;
    if (s.regionIds.length) body.regionIds = s.regionIds;
    if (noneToNull(s.fundableProjectId)) body.fundableProjectId = s.fundableProjectId;
    if (emptyToNull(s.schoolRecipientId)) body.schoolRecipientId = s.schoolRecipientId.trim();
    if (emptyToNull(s.spendingStart)) body.spendingStart = s.spendingStart;
    if (emptyToNull(s.spendingEnd)) body.spendingEnd = s.spendingEnd;
    if (coding.restrictionType != null) body.restrictionType = coding.restrictionType;
    if (coding.restrictionEvidence != null) body.restrictionEvidence = coding.restrictionEvidence;
    if (coding.purposeVerbatim != null) body.purposeVerbatim = coding.purposeVerbatim;
    if (coding.deferredRevenue != null) body.deferredRevenue = coding.deferredRevenue;
    if (coding.deferredRevenueReason != null) body.deferredRevenueReason = coding.deferredRevenueReason;
    if (coding.objectCodeOverride != null) body.objectCodeOverride = coding.objectCodeOverride;
    if (coding.revenueLocationOverride != null) body.revenueLocationOverride = coding.revenueLocationOverride;
    if (coding.revenueClassOverride != null) body.revenueClassOverride = coding.revenueClassOverride;
    return body;
  }

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

          <MoreDetails>
            <DialogField label="Restriction">
              <div className="space-y-2">
                <CheckboxField
                  id="ga-use-rest"
                  checked={s.formalFundUseRestriction}
                  onCheckedChange={(v) => set("formalFundUseRestriction", v)}
                  label="Formally restricted to this use"
                  hint={RESTRICTED_HINT}
                />
                <CheckboxField
                  id="ga-region-rest"
                  checked={s.formalRegionalRestriction}
                  onCheckedChange={(v) => set("formalRegionalRestriction", v)}
                  label="Formally restricted to this region"
                />
              </div>
            </DialogField>
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
            <RevenueCodingFields s={s} set={set} derived={initial} />
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

  return (
    <div className="space-y-3">
      {allocations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No allocations.</p>
      ) : (
        <AllocationTable headers={GIFT_HEADERS} allocated={allocated} total={total}>
          {allocations.map((a) => {
            const amt = parseAmount(a.subAmount);
            const regionLabels = (a.regionIds ?? []).map((id) => regionNames.get(id) ?? id);
            const restricted = a.formalFundUseRestriction || a.formalRegionalRestriction;
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
                <TableCell>
                  {restricted ? (
                    <div className="flex flex-wrap gap-1">
                      {a.formalFundUseRestriction ? (
                        <Badge variant="secondary" className="gap-1 whitespace-nowrap">
                          <Lock className="h-3 w-3" />
                          Use
                        </Badge>
                      ) : null}
                      {a.formalRegionalRestriction ? (
                        <Badge variant="secondary" className="gap-1 whitespace-nowrap">
                          <Lock className="h-3 w-3" />
                          Region
                        </Badge>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">Intent</span>
                  )}
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
