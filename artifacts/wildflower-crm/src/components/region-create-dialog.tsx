import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateRegion,
  getListRegionsQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, X } from "lucide-react";
import { toast } from "sonner";
import {
  REGION_QUERY_PARAMS,
  matchesRegionQuery,
  regionTypeBadge,
  useRegionOptions,
  type RegionOption,
} from "@/components/region-picker-core";
import { RegionMultiCombobox } from "@/components/region-multi-combobox";

const CREATABLE_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "state", label: "State" },
  { value: "metro_area", label: "Metro area" },
  { value: "city", label: "City" },
  { value: "neighborhood", label: "Neighborhood" },
  { value: "region_within_state", label: "Region within a state" },
  { value: "multi_state_region", label: "Multi-state region" },
  { value: "custom_region", label: "Custom grouping" },
  { value: "country", label: "Country" },
];

/**
 * Admin-only structured region creation. Replaces the retired one-click
 * "Create '<query>'" affordance: name + type are required, canonical parent
 * and grouping members are explicit, and likely duplicates (name or alias
 * matches on existing regions) are surfaced for review before saving.
 * The server independently enforces the admin gate (403).
 */
export function RegionCreateDialog({
  open,
  onOpenChange,
  initialName = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  onCreated?: (regionId: string) => void;
}) {
  const { options } = useRegionOptions();
  const queryClient = useQueryClient();
  const createRegion = useCreateRegion();

  const [name, setName] = useState(initialName);
  const [type, setType] = useState<string>("");
  const [parentRegionId, setParentRegionId] = useState<string | null>(null);
  const [stateAbbreviation, setStateAbbreviation] = useState("");
  const [memberRegionIds, setMemberRegionIds] = useState<string[]>([]);
  const [aliasesText, setAliasesText] = useState("");
  const [dupesAcknowledged, setDupesAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset when (re)opened with a fresh seed name.
  const [seenOpen, setSeenOpen] = useState(false);
  if (open && !seenOpen) {
    setSeenOpen(true);
    setName(initialName);
    setType("");
    setParentRegionId(null);
    setStateAbbreviation("");
    setMemberRegionIds([]);
    setAliasesText("");
    setDupesAcknowledged(false);
  } else if (!open && seenOpen) {
    setSeenOpen(false);
  }

  const isCustom = type === "custom_region";

  const duplicates: RegionOption[] = useMemo(() => {
    const term = name.trim();
    if (term.length < 3) return [];
    return options.filter((o) => matchesRegionQuery(o, term)).slice(0, 6);
  }, [name, options]);

  const canSubmit =
    !saving &&
    name.trim().length > 0 &&
    !!type &&
    (!isCustom || memberRegionIds.length > 0) &&
    (duplicates.length === 0 || dupesAcknowledged);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const aliases = aliasesText
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const created = await createRegion.mutateAsync({
        data: {
          name: name.trim(),
          type: type as never,
          parentRegionId: isCustom ? null : parentRegionId,
          stateAbbreviation: stateAbbreviation.trim() || null,
          memberRegionIds: memberRegionIds.length ? memberRegionIds : undefined,
          aliases: aliases.length ? aliases : undefined,
        },
      });
      await queryClient.invalidateQueries({
        queryKey: getListRegionsQueryKey(REGION_QUERY_PARAMS),
      });
      toast.success(`Region "${created.name}" created`);
      onCreated?.(created.id);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create region");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New region</DialogTitle>
          <DialogDescription>
            Admin-only. The display path is derived from the canonical parent
            chain; groupings (multi-state, metro, custom) hold their scope as
            members instead.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="region-create-name">Name</Label>
            <Input
              id="region-create-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDupesAcknowledged(false);
              }}
              placeholder="e.g. Greater Boston"
              data-testid="input-region-create-name"
            />
          </div>

          {duplicates.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2.5 text-sm">
              <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                Possible duplicates
              </div>
              <ul className="mt-1.5 space-y-1">
                {duplicates.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-muted-foreground">
                    <span className="truncate">{d.displayPath || d.label}</span>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal shrink-0">
                      {regionTypeBadge(d.type)}
                    </Badge>
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
                <input
                  type="checkbox"
                  checked={dupesAcknowledged}
                  onChange={(e) => setDupesAcknowledged(e.target.checked)}
                  data-testid="checkbox-region-create-dupes-ok"
                />
                These are different — create anyway
              </label>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger data-testid="select-region-create-type">
                <SelectValue placeholder="Select type…" />
              </SelectTrigger>
              <SelectContent>
                {CREATABLE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isCustom && (
            <div className="grid gap-1.5">
              <Label>Canonical parent (geography)</Label>
              <ParentPicker
                options={options}
                value={parentRegionId}
                onChange={setParentRegionId}
              />
              <p className="text-xs text-muted-foreground">
                The natural geographic container, e.g. a city's state. Leave
                empty for top-level regions.
              </p>
            </div>
          )}

          {type === "state" && (
            <div className="grid gap-1.5">
              <Label htmlFor="region-create-abbr">State abbreviation</Label>
              <Input
                id="region-create-abbr"
                value={stateAbbreviation}
                onChange={(e) => setStateAbbreviation(e.target.value.toUpperCase())}
                placeholder="e.g. MA"
                maxLength={3}
                className="w-24"
                data-testid="input-region-create-abbr"
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>
              Grouping members{isCustom ? " (required)" : " (optional)"}
            </Label>
            <RegionMultiCombobox
              value={memberRegionIds}
              onChange={setMemberRegionIds}
              placeholder="Add member region…"
              testId="picker-region-create-members"
            />
            <p className="text-xs text-muted-foreground">
              Regions this one groups together (e.g. the states in a
              multi-state region). Not part of the geographic parent chain.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="region-create-aliases">Aliases</Label>
            <Input
              id="region-create-aliases"
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="Comma-separated, e.g. NYC, Big Apple"
              data-testid="input-region-create-aliases"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="button-region-create-save">
            {saving ? "Creating…" : "Create region"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Minimal searchable single-select for the canonical parent. */
function ParentPicker({
  options,
  value,
  onChange,
}: {
  options: RegionOption[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = value ? options.find((o) => o.id === value) : undefined;
  const term = query.trim();
  const matches = term
    ? options.filter((o) => matchesRegionQuery(o, term)).slice(0, 8)
    : [];
  if (selected) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="gap-1 font-normal">
          <span className="truncate max-w-[18rem]">{selected.displayPath || selected.label}</span>
          <button
            type="button"
            aria-label="Clear parent"
            onClick={() => onChange(null)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a parent region…"
        data-testid="input-region-create-parent-search"
      />
      {matches.length > 0 && (
        <div className="rounded-md border divide-y">
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onChange(m.id);
                setQuery("");
              }}
              data-testid={`option-region-create-parent-${m.id}`}
            >
              <span className="truncate">{m.displayPath || m.label}</span>
              <Badge variant="outline" className="ml-auto px-1.5 py-0 text-[10px] font-normal shrink-0">
                {regionTypeBadge(m.type)}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
