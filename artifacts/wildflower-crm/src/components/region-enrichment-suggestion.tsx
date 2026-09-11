import { Loader2, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetOrganizationQueryKey,
  getGetPersonQueryKey,
  getListOrganizationEnrichmentSuggestionsQueryKey,
  getListOrganizationsQueryKey,
  getListPeopleQueryKey,
  getListPersonEnrichmentSuggestionsQueryKey,
  useListOrganizationEnrichmentSuggestions,
  useListPersonEnrichmentSuggestions,
  useResolveEnrichmentSuggestion,
  useRunOrganizationEnrichment,
  useRunPersonEnrichment,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

type EntityType = "person" | "organization";

export function RegionEnrichmentSuggestion({
  entityType,
  entityId,
  eligible,
}: {
  entityType: EntityType;
  entityId: string;
  eligible: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const personQuery = useListPersonEnrichmentSuggestions(
    entityType === "person" ? entityId : "",
    {
      query: {
        queryKey: getListPersonEnrichmentSuggestionsQueryKey(entityId),
        enabled: eligible && entityType === "person",
      },
    },
  );
  const organizationQuery = useListOrganizationEnrichmentSuggestions(
    entityType === "organization" ? entityId : "",
    {
      query: {
        queryKey: getListOrganizationEnrichmentSuggestionsQueryKey(entityId),
        enabled: eligible && entityType === "organization",
      },
    },
  );
  const query = entityType === "person" ? personQuery : organizationQuery;

  const refresh = async () => {
    const suggestionKey =
      entityType === "person"
        ? getListPersonEnrichmentSuggestionsQueryKey(entityId)
        : getListOrganizationEnrichmentSuggestionsQueryKey(entityId);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: suggestionKey }),
      queryClient.invalidateQueries({
        queryKey:
          entityType === "person"
            ? getGetPersonQueryKey(entityId)
            : getGetOrganizationQueryKey(entityId),
      }),
      queryClient.invalidateQueries({
        queryKey:
          entityType === "person"
            ? getListPeopleQueryKey()
            : getListOrganizationsQueryKey(),
      }),
    ]);
  };

  const onRunSuccess = async (count: number) => {
    await refresh();
    toast({
      title: count > 0 ? "Suggestion ready" : "No suggestion found",
      description:
        count > 0
          ? "Review the proposed region before applying it."
          : "There is not enough linked address information in the CRM yet.",
    });
  };
  const onError = (error: unknown) => {
    toast({
      title: "Could not update suggestions",
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    });
  };

  const runPerson = useRunPersonEnrichment({
    mutation: {
      onSuccess: (result) => onRunSuccess(result.data.length),
      onError,
    },
  });
  const runOrganization = useRunOrganizationEnrichment({
    mutation: {
      onSuccess: (result) => onRunSuccess(result.data.length),
      onError,
    },
  });
  const resolve = useResolveEnrichmentSuggestion({
    mutation: {
      onSuccess: async (_result, variables) => {
        await refresh();
        toast({
          title:
            variables.data.status === "accepted"
              ? "Region applied"
              : "Suggestion dismissed",
        });
      },
      onError,
    },
  });

  if (!eligible) return null;
  const suggestion = query.data?.data[0];
  const isRunning = runPerson.isPending || runOrganization.isPending;

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking CRM suggestions…
      </div>
    );
  }

  if (!suggestion) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            Suggest a region from linked CRM addresses. Nothing is changed
            automatically.
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRunning}
            onClick={() =>
              entityType === "person"
                ? runPerson.mutate({ id: entityId })
                : runOrganization.mutate({ id: entityId })
            }
            data-testid={`${entityType}-run-enrichment`}
          >
            {isRunning ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            Check CRM suggestions
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-sky-200 bg-sky-50/70 p-3 text-sm dark:border-sky-900/60 dark:bg-sky-950/20"
      data-testid={`${entityType}-region-suggestion`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-sky-300">
          Suggested
        </Badge>
        <span className="font-medium">{suggestion.suggestedValue.label}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        From {suggestion.sourceLabel}
        {suggestion.sourceDetail ? ` · ${suggestion.sourceDetail}` : ""}. No
        external lookup was used.
      </p>
      {suggestion.viewerCanResolve ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                id: suggestion.id,
                data: { status: "accepted" },
              })
            }
            data-testid={`${entityType}-accept-enrichment`}
          >
            Accept
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                id: suggestion.id,
                data: { status: "dismissed" },
              })
            }
            data-testid={`${entityType}-dismiss-enrichment`}
          >
            Dismiss
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          The record owner or an admin must approve this suggestion.
        </p>
      )}
    </div>
  );
}
