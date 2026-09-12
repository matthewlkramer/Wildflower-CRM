import { useState, type FormEvent } from "react";
import { useFlagForResearch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function CleanupWorkItemForm({ onCreated }: { onCreated: () => void }) {
  const mutation = useFlagForResearch();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        data: {
          targetType: "work_item",
          targetId: requestId,
          note: [title.trim(), note.trim()].filter(Boolean).join("\n\n"),
        },
      });
      setOpen(false);
      setTitle("");
      setNote("");
      setRequestId(crypto.randomUUID());
      onCreated();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not add cleanup project.",
      );
    }
  }
  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Add cleanup project
      </Button>
    );
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <div>
        <Label htmlFor="cleanup-project-title">What needs to get done?</Label>
        <Input
          id="cleanup-project-title"
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="cleanup-project-note">
          Next steps and working notes
        </Label>
        <Textarea
          id="cleanup-project-note"
          rows={5}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What is needed, who is following up, when to check back, and links to source files"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={mutation.isPending || !title.trim()}>
          Add project
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
