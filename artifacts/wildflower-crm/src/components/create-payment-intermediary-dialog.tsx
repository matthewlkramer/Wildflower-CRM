import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePaymentIntermediary,
  getListPaymentIntermediariesQueryKey,
  PaymentIntermediaryType,
} from "@workspace/api-client-react";
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

export function CreatePaymentIntermediaryDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>(NONE_TYPE);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const create = useCreatePaymentIntermediary({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListPaymentIntermediariesQueryKey(),
        });
        toast({ title: "Payment intermediary created" });
        setOpen(false);
        setName("");
        setType(NONE_TYPE);
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
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) {
          setOpen(v);
          if (v) {
            setName("");
            setType(NONE_TYPE);
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="button-new-payint">New payment intermediary</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New payment intermediary</DialogTitle>
          <DialogDescription>
            You can fill in the rest of the details after creating it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed) return;
            create.mutate({
              data: {
                name: trimmed,
                ...(type === NONE_TYPE
                  ? {}
                  : { type: type as PaymentIntermediaryType }),
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-payint-name">Name</Label>
            <Input
              id="new-payint-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              data-testid="input-new-payint-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-payint-type">Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger
                id="new-payint-type"
                data-testid="select-new-payint-type"
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
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || create.isPending}
              data-testid="button-create-payint"
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
