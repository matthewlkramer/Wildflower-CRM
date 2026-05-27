import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateTask,
  getListTasksQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2 } from "lucide-react";
import { InlineEditUserPicker } from "@/components/user-picker";

type DraftRow = {
  key: string;
  title: string;
  dueDate: string;
  assigneeUserId: string | null;
};

function newDraft(): DraftRow {
  return {
    key: Math.random().toString(36).slice(2),
    title: "",
    dueDate: "",
    assigneeUserId: null,
  };
}

export function ReportingDeadlinesDialog({
  opportunityId,
  funderName,
  open,
  onOpenChange,
}: {
  opportunityId: string;
  funderName?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [rows, setRows] = useState<DraftRow[]>([
    { ...newDraft(), title: "Interim report" },
    { ...newDraft(), title: "Final report" },
  ]);
  const createMut = useCreateTask();

  function update(key: string, patch: Partial<DraftRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function save() {
    const valid = rows.filter((r) => r.title.trim().length > 0);
    if (valid.length === 0) {
      toast({
        title: "Nothing to save",
        description: "Add at least one deadline with a title.",
        variant: "destructive",
      });
      return;
    }
    try {
      // Sequential so a partial failure surfaces the bad row rather
      // than racing and getting a confusing aggregate error.
      for (const r of valid) {
        const data: Parameters<typeof createMut.mutateAsync>[0]["data"] = {
          title: r.title.trim(),
          kind: "reporting_deadline",
          status: "open",
          opportunityIds: [opportunityId],
        };
        if (r.dueDate) data.dueDate = r.dueDate;
        if (r.assigneeUserId) data.assigneeUserId = r.assigneeUserId;
        if (funderName) data.description = `Reporting deadline for ${funderName}`;
        await createMut.mutateAsync({ data });
      }
      await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
      toast({ title: `Saved ${valid.length} reporting deadline${valid.length === 1 ? "" : "s"}` });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add reporting deadlines</DialogTitle>
          <DialogDescription>
            This grant just became reportable. Capture each deadline now so
            nothing slips. Each row becomes a task linked to this opportunity.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {rows.map((r, idx) => (
            <div
              key={r.key}
              className="grid grid-cols-12 gap-2 items-end border rounded-md p-3"
              data-testid={`reporting-deadline-row-${idx}`}
            >
              <div className="col-span-5 space-y-1">
                <Label htmlFor={`title-${r.key}`}>Description</Label>
                <Input
                  id={`title-${r.key}`}
                  value={r.title}
                  onChange={(e) => update(r.key, { title: e.target.value })}
                  placeholder="e.g. Interim report"
                  data-testid={`input-deadline-title-${idx}`}
                />
              </div>
              <div className="col-span-3 space-y-1">
                <Label htmlFor={`due-${r.key}`}>Due date</Label>
                <Input
                  id={`due-${r.key}`}
                  type="date"
                  value={r.dueDate}
                  onChange={(e) => update(r.key, { dueDate: e.target.value })}
                  data-testid={`input-deadline-due-${idx}`}
                />
              </div>
              <div className="col-span-3 space-y-1">
                <Label>Assignee</Label>
                <InlineEditUserPicker
                  testIdBase={`deadline-assignee-${idx}`}
                  value={r.assigneeUserId}
                  display={
                    <span className="text-sm text-muted-foreground">
                      {r.assigneeUserId ? "Assigned" : "Unassigned"}
                    </span>
                  }
                  onSave={(next) => {
                    update(r.key, { assigneeUserId: next });
                    return Promise.resolve();
                  }}
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  data-testid={`button-remove-deadline-${idx}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRows((rs) => [...rs, newDraft()])}
            data-testid="button-add-deadline-row"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add another deadline
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Skip for now
          </Button>
          <Button
            onClick={save}
            disabled={createMut.isPending}
            data-testid="button-save-reporting-deadlines"
          >
            {createMut.isPending ? "Saving…" : "Save deadlines"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
