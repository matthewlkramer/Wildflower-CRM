import { useState, type ReactNode } from "react";
import { X, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  usePersonSearch,
  useOrganizationSearch,
  useHouseholdSearch,
  usePersonName,
  useOrganizationName,
  useHouseholdName,
  type PickerItem,
} from "@/components/entity-picker";
import {
  useListOpportunitiesAndPledges,
  useGetOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryKey,
  useListGiftsAndPayments,
  useGetGiftOrPayment,
  getGetGiftOrPaymentQueryKey,
  useListGrantLeads,
  useGetGrantLead,
  getGetGrantLeadQueryKey,
} from "@workspace/api-client-react";

/* Opportunity/Gift search hooks (light) */
function useOpportunitySearch(query: string): { items: PickerItem[]; isLoading: boolean } {
  const { data, isLoading } = useListOpportunitiesAndPledges({
    search: query || undefined,
    limit: 20,
  });
  const items: PickerItem[] = (data?.data ?? []).map((o) => ({
    id: o.id,
    label: o.name ?? o.id,
    sublabel: o.stage ?? undefined,
  }));
  return { items, isLoading };
}
function useOpportunityName(id: string | null): string | null {
  const { data } = useGetOpportunityOrPledge(id ?? "", {
    query: { enabled: !!id, queryKey: getGetOpportunityOrPledgeQueryKey(id ?? "") },
  });
  return data?.name ?? null;
}
function useGiftSearch(query: string): { items: PickerItem[]; isLoading: boolean } {
  const { data, isLoading } = useListGiftsAndPayments({
    search: query || undefined,
    limit: 20,
  });
  const items: PickerItem[] = (data?.data ?? []).map((g) => ({
    id: g.id,
    label: giftLabel(g),
    sublabel: g.amount != null ? `$${g.amount}` : undefined,
  }));
  return { items, isLoading };
}
function giftLabel(g: { id: string; funderName?: string | null; amount?: string | null }): string {
  return g.funderName ? `${g.funderName} — $${g.amount ?? "?"}` : g.id;
}
function useGiftName(id: string | null): string | null {
  const { data } = useGetGiftOrPayment(id ?? "", {
    query: { enabled: !!id, queryKey: getGetGiftOrPaymentQueryKey(id ?? "") },
  });
  return data ? giftLabel(data) : null;
}

function useGrantLeadSearch(query: string): { items: PickerItem[]; isLoading: boolean } {
  const { data, isLoading } = useListGrantLeads({
    search: query || undefined,
    limit: 20,
    includeArchived: true,
  });
  const items: PickerItem[] = (data?.data ?? []).map((gl) => ({
    id: gl.id,
    label: gl.title,
    sublabel: gl.funderName ?? undefined,
  }));
  return { items, isLoading };
}
function useGrantLeadName(id: string | null): string | null {
  const { data } = useGetGrantLead(id ?? "", {
    query: { enabled: !!id, queryKey: getGetGrantLeadQueryKey(id ?? "") },
  });
  return data?.title ?? null;
}

type EntityType = "person" | "organization" | "household" | "opportunity" | "gift" | "grant-lead";

const TYPE_LABEL: Record<EntityType, string> = {
  person: "Person",
  organization: "Organization",
  household: "Household",
  opportunity: "Opportunity",
  gift: "Gift",
  "grant-lead": "Grant Lead",
};

export interface EntityLinks {
  personIds: string[];
  organizationIds: string[];
  householdIds: string[];
  opportunityIds: string[];
  giftIds: string[];
  grantLeadIds: string[];
}

export const EMPTY_LINKS: EntityLinks = {
  personIds: [],
  organizationIds: [],
  householdIds: [],
  opportunityIds: [],
  giftIds: [],
  grantLeadIds: [],
};

function FieldOf(t: EntityType): keyof EntityLinks {
  return ({
    person: "personIds",
    organization: "organizationIds",
    household: "householdIds",
    opportunity: "opportunityIds",
    gift: "giftIds",
    "grant-lead": "grantLeadIds",
  } as const)[t];
}

