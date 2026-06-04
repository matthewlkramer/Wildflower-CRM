import { useState } from "react";
import {
  useListNotes,
  useCreateNote,
  useDeleteNote,
  getListNotesQueryKey,
  type Note,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Trash2 } from "lucide-react";
import {
  EntityLinksEditor,
  EMPTY_LINKS,
  MentionsPicker,
  type EntityLinks,
} from "@/components/entity-links-editor";
import { useUserNameMap, userDisplayName } from "@/components/user-picker";
import {
  useListUsers,
  getListUsersQueryKey,
} from "@workspace/api-client-react";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface PanelContext {
  personId?: string;
  funderId?: string;
  householdId?: string;
  opportunityId?: string;
  giftId?: string;
  /** Additional IDs to pre-fill (checked but removable) when the dialog opens. */
  defaultLinks?: Partial<EntityLinks>;
}

export function NotesPanel(ctx: PanelContext) {
  const { data, isLoading } = useListNotes({
    personId: ctx.personId,
    funderId: ctx.funderId,
    householdId: ctx.householdId,
    opportunityId: ctx.opportunityId,
    giftId: ctx.giftId,
    limit: 50,
  });
  const rows: Note[] = data?.data ?? [];
  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() });
        toast({ title: "Note deleted" });
      },
    },
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Notes</CardTitle>
        <AddNoteDialog ctx={ctx} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((n) => (
              <li
                key={n.id}
                className="border rounded-md p-3 text-sm space-y-1"
                data-testid={`note-row-${n.id}`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    {userMap.get(n.authorUserId) ?? n.authorUserId} ·{" "}
                    {formatWhen(n.createdAt)}
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => del.mutate({ id: n.id })}
                    disabled={del.isPending}
                    aria-label="Delete note"
                    data-testid={`button-delete-note-${n.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="whitespace-pre-wrap">{n.body}</p>
                {n.mentionUserIds && n.mentionUserIds.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Mentions:{" "}
                    {n.mentionUserIds
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

export function AddNoteDialog({ ctx }: { ctx: PanelContext }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [links, setLinks] = useState<EntityLinks>(() => linksFromDefault(ctx.defaultLinks));
  const [mentions, setMentions] = useState<string[]>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: users } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });
  const userOpts = (users ?? []).map((u) => ({ id: u.id, label: userDisplayName(u) }));
  const create = useCreateNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() });
        toast({ title: "Note saved" });
        setOpen(false);
        setBody("");
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
  const canSubmit = body.trim().length > 0;
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
        <Button size="sm" variant="outline" data-testid="button-add-note">
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add note</DialogTitle>
          <DialogDescription>
            Capture a quick note. Link it to one or more records so it shows up
            on each.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            create.mutate({
              data: {
                body: body.trim(),
                personIds: mergeLinks(pinned.personIds, links.personIds),
                funderIds: mergeLinks(pinned.funderIds, links.funderIds),
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
            <Label htmlFor="note-body">Note</Label>
            <Textarea
              id="note-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              autoFocus
              data-testid="input-note-body"
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
              data-testid="button-save-note"
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function pinnedFromCtx(ctx: PanelContext): EntityLinks {
  return {
    personIds: ctx.personId ? [ctx.personId] : [],
    funderIds: ctx.funderId ? [ctx.funderId] : [],
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
    funderIds: defaultLinks.funderIds ?? [],
    householdIds: defaultLinks.householdIds ?? [],
    opportunityIds: defaultLinks.opportunityIds ?? [],
    giftIds: defaultLinks.giftIds ?? [],
  };
}
