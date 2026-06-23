import { useState } from "react";
import { DetailSkeleton } from "@/components/ui/skeleton";
import { Link, useRoute } from "wouter";
import { Pencil } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPaymentIntermediary,
  useUpdatePaymentIntermediary,
  getGetPaymentIntermediaryQueryKey,
  getListPaymentIntermediariesQueryKey,
  PaymentIntermediaryType,
} from "@workspace/api-client-react";
import { formatEnum, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { INLINE_EDIT_GROUP, EDIT_PENCIL_REVEAL } from "@/components/inline-edit";
import {
  INTERMEDIARY_TYPES,
  NONE_TYPE,
  intermediaryTypeLabel,
} from "@/lib/payment-intermediary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";

export default function PaymentIntermediaryDetail() {
  const [, params] = useRoute<{ id: string }>("/payment-intermediaries/:id");
  const id = params?.id ?? "";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<string>(NONE_TYPE);

  const { data, isLoading, isError, error } = useGetPaymentIntermediary(id, {
    query: { queryKey: getGetPaymentIntermediaryQueryKey(id), enabled: !!id },
  });

  const updateMut = useUpdatePaymentIntermediary({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetPaymentIntermediaryQueryKey(id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListPaymentIntermediariesQueryKey(),
          }),
        ]);
        toast({ title: "Payment intermediary updated" });
        setEditing(false);
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

  if (isLoading) {
    return <DetailSkeleton />;
  }

  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href="/payment-intermediaries" className="text-sm text-primary hover:underline">
          ← Back to payment intermediaries
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Payment intermediary not found."}
        </div>
      </div>
    );
  }

  const emails = data.emails ?? [];
  const people = data.people ?? [];

  const startEdit = () => {
    setDraftName(data.name);
    setDraftType(data.type ?? NONE_TYPE);
    setEditing(true);
  };

  const trimmed = draftName.trim();
  const saveEdit = () => {
    if (!trimmed) return;
    updateMut.mutate({
      id,
      data: {
        name: trimmed,
        type: draftType === NONE_TYPE ? null : (draftType as PaymentIntermediaryType),
      },
    });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/payment-intermediaries" className="text-sm text-primary hover:underline">
          ← Payment Intermediaries
        </Link>
      </div>

      <div
        className={cn(
          INLINE_EDIT_GROUP,
          "flex items-start justify-between gap-4",
        )}
      >
        <div className="space-y-1">
          <h1 className="text-3xl font-serif font-bold text-foreground">{data.name}</h1>
          {data.type && (
            <Badge variant="outline" className="mt-1">{formatEnum(data.type)}</Badge>
          )}
        </div>
        {!editing && (
          <Button
            variant="outline"
            size="sm"
            className={EDIT_PENCIL_REVEAL}
            onClick={startEdit}
            data-testid="button-edit-payint-detail"
          >
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Details
        </h2>
        <Separator />
        {editing ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="detail-payint-name">Name</Label>
              <Input
                id="detail-payint-name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                autoFocus
                required
                data-testid="input-detail-payint-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="detail-payint-type">Type</Label>
              <Select value={draftType} onValueChange={setDraftType}>
                <SelectTrigger id="detail-payint-type" data-testid="select-detail-payint-type">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_TYPE}>None</SelectItem>
                  {INTERMEDIARY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {intermediaryTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={updateMut.isPending}
                data-testid="button-cancel-payint-detail"
              >
                Cancel
              </Button>
              <Button
                onClick={saveEdit}
                disabled={!trimmed || updateMut.isPending}
                data-testid="button-save-payint-detail"
              >
                {updateMut.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{data.name}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{data.type ? formatEnum(data.type) : "—"}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDate(data.createdAt)}</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{formatDate(data.updatedAt)}</dd>
          </dl>
        )}
      </div>

      {emails.length > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Email addresses
          </h2>
          <Separator />
          <ul className="space-y-1">
            {emails.map((e) => (
              <li key={e.id} className="text-sm">
                <a href={`mailto:${e.email}`} className="text-primary hover:underline">
                  {e.email}
                </a>
                {e.type && (
                  <span className="ml-2 text-muted-foreground">({formatEnum(e.type)})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {people.length > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Associated people
          </h2>
          <Separator />
          <ul className="space-y-1">
            {people.map((p) => (
              <li key={p.id} className="text-sm">
                {p.personId ? (
                  <Link
                    href={`/individuals/${p.personId}`}
                    className="text-primary hover:underline"
                  >
                    {p.personName ?? p.personId}
                  </Link>
                ) : (
                  <span>{p.personName ?? "—"}</span>
                )}
                {p.connection && (
                  <span className="ml-2 text-muted-foreground">({formatEnum(p.connection)})</span>
                )}
                {p.current === "past" && (
                  <span className="ml-2 text-xs text-muted-foreground/60 italic">past</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
