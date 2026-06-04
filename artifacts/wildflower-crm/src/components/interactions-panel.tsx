import {
  useListInteractions,
  type Interaction,
  type InteractionKind,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";

const KIND_LABEL: Record<InteractionKind, string> = {
  meeting: "Meeting",
  phone_call: "Phone call",
  video_call: "Video call",
  conference: "Conference",
  other: "Other",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface Props {
  personId?: string;
  organizationId?: string;
  householdId?: string;
}

export function InteractionsPanel({ personId, organizationId, householdId }: Props) {
  // List endpoint scopes by exactly one of these. Detail pages pass the
  // one that matches their entity.
  const { data, isLoading } = useListInteractions({
    personId,
    organizationId,
    householdId,
    limit: 25,
  });
  const rows: Interaction[] = data?.data ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Interactions</CardTitle>
        <LogInteractionDialog
          prefillPersonId={personId}
          prefillFunderId={organizationId}
          prefillHouseholdId={householdId}
          compact
        />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No interactions yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li
                key={r.id}
                className="border rounded-md p-3 text-sm space-y-1"
                data-testid={`interaction-row-${r.id}`}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{KIND_LABEL[r.kind]}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatWhen(r.occurredAt)}
                  </span>
                  {r.durationMinutes ? (
                    <span className="text-xs text-muted-foreground">
                      · {r.durationMinutes} min
                    </span>
                  ) : null}
                </div>
                <div className="font-medium">{r.summary}</div>
                {r.location ? (
                  <div className="text-xs text-muted-foreground">
                    {r.location}
                  </div>
                ) : null}
                {r.notes ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {r.notes}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
