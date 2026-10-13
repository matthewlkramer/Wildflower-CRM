import { useState } from "react";
import {
  useCreateInteraction,
  useUpdateInteraction,
  type Interaction,
  getListInteractionsQueryKey,
  type InteractionKind,
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
import { Textarea } from "@/components/ui/textarea";
import {
  EMPTY_LINKS,
  EntityLinksEditor,
  type EntityLinks,
} from "@/components/entity-links-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Pencil, MessageSquare } from "lucide-react";

const KIND_OPTIONS: { value: InteractionKind; label: string }[] = [
  { value: "meeting", label: "Meeting" },
  { value: "phone_call", label: "Phone call" },
  { value: "video_call", label: "Video call" },
  { value: "conference", label: "Conference" },
  { value: "other", label: "Other" },
];

interface Props {
  interaction?: Interaction;
  // Pre-fill exactly one of these so the dialog can be triggered from a
  // detail page and the interaction is automatically linked to that
  // entity. A global trigger requires the user to choose at least one link.
  prefillPersonId?: string;
  prefillFunderId?: string;
  prefillHouseholdId?: string;
  triggerLabel?: string;
  // When true, render only a compact "Log interaction" outline button
  // suitable for the detail-page panel header.
  compact?: boolean;
}

// `datetime-local` inputs need a value formatted as `YYYY-MM-DDTHH:mm`
// in *local* time. `Date#toISOString` is UTC, which would silently shift
// the field on submit — so derive the default from getters instead.
function nowForDatetimeLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LogInteractionDialog({
  prefillPersonId,
  prefillFunderId,
  prefillHouseholdId,
  triggerLabel,
  compact,
  interaction,
}: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<InteractionKind>("meeting");
  const [occurredAt, setOccurredAt] = useState(nowForDatetimeLocal());
  const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState("");
  const [duration, setDuration] = useState("");
  const [location, setLocation] = useState("");
  const [links, setLinks] = useState<EntityLinks>({ ...EMPTY_LINKS });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateInteraction();
  const create = useCreateInteraction({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListInteractionsQueryKey(),
        });
        toast({ title: "Interaction logged" });
        setOpen(false);
        setSummary("");
        setNotes("");
        setDuration("");
        setLocation("");
        setLinks({ ...EMPTY_LINKS });
        setOccurredAt(nowForDatetimeLocal());
      },
      onError: (err: unknown) => {
        toast({
          title: "Log failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const pinned: Partial<EntityLinks> = {
    personIds: prefillPersonId ? [prefillPersonId] : [],
    organizationIds: prefillFunderId ? [prefillFunderId] : [],
    householdIds: prefillHouseholdId ? [prefillHouseholdId] : [],
  };
  const hasRelationship =
    !!prefillPersonId ||
    !!prefillFunderId ||
    !!prefillHouseholdId ||
    links.personIds.length > 0 ||
    links.organizationIds.length > 0 ||
    links.householdIds.length > 0;
  const canSubmit =
    summary.trim().length > 0 && occurredAt.length > 0 && hasRelationship;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!(create.isPending || update.isPending)) {
          if (v && interaction) {
            setKind(interaction.kind);
            setSummary(interaction.summary);
            setNotes(interaction.notes ?? "");
            setLocation(interaction.location ?? "");
            setDuration(interaction.durationMinutes?.toString() ?? "");
            const d = new Date(interaction.occurredAt);
            setOccurredAt(
              new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16),
            );
            setLinks({
              ...EMPTY_LINKS,
              personIds: interaction.personIds ?? [],
              organizationIds: interaction.organizationIds ?? [],
              householdIds: interaction.householdIds ?? [],
            });
          } else if (v) setLinks({ ...EMPTY_LINKS });
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={compact ? "outline" : "default"}
          data-testid={
            interaction
              ? `button-edit-interaction-${interaction.id}`
              : "button-log-interaction"
          }
          aria-label={interaction ? "Edit interaction" : "Log interaction"}
          className={compact ? "px-2 sm:px-3" : undefined}
          size={interaction ? "icon" : compact ? "sm" : "default"}
        >
          {interaction ? (
            <Pencil className="h-3.5 w-3.5" />
          ) : compact ? (
            <>
              <MessageSquare className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">
                {triggerLabel ?? "Log interaction"}
              </span>
            </>
          ) : (
            (triggerLabel ?? "Log interaction")
          )}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {interaction ? "Edit interaction" : "Log interaction"}
          </DialogTitle>
          <DialogDescription>
            Record a meeting, call, or other touchpoint. It will show up on
            every linked person, funder, and household.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            // Local-time string from the datetime-local input → ISO so the
            // server stores a proper timestamptz.
            const isoOccurredAt = new Date(occurredAt).toISOString();
            const trimmedDuration = duration.trim();
            const data = {
              kind,
              occurredAt: isoOccurredAt,
              summary: summary.trim(),
              notes: notes.trim() || (interaction ? null : undefined),
              location: location.trim() || (interaction ? null : undefined),
              durationMinutes: trimmedDuration
                ? Number(trimmedDuration)
                : interaction
                  ? null
                  : undefined,
              personIds: [
                ...(prefillPersonId ? [prefillPersonId] : []),
                ...links.personIds,
              ],
              organizationIds: [
                ...(prefillFunderId ? [prefillFunderId] : []),
                ...links.organizationIds,
              ],
              householdIds: [
                ...(prefillHouseholdId ? [prefillHouseholdId] : []),
                ...links.householdIds,
              ],
            };
            if (interaction) {
              update.mutate(
                { id: interaction.id, data },
                {
                  onSuccess: async () => {
                    await Promise.all([
                      queryClient.invalidateQueries({
                        queryKey: getListInteractionsQueryKey(),
                      }),
                      queryClient.invalidateQueries({
                        queryKey: ["/api/people"],
                      }),
                    ]);
                    setOpen(false);
                    toast({ title: "Interaction updated" });
                  },
                  onError: (error) =>
                    toast({
                      title: "Save failed",
                      description: error.message,
                      variant: "destructive",
                    }),
                },
              );
            } else
              create.mutate({
                data: {
                  ...data,
                  notes: data.notes ?? undefined,
                  location: data.location ?? undefined,
                  durationMinutes: data.durationMinutes ?? undefined,
                },
              });
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="interaction-kind">Kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as InteractionKind)}
              >
                <SelectTrigger
                  id="interaction-kind"
                  data-testid="select-interaction-kind"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="interaction-when">When</Label>
              <Input
                id="interaction-when"
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                data-testid="input-interaction-when"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interaction-summary">Summary</Label>
            <Input
              id="interaction-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Coffee with Jane re: capacity"
              autoFocus
              data-testid="input-interaction-summary"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="interaction-duration">Duration (min)</Label>
              <Input
                id="interaction-duration"
                type="number"
                min={0}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                data-testid="input-interaction-duration"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="interaction-location">Location</Label>
              <Input
                id="interaction-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                data-testid="input-interaction-location"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interaction-notes">Notes</Label>
            <Textarea
              id="interaction-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              data-testid="input-interaction-notes"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Linked records</Label>
            <EntityLinksEditor
              value={links}
              onChange={setLinks}
              pinned={pinned}
              allowedTypes={["person", "organization", "household"]}
            />
            {!hasRelationship ? (
              <p className="text-xs text-muted-foreground">
                Link at least one person, organization, or household so the
                interaction appears in its activity feed.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={create.isPending || update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || create.isPending || update.isPending}
              data-testid="button-create-interaction"
            >
              {create.isPending || update.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
