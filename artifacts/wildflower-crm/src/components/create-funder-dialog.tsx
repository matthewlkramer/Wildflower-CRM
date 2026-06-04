import { useState } from "react";
import { useLocation } from "wouter";
import {
  useCreateOrganization,
  getListOrganizationsQueryKey,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateOrganizationDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateOrganization({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({ queryKey: getListOrganizationsQueryKey() });
        toast({ title: "Funding entity created" });
        setOpen(false);
        setName("");
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

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!create.isPending) setOpen(v); }}>
      <DialogTrigger asChild>
        <Button data-testid="button-new-funder">New organization</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            You can fill in the rest of the details after creating it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed) return;
            create.mutate({ data: { name: trimmed } });
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
              disabled={!trimmed || create.isPending}
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
