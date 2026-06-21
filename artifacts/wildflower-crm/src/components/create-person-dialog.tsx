import { useState } from "react";
import { useLocation } from "wouter";
import {
  useCreatePerson,
  getListPeopleQueryKey,
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

export function CreatePersonDialog() {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreatePerson({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        toast({ title: "Person created" });
        setOpen(false);
        setFirstName("");
        setLastName("");
        if (created?.id) navigate(`/individuals/${created.id}`);
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
  const canSubmit = fullName.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!create.isPending) setOpen(v); }}>
      <DialogTrigger asChild>
        <AddIconButton label="New person" data-testid="button-new-person" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
          <DialogDescription>
            Enter at least a first or last name. You can fill in everything else from the detail page.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
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
                onChange={(e) => setLastName(e.target.value)}
                data-testid="input-new-person-last"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || create.isPending} data-testid="button-create-person">
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
