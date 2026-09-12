import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNewsletterPreferences,
  useCreateNewsletterPreferenceEvent,
  getListNewsletterPreferencesQueryKey,
  getGetPersonQueryKey,
  getListPeopleQueryKey,
  useGetCurrentUser,
  type CreateNewsletterPreferenceEventBody,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const EVENT_LABELS: Record<string, string> = {
  consent_given: "Affirmative consent",
  staff_added: "Added by staff",
  staff_removed: "Removed by staff",
  opted_out: "Opt-out / unsubscribe evidence",
  legacy_selected: "Historical audience membership",
  legacy_opted_out: "Historical unsubscribe",
};

export function NewsletterPreferencesCard({ personId }: { personId: string }) {
  const query = useListNewsletterPreferences(personId);
  const viewer = useGetCurrentUser();
  const client = useQueryClient();
  const create = useCreateNewsletterPreferenceEvent();
  const [editing, setEditing] = useState(false);
  const [eventType, setEventType] =
    useState<CreateNewsletterPreferenceEventBody["eventType"]>("staff_added");
  const [occurredAt, setOccurredAt] = useState("");
  const [source, setSource] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [evidence, setEvidence] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  if (query.isLoading)
    return (
      <p className="text-sm text-muted-foreground">
        Loading newsletter preferences…
      </p>
    );
  if (query.isError || !query.data)
    return (
      <div role="alert">
        Newsletter history could not be loaded.{" "}
        <Button variant="ghost" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  const { data: events, newsletter, unsubscribedToNewsletter } = query.data;
  const status = unsubscribedToNewsletter
    ? "Opted out"
    : newsletter
      ? "Selected for newsletter"
      : "Not selected";
  const hasConsent = events.some(
    (event) => event.eventType === "consent_given",
  );
  const hadOptOut = events.some(
    (event) =>
      event.eventType === "opted_out" || event.eventType === "legacy_opted_out",
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        id: personId,
        data: {
          eventType,
          occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
          source: source.trim(),
          sourceUrl: sourceUrl.trim() || null,
          evidence: evidence.trim(),
          requestId,
        },
      });
      await Promise.all([
        client.invalidateQueries({
          queryKey: getListNewsletterPreferencesQueryKey(personId),
        }),
        client.invalidateQueries({ queryKey: getGetPersonQueryKey(personId) }),
        client.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
      ]);
      setEditing(false);
      setEvidence("");
      setSource("");
      setSourceUrl("");
      setOccurredAt("");
      setRequestId(crypto.randomUUID());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not record preference.",
      );
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium" data-testid="newsletter-current-status">
        {status}
      </p>
      <p className="text-xs text-muted-foreground">
        Affirmative consent:{" "}
        {hasConsent ? "evidence recorded" : "no evidence recorded"}. Previous
        opt-out: {hadOptOut ? "evidence recorded" : "no evidence recorded"}.
      </p>
      <p className="text-xs text-muted-foreground">
        Staff additions select an audience; they do not establish consent. Only
        later affirmative consent can lift an opt-out. Delivery also depends on
        a usable email and Flodesk status.
      </p>
      {viewer.data && viewer.data.role !== "read_only" && !editing ? (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Record preference evidence
        </Button>
      ) : null}
      {editing ? (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="newsletter-event-type">What happened?</Label>
            <select
              id="newsletter-event-type"
              className="w-full rounded border bg-background p-2"
              value={eventType}
              onChange={(e) => setEventType(e.target.value as typeof eventType)}
            >
              {(
                [
                  "staff_added",
                  "staff_removed",
                  "consent_given",
                  "opted_out",
                ] as const
              ).map((type) => (
                <option key={type} value={type}>
                  {EVENT_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="newsletter-event-date">
              When it happened (if known)
            </Label>
            <Input
              id="newsletter-event-date"
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use the event date from the source. Blank preserves an unknown
              date. Undated consent cannot lift an opt-out.
            </p>
          </div>
          <div>
            <Label htmlFor="newsletter-event-source">Source / method</Label>
            <Input
              id="newsletter-event-source"
              required
              maxLength={200}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. donor email, phone request, staff decision"
            />
          </div>
          <div>
            <Label htmlFor="newsletter-event-evidence">Evidence</Label>
            <Textarea
              id="newsletter-event-evidence"
              required
              maxLength={4000}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="What was requested or decided, and how you know"
            />
          </div>
          <div>
            <Label htmlFor="newsletter-event-link">
              Source link (optional)
            </Label>
            <Input
              id="newsletter-event-link"
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={create.isPending}>
              Save evidence
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={create.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <details>
        <summary className="cursor-pointer">
          Preference history ({events.length})
        </summary>
        {events.length ? (
          <ol className="mt-2 space-y-3">
            {events.map((event) => (
              <li key={event.id} className="border-t pt-2">
                <p className="font-medium">
                  {EVENT_LABELS[event.eventType] ?? event.eventType}
                </p>
                <p>
                  {event.occurredAt
                    ? new Date(event.occurredAt).toLocaleString()
                    : "Event date unknown"}{" "}
                  · {event.source}
                </p>
                <p className="whitespace-pre-wrap text-xs">{event.evidence}</p>
                {event.sourceUrl && /^https?:\/\//i.test(event.sourceUrl) ? (
                  <a
                    className="text-primary underline"
                    href={event.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View source
                  </a>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Recorded {new Date(event.recordedAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-muted-foreground">
            No preference evidence recorded.
          </p>
        )}
      </details>
    </div>
  );
}
