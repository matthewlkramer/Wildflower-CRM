import { forwardRef, useState, type ComponentProps } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  useCreatePeopleEntityRole,
  useUpdatePeopleEntityRole,
  useDeletePeopleEntityRole,
  useUpdateFunder,
  getGetPersonQueryKey,
  getGetFunderQueryKey,
  getGetOrganizationQueryKey,
  getGetHouseholdQueryKey,
  getGetPaymentIntermediaryQueryKey,
  getListFundersQueryKey,
  getListPeopleEntityRolesQueryKey,
  EntityRoleType,
  PeopleEntityRoleConnection,
  PeopleRoleCurrent,
  type CreatePeopleEntityRoleBody,
  type PeopleEntityRole,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  EntityCombobox,
  useFunderSearch,
  useFunderName,
  usePersonSearch,
  usePersonName,
  useOrganizationSearch,
  useOrganizationName,
  useIntermediarySearch,
  useIntermediaryName,
} from "@/components/entity-picker";
import { formatEnum } from "@/lib/format";

// Must forward ref + props: DialogTrigger uses `asChild` and clones this
// element to attach its onClick/ref. A plain wrapper that ignores props would
// swallow the click and the dialog would never open.
const AddCardButton = forwardRef<
  HTMLButtonElement,
  { testId: string } & ComponentProps<typeof Button>
>(({ testId, ...props }, ref) => (
  <Button
    ref={ref}
    variant="ghost"
    size="sm"
    className="h-6 px-2 text-xs"
    data-testid={testId}
    {...props}
  >
    <Plus className="mr-1 h-3.5 w-3.5" />
    Add
  </Button>
));
AddCardButton.displayName = "AddCardButton";

const CONNECTION_VALUES = Object.values(PeopleEntityRoleConnection);

// Radix Select forbids empty-string item values, so use a sentinel for the
// clearable "None" option and map it back to "" (omitted from the request).
const NONE_VALUE = "__none__";

