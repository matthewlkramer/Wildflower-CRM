import { useState, type ReactNode } from "react";
import {
  useListTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  getListTasksQueryKey,
  type Task,
  type TaskStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Trash2, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EntityLinksEditor,
  EMPTY_LINKS,
  MentionsPicker,
  type EntityLinks,
} from "@/components/entity-links-editor";
import {
  useListUsers,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import { useUserNameMap, userDisplayName } from "@/components/user-picker";

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_VARIANT: Record<TaskStatus, "default" | "secondary" | "outline"> = {
  open: "default",
  waiting: "secondary",
  done: "outline",
  cancelled: "outline",
};

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

interface PanelContext {
  personId?: string;
  organizationId?: string;
  householdId?: string;
  opportunityId?: string;
  giftId?: string;
  /** Additional IDs to pre-fill (checked but removable) when the dialog opens. */
  defaultLinks?: Partial<EntityLinks>;
}

export function TasksPanel(ctx: PanelContext) {
  const { data, isLoading } = useListTasks({
    personId: ctx.personId,
    organizationId: ctx.organizationId,
    householdId: ctx.householdId,
    opportunityId: ctx.opportunityId,
    giftId: ctx.giftId,
    limit: 50,
  });
  const rows: Task[] = data?.data ?? [];
  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
      },
    },
  });
  const del = useDeleteTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        toast({ title: "Task deleted" });
      },
    },
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Tasks</CardTitle>
        <AddTaskDialog ctx={ctx} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((t) => (
              <li
                key={t.id}
                className="border rounded-md p-3 text-sm space-y-1"
                data-testid={`task-row-${t.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={STATUS_VARIANT[t.status]}>
                      {STATUS_LABEL[t.status]}
                    </Badge>
                    <span className="font-medium truncate">{t.title}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Select
                      value={t.status}
                      onValueChange={(v) =>
                        update.mutate({ id: t.id, data: { status: v as TaskStatus } })
                      }
                    >
                      <SelectTrigger
                        className="h-7 w-[110px] text-xs"
                        data-testid={`select-task-status-${t.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {t.status !== "done" ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={() => update.mutate({ id: t.id, data: { status: "done" } })}
                        aria-label="Mark done"
                        data-testid={`button-task-done-${t.id}`}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => del.mutate({ id: t.id })}
                      aria-label="Delete task"
                      data-testid={`button-delete-task-${t.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Due {formatDate(t.dueDate)}
                  {t.assigneeUserId ? (
                    <> · Assigned to {userMap.get(t.assigneeUserId) ?? t.assigneeUserId}</>
                  ) : null}
                </div>
                {t.description ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">{t.description}</p>
                ) : null}
                {t.mentionUserIds && t.mentionUserIds.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Mentions:{" "}
                    {t.mentionUserIds
                      .map((id) => `@${userMap.get(id) ?? id}`)
                      .join(", ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function AddTaskDialog({
  ctx,
  trigger,
}: {
  ctx: PanelContext;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [links, setLinks] = useState<EntityLinks>(() => linksFromDefault(ctx.defaultLinks));
  const [mentions, setMentions] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: users } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });
  const userOpts = (users ?? []).map((u) => ({ id: u.id, label: userDisplayName(u) }));
  const create = useCreateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        toast({ title: "Task created" });
        setOpen(false);
        setTitle("");
        setDescription("");
        setDueDate("");
        setAssigneeUserId("");
        setLinks(linksFromDefault(ctx.defaultLinks));
        setMentions([]);
      },
      onError: (err: unknown) => {
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const pinned = pinnedFromCtx(ctx);
  const canSubmit = title.trim().length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) {
          if (v) setLinks(linksFromDefault(ctx.defaultLinks));
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" data-testid="button-add-task">
            Add task
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
          <DialogDescription>
            Create a task and link it to one or more records.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            create.mutate({
              data: {
                title: title.trim(),
                description: description.trim() || undefined,
                dueDate: dueDate || undefined,
                assigneeUserId: assigneeUserId || undefined,
                personIds: mergeLinks(pinned.personIds, links.personIds),
                organizationIds: mergeLinks(pinned.organizationIds, links.organizationIds),
                householdIds: mergeLinks(pinned.householdIds, links.householdIds),
                opportunityIds: mergeLinks(pinned.opportunityIds, links.opportunityIds),
                giftIds: mergeLinks(pinned.giftIds, links.giftIds),
                mentionUserIds: mentions.length > 0 ? mentions : undefined,
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              data-testid="input-task-title"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="input-task-due"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-assignee">Assignee</Label>
              <AssigneeCombobox
                value={assigneeUserId}
                onChange={setAssigneeUserId}
                users={userOpts}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="input-task-description"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Linked records</Label>
            <EntityLinksEditor value={links} onChange={setLinks} pinned={pinned} />
          </div>
          <div className="space-y-1.5">
            <Label>Mentions</Label>
            <MentionsPicker value={mentions} onChange={setMentions} users={userOpts} />
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
              data-testid="button-save-task"
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssigneeCombobox({
  value,
  onChange,
  users,
}: {
  value: string;
  onChange: (next: string) => void;
  users: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Reset the search filter whenever the popover closes so reopening starts fresh.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? users.filter((u) => u.label.toLowerCase().includes(trimmed))
    : users;
  const selected = value ? users.find((u) => u.id === value) : undefined;
  const triggerLabel = value ? (selected?.label ?? value) : "Unassigned";
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id="task-assignee"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-testid="select-task-assignee"
          className="h-9 w-full justify-between font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[220px]"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search people…"
            data-testid="select-task-assignee-search"
          />
          <CommandList>
            {filtered.length === 0 ? (
              <CommandEmpty>No results.</CommandEmpty>
            ) : null}
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => {
                  onChange("");
                  handleOpenChange(false);
                }}
                data-testid="select-task-assignee-option-none"
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === "" ? "opacity-100" : "opacity-0",
                  )}
                />
                Unassigned
              </CommandItem>
              {filtered.map((u) => (
                <CommandItem
                  key={u.id}
                  value={u.id}
                  onSelect={() => {
                    onChange(u.id);
                    handleOpenChange(false);
                  }}
                  data-testid={`select-task-assignee-option-${u.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === u.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{u.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function pinnedFromCtx(ctx: PanelContext): EntityLinks {
  return {
    personIds: ctx.personId ? [ctx.personId] : [],
    organizationIds: ctx.organizationId ? [ctx.organizationId] : [],
    householdIds: ctx.householdId ? [ctx.householdId] : [],
    opportunityIds: ctx.opportunityId ? [ctx.opportunityId] : [],
    giftIds: ctx.giftId ? [ctx.giftId] : [],
  };
}

function mergeLinks(pinned: string[], user: string[]): string[] | undefined {
  const merged = Array.from(new Set([...pinned, ...user]));
  return merged.length > 0 ? merged : undefined;
}

function linksFromDefault(defaultLinks?: Partial<EntityLinks>): EntityLinks {
  if (!defaultLinks) return EMPTY_LINKS;
  return {
    personIds: defaultLinks.personIds ?? [],
    organizationIds: defaultLinks.organizationIds ?? [],
    householdIds: defaultLinks.householdIds ?? [],
    opportunityIds: defaultLinks.opportunityIds ?? [],
    giftIds: defaultLinks.giftIds ?? [],
  };
}
