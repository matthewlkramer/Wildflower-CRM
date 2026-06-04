import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdatePaymentIntermediary,
  useDeletePaymentIntermediary,
  getListPaymentIntermediariesQueryKey,
  type PaymentIntermediary,
  PaymentIntermediaryType,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatEnum } from "@/lib/format";

const INTERMEDIARY_TYPES: PaymentIntermediaryType[] = [
  PaymentIntermediaryType.daf,
  PaymentIntermediaryType.giving_platform,
  PaymentIntermediaryType.private_wealth_manager,
];

const NONE_TYPE = "__none__";

function typeLabel(t: PaymentIntermediaryType): string {
  return t === PaymentIntermediaryType.daf ? "DAF" : formatEnum(t);
}

export function PaymentIntermediaryRowActions({
  intermediary,
}: {
  intermediary: PaymentIntermediary;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(intermediary.name);
  const [type, setType] = useState<string>(intermediary.type ?? NONE_TYPE);

  useEffect(() => {
    if (editOpen) {
      setName(intermediary.name);
      setType(intermediary.type ?? NONE_TYPE);
    }
  }, [editOpen, intermediary.name, intermediary.type]);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListPaymentIntermediariesQueryKey(),
    });

  const updateMut = useUpdatePaymentIntermediary({
    mutation: {
      onSuccess: async () => {
        await refresh();
        toast({ title: "Payment intermediary updated" });
        setEditOpen(false);
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

  const deleteMut = useDeletePaymentIntermediary({
    mutation: {
      onSuccess: async () => {
        await refresh();
        toast({ title: "Payment intermediary deleted" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const trimmed = name.trim();

  return (
    <div
      className="flex justify-end"
      onClick={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground"
            aria-label={`Actions for ${intermediary.name}`}
            data-testid={`button-actions-payint-${intermediary.id}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setEditOpen(true);
            }}
            data-testid={`menu-edit-payint-${intermediary.id}`}
          >
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault();
              setDeleteOpen(true);
            }}
            data-testid={`menu-delete-payint-${intermediary.id}`}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={editOpen}
        onOpenChange={(v) => {
          if (!updateMut.isPending) setEditOpen(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit payment intermediary</DialogTitle>
            <DialogDescription>
              Update the name and type of this payment intermediary.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!trimmed) return;
              updateMut.mutate({
                id: intermediary.id,
                data: {
                  name: trimmed,
                  type:
                    type === NONE_TYPE
                      ? null
                      : (type as PaymentIntermediaryType),
                },
              });
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="edit-payint-name">Name</Label>
              <Input
                id="edit-payint-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
                data-testid="input-edit-payint-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-payint-type">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger
                  id="edit-payint-type"
                  data-testid="select-edit-payint-type"
                >
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_TYPE}>None</SelectItem>
                  {INTERMEDIARY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {typeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditOpen(false)}
                disabled={updateMut.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!trimmed || updateMut.isPending}
                data-testid="button-save-payint"
              >
                {updateMut.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${intermediary.name}?`}
        description="This will permanently remove this payment intermediary. This action cannot be undone."
        confirmTestId={`button-confirm-delete-payint-${intermediary.id}`}
        onConfirm={() => deleteMut.mutateAsync({ id: intermediary.id })}
      />
    </div>
  );
}
