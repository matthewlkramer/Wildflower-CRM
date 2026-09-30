import { useState } from "react";
import {
  getListPeopleQueryKey,
  useAddTripVisit,
  useGetCurrentUser,
  useListPeople,
} from "@workspace/api-client-react";
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { displayPersonName } from "@/lib/visibility";

type SelectedPerson = { id: string; name: string };

export function AddPeopleToTripDialog({
  tripId,
  open,
  onOpenChange,
  onSaved,
}: {
  tripId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedPeople, setSelectedPeople] = useState<SelectedPerson[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const viewer = useGetCurrentUser().data ?? null;
  const peopleParams = {
    search: search.trim() || undefined,
    deceased: false,
    showFoundationPartners: false,
    limit: 50,
  };
  const peopleQuery = useListPeople(peopleParams, {
    query: { enabled: open, queryKey: getListPeopleQueryKey(peopleParams) },
  });
  const add = useAddTripVisit();
  const selectedIds = new Set(selectedPeople.map((person) => person.id));

  const resetAndClose = () => {
    setSearch("");
    setSelectedPeople([]);
    onOpenChange(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSearch("");
      setSelectedPeople([]);
    }
    onOpenChange(nextOpen);
  };

  const togglePerson = (person: SelectedPerson) => {
    setSelectedPeople((current) =>
      current.some((selected) => selected.id === person.id)
        ? current.filter((selected) => selected.id !== person.id)
        : [...current, person],
    );
  };

  const submit = async () => {
    if (selectedPeople.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    const failed: SelectedPerson[] = [];
    let addedCount = 0;
    try {
      // Keep the existing single-visit mutation as the authoritative write
      // boundary. Sequential requests preserve the server's rank assignment.
      for (const person of selectedPeople) {
        try {
          await add.mutateAsync({ id: tripId, data: { personId: person.id } });
          addedCount += 1;
        } catch {
          failed.push(person);
        }
      }
      if (addedCount > 0) onSaved();
      if (failed.length === 0) {
        resetAndClose();
        return;
      }
      setSelectedPeople(failed);
      toast({
        title:
          addedCount > 0
            ? `Added ${addedCount}; ${failed.length} could not be added`
            : "These people could not be added",
        description:
          "They may already be on the trip list. The remaining selections are still checked.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add people to visit</DialogTitle>
          <DialogDescription>
            Search CRM people and select everyone to add to this trip’s priority
            list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people…"
            autoFocus
          />
          {selectedPeople.length > 0 ? (
            <div
              className="flex flex-wrap gap-2"
              aria-label={`${selectedPeople.length} people selected`}
            >
              {selectedPeople.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => togglePerson(person)}
                  className="inline-flex items-center gap-1 rounded-full border bg-primary/10 px-2.5 py-1 text-xs text-primary"
                  aria-label={`Remove ${person.name}`}
                >
                  {person.name}
                  <X className="h-3 w-3" />
                </button>
              ))}
            </div>
          ) : null}
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
            {peopleQuery.isLoading ? (
              <p className="p-2 text-sm text-muted-foreground">Loading…</p>
            ) : null}
            {(peopleQuery.data?.data ?? []).map((person) => {
              const name = displayPersonName(person, viewer);
              const selected = selectedIds.has(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => togglePerson({ id: person.id, name })}
                  aria-pressed={selected}
                  data-testid={`trip-person-option-${person.id}`}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${selected ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="flex h-4 w-4 items-center justify-center"
                      aria-hidden="true"
                    >
                      {selected ? <Check className="h-4 w-4" /> : null}
                    </span>
                    {name}
                  </span>
                  {person.priority ? (
                    <Badge variant="outline">{person.priority}</Badge>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={resetAndClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            disabled={selectedPeople.length === 0 || isSubmitting}
            onClick={submit}
            data-testid="add-trip-people-submit"
          >
            {isSubmitting
              ? `Adding ${selectedPeople.length}…`
              : selectedPeople.length === 1
                ? "Add person"
                : `Add ${selectedPeople.length} people`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
