import { useState } from "react";
import {
  useCreateInteraction,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const KIND_OPTIONS: { value: InteractionKind; label: string }[] = [
  { value: "meeting", label: "Meeting" },
  { value: "phone_call", label: "Phone call" },
  { value: "video_call", label: "Video call" },
  { value: "conference", label: "Conference" },
  { value: "other", label: "Other" },
];

interface Props {
  // Pre-fill exactly one of these so the dialog can be triggered from a
  // detail page and the interaction is automatically linked to that
  // entity. Leaving them all undefined gives an unattached interaction.
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
}: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<InteractionKind>("meeting");
  const [occurredAt, setOccurredAt] = useState(nowForDatetimeLocal());
  const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState("");
  const [duration, setDuration] = useState("");
  const [location, setLocation] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
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

  const canSubmit = summary.trim().length > 0 && occurredAt.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size={compact ? "sm" : "default"}
          variant={compact ? "outline" : "default"}
          data-testid="button-log-interaction"
        >
          {triggerLabel ?? "Log interaction"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log interaction</DialogTitle>
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
            create.mutate({
              data: {
                kind,
                occurredAt: isoOccurredAt,
                summary: summary.trim(),
                notes: notes.trim() || undefined,
                location: location.trim() || undefined,
                durationMinutes: trimmedDuration
                  ? Number(trimmedDuration)
                  : undefined,
                personIds: prefillPersonId ? [prefillPersonId] : undefined,
                funderIds: prefillFunderId ? [prefillFunderId] : undefined,
                householdIds: prefillHouseholdId
                  ? [prefillHouseholdId]
                  : undefined,
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
                <SelectTrigger id="interaction-kind" data-testid="select-interaction-kind">
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
              disabled={!canSubmit || create.isPending}
              data-testid="button-create-interaction"
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
