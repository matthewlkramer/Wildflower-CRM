import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPersonConferenceAttendance,
  useListConferenceEvents,
  useCreateConferenceAttendance,
  getListPersonConferenceAttendanceQueryKey,
  getListConferenceAttendanceQueryKey,
  getListConferenceEventsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus } from "lucide-react";

export function RecordConferenceAttendance({ personId }: { personId: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const events = useListConferenceEvents(undefined, {
    query: { enabled: open, queryKey: getListConferenceEventsQueryKey() },
  });
  const existing = useListPersonConferenceAttendance(personId);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateConferenceAttendance();
  async function record(id: string, label: string) {
    try {
      const previous = existing.data?.find(
        (row) => row.conferenceEventId === id,
      );
      await create.mutateAsync({
        id,
        data: {
          personId,
          status: "confirmed",
          sourceType: previous?.sourceType ?? "manual",
          sourceReference: previous?.sourceReference ?? label,
          role: previous?.role,
          evidenceNote: previous?.evidenceNote,
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getListPersonConferenceAttendanceQueryKey(personId),
        }),
        queryClient.invalidateQueries({
          queryKey: getListConferenceAttendanceQueryKey(id),
        }),
        queryClient.invalidateQueries({
          queryKey: getListConferenceEventsQueryKey(),
        }),
      ]);
      toast({ title: "Conference attendance recorded" });
      setOpen(false);
    } catch (error) {
      toast({
        title: "Attendance could not be saved",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) {
          setOpen(next);
          if (next) setSearch("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Record conference attendance"
        >
          <Plus className="h-4 w-4 mr-1" />
          Record attendance
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record conference attendance</DialogTitle>
          <DialogDescription>
            Choose a conference this person attended. An existing record is
            updated, without adding a duplicate.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conferences…"
          aria-label="Search conferences"
        />
        <div className="max-h-[50vh] overflow-auto space-y-2">
          {events.isLoading && <p>Loading conferences…</p>}
          {events.isError && (
            <p role="alert">Conferences could not be loaded.</p>
          )}
          {(events.data ?? [])
            .filter((event) =>
              `${event.nameOverride ?? event.conferenceTypeName} ${event.year}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((event) => {
              const label = `${event.nameOverride ?? event.conferenceTypeName} ${event.year}`;
              const recorded = existing.data?.some(
                (row) =>
                  row.conferenceEventId === event.id &&
                  row.status === "confirmed",
              );
              return (
                <Button
                  key={event.id}
                  variant="outline"
                  className="w-full justify-between whitespace-normal text-left"
                  disabled={
                    create.isPending ||
                    existing.isLoading ||
                    recorded ||
                    event.status === "cancelled"
                  }
                  onClick={() => void record(event.id, label)}
                >
                  <span>{label}</span>
                  {recorded && (
                    <span className="ml-2 text-xs">Already recorded</span>
                  )}
                  {event.status === "cancelled" && (
                    <span className="ml-2 text-xs">Cancelled</span>
                  )}
                </Button>
              );
            })}
          {events.data?.length === 0 && <p>No conferences available.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
