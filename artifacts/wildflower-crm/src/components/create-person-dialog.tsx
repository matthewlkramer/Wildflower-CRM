import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useCreatePerson,
  getListPeopleQueryKey,
  useListPeople,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Button } from "@/components/ui/button";
import { AddIconButton } from "@/components/add-icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  EntityCombobox,
  personDisplayName,
  useOrganizationName,
  useOrganizationSearch,
} from "@/components/entity-picker";
import {
  AddPersonOrgRoleDialog,
  AddPersonToHouseholdDialog,
} from "@/components/add-role-dialogs";
import { useDebounce } from "@/hooks/use-debounce";

const PROSPECT_PATHS = {
  individual: "Individual prospect",
  household: "Individual connected to a household",
  existing: "Person at an existing organization",
  new: "Person at a new organization",
} as const;

type ProspectPath = keyof typeof PROSPECT_PATHS;

export function CreatePersonDialog() {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [path, setPath] = useState<ProspectPath>("individual");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    id: string;
    path: Exclude<ProspectPath, "individual">;
    organizationId?: string;
  } | null>(null);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreatePerson({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListPeopleQueryKey(),
        });
        toast({ title: "Person created" });
        setOpen(false);
        setFirstName("");
        setLastName("");
        if (!created?.id) return;
        if (path === "individual") {
          navigate(`/individuals/${created.id}`);
        } else {
          setCreated({
            id: created.id,
            path,
            organizationId:
              path === "existing" ? (organizationId ?? undefined) : undefined,
          });
        }
        setPath("individual");
        setOrganizationId(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Create failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const fn = firstName.trim();
  const ln = lastName.trim();
  const fullName = [fn, ln].filter(Boolean).join(" ");
  const nameSearch = useDebounce(fullName, 250);
  const searchParams = {
    search: nameSearch,
    showFoundationPartners: true,
    limit: 5,
  };
  const duplicateSearch = useListPeople(searchParams, {
    query: {
      queryKey: getListPeopleQueryKey(searchParams),
      enabled: open && nameSearch.length >= 2,
    },
  });
  const checkingMatches =
    fullName.length >= 2 &&
    (nameSearch !== fullName || duplicateSearch.isFetching);
  const potentialMatches =
    nameSearch === fullName ? (duplicateSearch.data?.data ?? []) : [];
  const canSubmit =
    fullName.length > 0 &&
    !checkingMatches &&
    (path !== "existing" || !!organizationId);

  if (created) {
    const finish = () => {
      setCreated(null);
      navigate(`/individuals/${created.id}`);
    };
    return created.path === "household" ? (
      <AddPersonToHouseholdDialog
        personId={created.id}
        onSetupFinish={finish}
      />
    ) : (
      <AddPersonOrgRoleDialog
        personId={created.id}
        setup={{ organizationId: created.organizationId, onFinish: finish }}
      />
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <AddIconButton label="New person" data-testid="button-new-person" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
          <DialogDescription>
            Start with a name to check for an existing record, then choose how
            this person is connected.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit || create.isPending) return;
            create.mutate({
              data: {
                firstName: fn || undefined,
                lastName: ln || undefined,
                fullName,
              },
            });
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-person-first">First name</Label>
              <Input
                id="new-person-first"
                value={firstName}
                disabled={create.isPending}
                onChange={(e) => setFirstName(e.target.value)}
                autoFocus
                data-testid="input-new-person-first"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-person-last">Last name</Label>
              <Input
                id="new-person-last"
                value={lastName}
                disabled={create.isPending}
                onChange={(e) => setLastName(e.target.value)}
                data-testid="input-new-person-last"
              />
            </div>
          </div>
          {checkingMatches && (
            <p role="status" className="text-xs text-muted-foreground">
              Checking for existing records…
            </p>
          )}
          {potentialMatches.length > 0 && !checkingMatches && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <p className="font-medium">Possible existing records</p>
              <ul className="mt-1 space-y-1">
                {potentialMatches.map((person) => (
                  <li key={person.id}>
                    <Link
                      href={`/individuals/${person.id}`}
                      className="text-primary underline underline-offset-2"
                    >
                      {personDisplayName(person)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              How are they connected?
            </legend>
            <RadioGroup
              value={path}
              disabled={create.isPending}
              onValueChange={(value) => setPath(value as ProspectPath)}
              className="gap-2"
            >
              {Object.entries(PROSPECT_PATHS).map(([value, label]) => (
                <div className="flex items-center gap-2" key={value}>
                  <RadioGroupItem value={value} id={`prospect-path-${value}`} />
                  <Label htmlFor={`prospect-path-${value}`}>{label}</Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          {path === "existing" && (
            <div className="space-y-1">
              <Label>Organization</Label>
              <EntityCombobox
                useSearch={useOrganizationSearch}
                useResolve={useOrganizationName}
                value={organizationId}
                onChange={(id) => {
                  if (!create.isPending) setOrganizationId(id);
                }}
                allowNull={false}
                placeholder="Search organizations…"
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {path === "individual"
              ? "Add contact details, funding interests, and a relationship owner on the person’s page."
              : "Continue saves the person first, then opens the affiliation step."}
          </p>
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
              disabled={!canSubmit || create.isPending}
              data-testid="button-create-person"
            >
              {create.isPending
                ? "Creating…"
                : path === "individual"
                  ? "Create person"
                  : "Save person and continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