function AddPicker({
  type,
  onPick,
}: {
  type: EntityType;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const search = (() => {
    switch (type) {
      case "person": return usePersonSearch;
      case "organization": return useOrganizationSearch;
      case "household": return useHouseholdSearch;
      case "opportunity": return useOpportunitySearch;
      case "gift": return useGiftSearch;
      case "grant-lead": return useGrantLeadSearch;
    }
  })();
  const { items, isLoading } = search(q);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          data-testid={`button-add-link-${type}`}
        >
          <Plus className="h-3 w-3 mr-1" /> {TYPE_LABEL[type]}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[280px]" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder={`Search ${TYPE_LABEL[type].toLowerCase()}…`} />
          <CommandList>
            {isLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">Loading…</div>
            ) : items.length === 0 ? (
              <CommandEmpty>No results.</CommandEmpty>
            ) : null}
            <CommandGroup>
              {items.map((it) => (
                <CommandItem
                  key={it.id}
                  value={it.id}
                  onSelect={() => {
                    onPick(it.id);
                    setOpen(false);
                    setQ("");
                  }}
                  data-testid={`option-add-${type}-${it.id}`}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{it.label}</span>
                    {it.sublabel ? (
                      <span className="truncate text-xs text-muted-foreground">{it.sublabel}</span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Chip({
  type,
  id,
  name,
  onRemove,
}: {
  type: EntityType;
  id: string;
  name: ReactNode;
  onRemove?: () => void;
}) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1" data-testid={`chip-link-${type}-${id}`}>
      <span className="text-xs text-muted-foreground">{TYPE_LABEL[type]}:</span>
      <span>{name ?? id}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove link"
          className="rounded hover:bg-muted-foreground/10"
          data-testid={`button-remove-link-${type}-${id}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </Badge>
  );
}

function ResolvedChip({ type, id, onRemove }: { type: EntityType; id: string; onRemove?: () => void }) {
  const resolver = (() => {
    switch (type) {
      case "person": return usePersonName;
      case "organization": return useOrganizationName;
      case "household": return useHouseholdName;
      case "opportunity": return useOpportunityName;
      case "gift": return useGiftName;
      case "grant-lead": return useGrantLeadName;
    }
  })();
  const name = resolver(id) ?? id;
  return <Chip type={type} id={id} name={name} onRemove={onRemove} />;
}

export function EntityLinksEditor({
  value,
  onChange,
  pinned,
}: {
  value: EntityLinks;
  onChange: (next: EntityLinks) => void;
  /** IDs that came from page context — shown but not removable. */
  pinned?: Partial<EntityLinks>;
}) {
  const types: EntityType[] = ["person", "organization", "household", "opportunity", "gift", "grant-lead"];
  const pin = pinned ?? {};
  function add(type: EntityType, id: string) {
    const field = FieldOf(type);
    const cur = value[field];
    if (cur.includes(id) || (pin[field] ?? []).includes(id)) return;
    onChange({ ...value, [field]: [...cur, id] });
  }
  function remove(type: EntityType, id: string) {
    const field = FieldOf(type);
    onChange({ ...value, [field]: value[field].filter((x) => x !== id) });
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {types.flatMap((t) => {
          const field = FieldOf(t);
          const pinnedIds = pin[field] ?? [];
          const userIds = value[field];
          return [
            ...pinnedIds.map((id) => (
              <ResolvedChip key={`pin-${t}-${id}`} type={t} id={id} />
            )),
            ...userIds.map((id) => (
              <ResolvedChip key={`u-${t}-${id}`} type={t} id={id} onRemove={() => remove(t, id)} />
            )),
          ];
        })}
        {types.every((t) => value[FieldOf(t)].length === 0) &&
        types.every((t) => (pin[FieldOf(t)] ?? []).length === 0) ? (
          <span className="text-xs text-muted-foreground">No links yet.</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="text-xs text-muted-foreground self-center mr-1">Link to:</span>
        {types.map((t) => (
          <AddPicker key={t} type={t} onPick={(id) => add(t, id)} />
        ))}
      </div>
    </div>
  );
}

export function MentionsPicker({
  value,
  onChange,
  users,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  users: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = new Set(value);
  const filtered = users.filter(
    (u) => !q.trim() || u.label.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? (
          <span className="text-xs text-muted-foreground">No one mentioned.</span>
        ) : (
          value.map((id) => {
            const u = users.find((x) => x.id === id);
            return (
              <Badge key={id} variant="secondary" className="gap-1 pr-1" data-testid={`chip-mention-${id}`}>
                @{u?.label ?? id}
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x !== id))}
                  aria-label="Remove mention"
                  className="rounded hover:bg-muted-foreground/10"
                  data-testid={`button-remove-mention-${id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })
        )}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7" data-testid="button-add-mention">
            <Plus className="h-3 w-3 mr-1" /> Mention someone
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[260px]" align="start">
          <Command shouldFilter={false}>
            <CommandInput value={q} onValueChange={setQ} placeholder="Search teammates…" />
            <CommandList>
              {filtered.length === 0 ? <CommandEmpty>No matches.</CommandEmpty> : null}
              <CommandGroup>
                {filtered.map((u) => (
                  <CommandItem
                    key={u.id}
                    value={u.id}
                    onSelect={() => {
                      if (selected.has(u.id)) {
                        onChange(value.filter((x) => x !== u.id));
                      } else {
                        onChange([...value, u.id]);
                      }
                    }}
                    data-testid={`option-mention-${u.id}`}
                  >
                    <span className={selected.has(u.id) ? "font-semibold" : ""}>{u.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