/** Shared role attribute fields: connection, title, current, primary. */
function RoleAttributeFields({
  connection,
  setConnection,
  title,
  setTitle,
  current,
  setCurrent,
  primary,
  setPrimary,
  idPrefix,
}: {
  connection: string;
  setConnection: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  current: PeopleRoleCurrent;
  setCurrent: (v: PeopleRoleCurrent) => void;
  primary: boolean;
  setPrimary: (v: boolean) => void;
  idPrefix: string;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Connection</Label>
          <Select
            value={connection || NONE_VALUE}
            onValueChange={(v) => setConnection(v === NONE_VALUE ? "" : v)}
          >
            <SelectTrigger data-testid={`select-${idPrefix}-connection`}>
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>None</SelectItem>
              {CONNECTION_VALUES.map((c) => (
                <SelectItem key={c} value={c}>
                  {formatEnum(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select
            value={current}
            onValueChange={(v) => setCurrent(v as PeopleRoleCurrent)}
          >
            <SelectTrigger data-testid={`select-${idPrefix}-current`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PeopleRoleCurrent.current}>Current</SelectItem>
              <SelectItem value={PeopleRoleCurrent.past}>Past</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-title`}>Title / role</Label>
        <Input
          id={`${idPrefix}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Executive Director"
          data-testid={`input-${idPrefix}-title`}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-primary`}
          checked={primary}
          onCheckedChange={(v) => setPrimary(v === true)}
          data-testid={`checkbox-${idPrefix}-primary`}
        />
        <Label htmlFor={`${idPrefix}-primary`} className="font-normal">
          Primary contact
        </Label>
      </div>
    </>
  );
}

function buildRoleAttrs(
  connection: string,
  title: string,
  current: PeopleRoleCurrent,
  primary: boolean,
): Pick<
  CreatePeopleEntityRoleBody,
  "connection" | "externalTitleOrRole" | "current" | "primaryContact"
> {
  return {
    connection: connection
      ? (connection as PeopleEntityRoleConnection)
      : undefined,
    externalTitleOrRole: title.trim() || undefined,
    current,
    primaryContact: primary || undefined,
  };
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Individual detail → Organizations card → "Add"                            */
/* Links the person to a funder / non-funding org / payment intermediary.    */
/* ───────────────────────────────────────────────────────────────────────── */

type OrgKind = "funder" | "non_funding_organization" | "payment_intermediary";

const ORG_KIND_LABEL: Record<OrgKind, string> = {
  funder: "Funder",
  non_funding_organization: "Organization",
  payment_intermediary: "Payment intermediary",
};

export function AddPersonOrgRoleDialog({ personId }: { personId: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<OrgKind>("funder");
  const [entityId, setEntityId] = useState<string | null>(null);
  const [connection, setConnection] = useState("");
  const [title, setTitle] = useState("");
  const [current, setCurrent] = useState<PeopleRoleCurrent>(
    PeopleRoleCurrent.current,
  );
  const [primary, setPrimary] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const reset = () => {
    setKind("funder");
    setEntityId(null);
    setConnection("");
    setTitle("");
    setCurrent(PeopleRoleCurrent.current);
    setPrimary(false);
  };

  const create = useCreatePeopleEntityRole({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getGetPersonQueryKey(personId),
        });
        toast({ title: "Organization linked" });
        setOpen(false);
        reset();
      },
      onError: (err: unknown) => {
        toast({
          title: "Link failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const submit = () => {
    if (!entityId || create.isPending) return;
    const attrs = buildRoleAttrs(connection, title, current, primary);
    create.mutate({
      data: {
        personId,
        entityType: kind as EntityRoleType,
        funderId: kind === "funder" ? entityId : undefined,
        organizationId:
          kind === "non_funding_organization" ? entityId : undefined,
        paymentIntermediaryId:
          kind === "payment_intermediary" ? entityId : undefined,
        ...attrs,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <AddCardButton testId="button-add-person-org" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link organization</DialogTitle>
          <DialogDescription>
            Tie this person to a funder, organization, or payment intermediary.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as OrgKind);
                  setEntityId(null);
                }}
              >
                <SelectTrigger data-testid="select-person-org-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ORG_KIND_LABEL) as OrgKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {ORG_KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{ORG_KIND_LABEL[kind]}</Label>
              {kind === "funder" ? (
                <EntityCombobox
                  useSearch={useFunderSearch}
                  useResolve={useFunderName}
                  value={entityId}
                  onChange={setEntityId}
                  allowNull={false}
                  placeholder="Search funders…"
                  testId="select-person-org-entity"
                />
              ) : kind === "non_funding_organization" ? (
                <EntityCombobox
                  useSearch={useOrganizationSearch}
                  useResolve={useOrganizationName}
                  value={entityId}
                  onChange={setEntityId}
                  allowNull={false}
                  placeholder="Search organizations…"
                  testId="select-person-org-entity"
                />
              ) : (
                <EntityCombobox
                  useSearch={useIntermediarySearch}
                  useResolve={useIntermediaryName}
                  value={entityId}
                  onChange={setEntityId}
                  allowNull={false}
                  placeholder="Search intermediaries…"
                  testId="select-person-org-entity"
                />
              )}
            </div>
          </div>
          <RoleAttributeFields
            connection={connection}
            setConnection={setConnection}
            title={title}
            setTitle={setTitle}
            current={current}
            setCurrent={setCurrent}
            primary={primary}
            setPrimary={setPrimary}
            idPrefix="person-org"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!entityId || create.isPending}
              data-testid="button-save-person-org"
            >
              {create.isPending ? "Linking…" : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Funder detail → People card → "Add"                                       */
/* Links a person to this funder.                                            */
/* ───────────────────────────────────────────────────────────────────────── */

export function AddFunderPersonRoleDialog({ funderId }: { funderId: string }) {
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [connection, setConnection] = useState("");
  const [title, setTitle] = useState("");
  const [current, setCurrent] = useState<PeopleRoleCurrent>(
    PeopleRoleCurrent.current,
  );
  const [primary, setPrimary] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const reset = () => {
    setPersonId(null);
    setConnection("");
    setTitle("");
    setCurrent(PeopleRoleCurrent.current);
    setPrimary(false);
  };

  const create = useCreatePeopleEntityRole({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getGetFunderQueryKey(funderId),
        });
        toast({ title: "Person linked" });
        setOpen(false);
        reset();
      },
      onError: (err: unknown) => {
        toast({
          title: "Link failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const submit = () => {
    if (!personId || create.isPending) return;
    const attrs = buildRoleAttrs(connection, title, current, primary);
    create.mutate({
      data: {
        personId,
        entityType: EntityRoleType.funder,
        funderId,
        ...attrs,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <AddCardButton testId="button-add-funder-person" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link person</DialogTitle>
          <DialogDescription>
            Tie a person to this funder.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Person</Label>
            <EntityCombobox
              useSearch={usePersonSearch}
              useResolve={usePersonName}
              value={personId}
              onChange={setPersonId}
              allowNull={false}
              placeholder="Search people…"
              testId="select-funder-person-entity"
            />
          </div>
          <RoleAttributeFields
            connection={connection}
            setConnection={setConnection}
            title={title}
            setTitle={setTitle}
            current={current}
            setCurrent={setCurrent}
            primary={primary}
            setPrimary={setPrimary}
            idPrefix="funder-person"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!personId || create.isPending}
              data-testid="button-save-funder-person"
            >
              {create.isPending ? "Linking…" : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Funder detail → Organizations card → "Add"                                */
/* Set a parent funder, add a child funder, or set a payment intermediary.   */
/* ───────────────────────────────────────────────────────────────────────── */

type FunderRelation = "parent" | "child" | "payment_intermediary";

const RELATION_LABEL: Record<FunderRelation, string> = {
  parent: "Parent funder",
  child: "Child funder",
  payment_intermediary: "Payment intermediary",
};

export function AddFunderRelationDialog({ funderId }: { funderId: string }) {
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState<FunderRelation>("parent");
  const [entityId, setEntityId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const reset = () => {
    setRelation("parent");
    setEntityId(null);
  };

  const invalidateFunders = async (otherFunderId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetFunderQueryKey(funderId),
      }),
      queryClient.invalidateQueries({ queryKey: getListFundersQueryKey() }),
      ...(otherFunderId
        ? [
            queryClient.invalidateQueries({
              queryKey: getGetFunderQueryKey(otherFunderId),
            }),
          ]
        : []),
    ]);
  };

  const update = useUpdateFunder({
    mutation: {
      onSuccess: async (_data, vars) => {
        await invalidateFunders(vars.id === funderId ? undefined : vars.id);
        toast({ title: "Relationship added" });
        setOpen(false);
        reset();
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const submit = () => {
    if (!entityId || update.isPending) return;
    if (relation === "parent") {
      update.mutate({ id: funderId, data: { parentFunderId: entityId } });
    } else if (relation === "child") {
      // The child funder gets this funder as its parent.
      update.mutate({ id: entityId, data: { parentFunderId: funderId } });
    } else {
      update.mutate({
        id: funderId,
        data: { paymentIntermediaryId: entityId },
      });
    }
  };

  const isFunderPick = relation === "parent" || relation === "child";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!update.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <AddCardButton testId="button-add-funder-relation" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add organization relationship</DialogTitle>
          <DialogDescription>
            Set a parent funder, add a child funder, or set a payment
            intermediary.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Relationship</Label>
            <Select
              value={relation}
              onValueChange={(v) => {
                setRelation(v as FunderRelation);
                setEntityId(null);
              }}
            >
              <SelectTrigger data-testid="select-funder-relation-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RELATION_LABEL) as FunderRelation[]).map((r) => (
                  <SelectItem key={r} value={r}>
                    {RELATION_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{RELATION_LABEL[relation]}</Label>
            {isFunderPick ? (
              <EntityCombobox
                useSearch={useFunderSearch}
                useResolve={useFunderName}
                value={entityId}
                onChange={setEntityId}
                allowNull={false}
                placeholder="Search funders…"
                testId="select-funder-relation-entity"
                excludeIds={[funderId]}
              />
            ) : (
              <EntityCombobox
                useSearch={useIntermediarySearch}
                useResolve={useIntermediaryName}
                value={entityId}
                onChange={setEntityId}
                allowNull={false}
                placeholder="Search intermediaries…"
                testId="select-funder-relation-entity"
              />
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!entityId || update.isPending}
              data-testid="button-save-funder-relation"
            >
              {update.isPending ? "Saving…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Edit / delete an existing people_entity_role record.                       */
/* Rendered as a small pencil icon next to a relationship row; the row's      */
/* name keeps its own navigation link.                                        */
/* ───────────────────────────────────────────────────────────────────────── */

// Must forward ref + props so DialogTrigger's `asChild` can attach onClick/ref.
const EditRoleIconButton = forwardRef<
  HTMLButtonElement,
  { testId: string } & ComponentProps<typeof Button>
>(({ testId, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="icon"
    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
    data-testid={testId}
    {...props}
  >
    <Pencil className="h-3.5 w-3.5" />
    <span className="sr-only">Edit relationship</span>
  </Button>
));
EditRoleIconButton.displayName = "EditRoleIconButton";

export function EditPeopleEntityRoleDialog({
  role,
  contextLabel,
}: {
  role: PeopleEntityRole;
  /** Optional name shown in the dialog header for context (entity or person). */
  contextLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [connection, setConnection] = useState(role.connection ?? "");
  const [title, setTitle] = useState(role.externalTitleOrRole ?? "");
  const [current, setCurrent] = useState<PeopleRoleCurrent>(role.current);
  const [primary, setPrimary] = useState(role.primaryContact);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Re-seed the form from the latest record each time the dialog opens so it
  // never shows stale edits from a previous (cancelled) session.
  const syncFromRole = () => {
    setConnection(role.connection ?? "");
    setTitle(role.externalTitleOrRole ?? "");
    setCurrent(role.current);
    setPrimary(role.primaryContact);
    setConfirmDelete(false);
  };

  // The role record carries the person id plus exactly one entity FK, so every
  // view that could be showing this row is refreshed straight from the record.
  const invalidate = async () => {
    const keys: QueryKey[] = [
      getGetPersonQueryKey(role.personId),
      getListPeopleEntityRolesQueryKey(),
    ];
    if (role.funderId) keys.push(getGetFunderQueryKey(role.funderId));
    if (role.organizationId)
      keys.push(getGetOrganizationQueryKey(role.organizationId));
    if (role.householdId) keys.push(getGetHouseholdQueryKey(role.householdId));
    if (role.paymentIntermediaryId)
      keys.push(getGetPaymentIntermediaryQueryKey(role.paymentIntermediaryId));
    await Promise.all(
      keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  };

  const update = useUpdatePeopleEntityRole({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Relationship updated" });
        setOpen(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const remove = useDeletePeopleEntityRole({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Relationship removed" });
        setOpen(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Remove failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const pending = update.isPending || remove.isPending;

  const submit = () => {
    if (pending) return;
    // PATCH semantics: send null (not undefined) to clear connection/title so an
    // emptied field is actually cleared rather than left unchanged.
    update.mutate({
      id: role.id,
      data: {
        connection: connection
          ? (connection as PeopleEntityRoleConnection)
          : null,
        externalTitleOrRole: title.trim() ? title.trim() : null,
        current,
        primaryContact: primary,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (pending) return;
        if (v) syncFromRole();
        setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <EditRoleIconButton testId={`button-edit-role-${role.id}`} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit relationship</DialogTitle>
          <DialogDescription>
            {contextLabel
              ? `Update how this person is connected to ${contextLabel}.`
              : "Update this person↔entity relationship."}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <RoleAttributeFields
            connection={connection}
            setConnection={setConnection}
            title={title}
            setTitle={setTitle}
            current={current}
            setCurrent={setCurrent}
            primary={primary}
            setPrimary={setPrimary}
            idPrefix="edit-role"
          />
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant={confirmDelete ? "destructive" : "ghost"}
              onClick={() => {
                if (confirmDelete) {
                  remove.mutate({ id: role.id });
                } else {
                  setConfirmDelete(true);
                }
              }}
              disabled={pending}
              data-testid={`button-delete-role-${role.id}`}
              className={confirmDelete ? "" : "text-destructive"}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {remove.isPending
                ? "Removing…"
                : confirmDelete
                  ? "Confirm remove"
                  : "Remove"}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pending}
                data-testid={`button-save-role-${role.id}`}
              >
                {update.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
