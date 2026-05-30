import { forwardRef, useState, type ComponentProps } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePeopleEntityRole,
  useUpdateFunder,
  getGetPersonQueryKey,
  getGetFunderQueryKey,
  getListFundersQueryKey,
  EntityRoleType,
  PeopleEntityRoleConnection,
  PeopleRoleCurrent,
  type CreatePeopleEntityRoleBody,
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
import { Plus } from "lucide-react";
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
