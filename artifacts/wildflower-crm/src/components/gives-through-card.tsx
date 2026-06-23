import { useState } from "react";
import { X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDonorPaymentIntermediaries,
  useCreateDonorPaymentIntermediary,
  useDeleteDonorPaymentIntermediary,
  getListDonorPaymentIntermediariesQueryKey,
  type ListDonorPaymentIntermediariesParams,
  type CreateDonorPaymentIntermediaryBody,
  type PaymentIntermediary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { RelatedCard, CardAction, AffiliationRow } from "@/components/record-layout";
import {
  EntityCombobox,
  useIntermediarySearch,
  useIntermediaryName,
  intermediaryDisplayName,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";
import { formatEnum } from "@/lib/format";

/**
 * The donor whose payment intermediaries ("gives through") this card manages.
 * Exactly one id must be set — the server enforces the donor-XOR invariant.
 */
export interface GivesThroughDonor {
  organizationId?: string;
  individualGiverPersonId?: string;
  householdId?: string;
}

function donorParams(d: GivesThroughDonor): ListDonorPaymentIntermediariesParams {
  if (d.organizationId) return { organizationId: d.organizationId };
  if (d.individualGiverPersonId)
    return { individualGiverPersonId: d.individualGiverPersonId };
  return { householdId: d.householdId };
}

function donorBody(
  d: GivesThroughDonor,
  paymentIntermediaryId: string,
): CreateDonorPaymentIntermediaryBody {
  if (d.organizationId)
    return { paymentIntermediaryId, organizationId: d.organizationId };
  if (d.individualGiverPersonId)
    return {
      paymentIntermediaryId,
      individualGiverPersonId: d.individualGiverPersonId,
    };
  return { paymentIntermediaryId, householdId: d.householdId };
}

function piRole(pi: PaymentIntermediary): string | undefined {
  return pi.type ? formatEnum(pi.type) : undefined;
}

/**
 * "Gives through" — payment intermediaries (DAFs, foundations, etc.) a donor
 * routes their giving through. Backed by the donor↔intermediary join table,
 * so the same intermediary can serve many donors. Intermediaries seen on the
 * donor's gifts but not yet logged here are offered as one-click suggestions.
 */
export function GivesThroughCard({ donor }: { donor: GivesThroughDonor }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const params = donorParams(donor);
  const listKey = getListDonorPaymentIntermediariesQueryKey(params);
  const listQ = useListDonorPaymentIntermediaries(params, {
    query: { queryKey: listKey },
  });

  const createMut = useCreateDonorPaymentIntermediary();
  const deleteMut = useDeleteDonorPaymentIntermediary();

  const links = listQ.data?.data ?? [];
  const giftDerived = listQ.data?.giftDerived ?? [];
  const loggedIds = links.map((l) => l.paymentIntermediaryId);

  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });

  const addIntermediary = async (paymentIntermediaryId: string) => {
    try {
      await createMut.mutateAsync({
        data: donorBody(donor, paymentIntermediaryId),
      });
      await refresh();
      setDraft(null);
      setAdding(false);
    } catch {
      toast({
        title: "Couldn't add intermediary",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  const removeLink = async (id: string) => {
    try {
      await deleteMut.mutateAsync({ id });
      await refresh();
    } catch {
      toast({
        title: "Couldn't remove intermediary",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <RelatedCard
      title="Gives through"
      count={links.length}
      empty={links.length === 0 && giftDerived.length === 0}
      action={
        <CardAction
          label="Add"
          onClick={() => setAdding((v) => !v)}
        />
      }
    >
      {adding ? (
        <div className="flex items-center gap-1 px-2 py-2">
          <EntityCombobox
            useSearch={useIntermediarySearch}
            useResolve={useIntermediaryName}
            value={draft}
            onChange={(id) => {
              setDraft(id);
              if (id) void addIntermediary(id);
            }}
            placeholder="Search intermediaries…"
            allowNull={false}
            excludeIds={loggedIds}
            disabled={createMut.isPending}
            testId="select-add-gives-through"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground"
            disabled={createMut.isPending}
            onClick={() => {
              setAdding(false);
              setDraft(null);
            }}
            aria-label="Cancel add intermediary"
            data-testid="button-cancel-add-gives-through"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {links.length > 0 ? (
        <div>
          {links.map((link) => (
            <div key={link.id} data-testid={`row-gives-through-${link.id}`}>
              <AffiliationRow
                name={intermediaryDisplayName(link.paymentIntermediary)}
                href={`/payment-intermediaries/${link.paymentIntermediaryId}`}
                role={piRole(link.paymentIntermediary)}
                hideStatusBadge
                action={
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    disabled={deleteMut.isPending}
                    onClick={() => void removeLink(link.id)}
                    aria-label={`Remove ${intermediaryDisplayName(link.paymentIntermediary)}`}
                    data-testid={`button-remove-gives-through-${link.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                }
              />
            </div>
          ))}
        </div>
      ) : !adding ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No payment intermediaries linked.
        </p>
      ) : null}

      {giftDerived.length > 0 ? (
        <div className="mt-1 border-t px-2 pt-2">
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            Seen on gifts — add?
          </p>
          {giftDerived.map((pi) => (
            <div
              key={pi.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
              data-testid={`row-gives-through-suggestion-${pi.id}`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {intermediaryDisplayName(pi)}
                </div>
                {piRole(pi) ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {piRole(pi)}
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 text-xs text-primary"
                disabled={createMut.isPending}
                onClick={() => void addIntermediary(pi.id)}
                data-testid={`button-add-gives-through-suggestion-${pi.id}`}
              >
                Add
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </RelatedCard>
  );
}
