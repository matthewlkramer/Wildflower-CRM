import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useCreateOrganization,
  useListOrganizations,
  getListOrganizationsQueryKey,
  EntityType,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatEnum } from "@/lib/format";
import { useDebounce } from "@/hooks/use-debounce";

export function CreateOrganizationDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<EntityType | undefined>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateOrganization({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListOrganizationsQueryKey(),
        });
        toast({ title: "Funding entity created" });
        setOpen(false);
        setName("");
        setEntityType(undefined);
        if (created?.id) navigate(`/organizations/${created.id}`);
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

  const trimmed = name.trim();
  const search = useDebounce(trimmed, 250);
  const searchParams = { search, limit: 5 };
  const existing = useListOrganizations(searchParams, {
    query: {
      queryKey: getListOrganizationsQueryKey(searchParams),
      enabled: open && search.length >= 2,
    },
  });
  const checkingMatches =
    trimmed.length >= 2 && (search !== trimmed || existing.isFetching);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <AddIconButton
          label="New organization"
          data-testid="button-new-funder"
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            Check for an existing organization before adding a new one.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || create.isPending || checkingMatches) return;
            create.mutate({
              data: {
                name: trimmed,
                ...(entityType ? { entityType } : {}),
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-funder-name">Name</Label>
            <Input
              id="new-funder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              data-testid="input-new-funder-name"
            />
          </div>
          {checkingMatches ? (
            <p role="status" className="text-xs text-muted-foreground">
              Checking for existing organizations…
            </p>
          ) : search === trimmed && !!existing.data?.data.length ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <p className="font-medium">Possible existing records</p>
              <ul className="mt-1 space-y-1">
                {existing.data.data.map((organization) => (
                  <li key={organization.id}>
                    <Link
                      href={`/organizations/${organization.id}`}
                      className="text-primary underline underline-offset-2"
                    >
                      {organization.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="new-funder-type">Organization type</Label>
            <p className="text-xs text-muted-foreground">
              Choose the organization’s structure if known. Finance uses it in
              payment coding.
            </p>
            <Select
              value={entityType}
              onValueChange={(value) => setEntityType(value as EntityType)}
            >
              <SelectTrigger
                id="new-funder-type"
                data-testid="select-new-funder-type"
              >
                <SelectValue placeholder="Select a type (optional)" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(EntityType).map((value) => (
                  <SelectItem key={value} value={value}>
                    {formatEnum(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
              disabled={!trimmed || create.isPending || checkingMatches}
              data-testid="button-create-funder"
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
