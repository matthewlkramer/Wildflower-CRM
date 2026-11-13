import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  getListDueOpportunityFollowUpsQueryKey, getListOpportunityFollowUpsQueryKey,
  useCreateOpportunityFollowUp, useGetCurrentUser, useListDueOpportunityFollowUps,
  useListOpportunityFollowUps, useListUsers, useUpdateOpportunityFollowUp,
  type OpportunityFollowUp, type OpportunityMeetingSuggestion, type SaveOpportunityFollowUpBody,
  type UpdateOpportunityFollowUpBody,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmailDetailDialog } from "@/components/email-detail-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import { useUserNameMap } from "@/components/user-picker";

const headings = { ours: "Our next step", waiting: "Waiting for", shared: "Already shared" } as const;
const statusLabel = { open: "Open", sent: "Sent", shared: "Shared", blocked: "After we send", waiting: "Waiting", due: "Check-in due", resolved: "Resolved" } as const;
const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function FollowUpEditor({ initial, items, onClose, onSave, pending, editing }: {
  initial: SaveOpportunityFollowUpBody;
  items: OpportunityFollowUp[];
  onClose: () => void;
  onSave: (value: SaveOpportunityFollowUpBody) => Promise<unknown>;
  pending: boolean;
  editing: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const { data: users } = useListUsers();
  const update = (patch: Partial<SaveOpportunityFollowUpBody>) => setValue((current) => ({ ...current, ...patch }));
  const isWaiting = value.kind === "waiting";
  const dependency = items.find((item) => item.id === value.dependencyId);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit follow-up" : "Track follow-up"}</DialogTitle>
          <DialogDescription>Keep the owner, evidence, and status with this opportunity.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try { await onSave(value); onClose(); }
          catch (err) { setError(err instanceof Error ? err.message : "The follow-up could not be saved."); }
        }}>
          <div className="space-y-1">
            <Label htmlFor="followup-kind">Type</Label>
            <select id="followup-kind" className={fieldClass} value={value.kind} disabled={editing || !!value.suggestionKey}
              onChange={(event) => update({ kind: event.target.value as SaveOpportunityFollowUpBody["kind"] })}>
              {Object.entries(headings).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="followup-title">Follow-up</Label>
            <Input id="followup-title" required maxLength={240} value={value.title} onChange={(event) => update({ title: event.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="followup-owner">{isWaiting ? "Funder owner" : value.kind === "shared" ? "Shared by" : "Owner name"}</Label>
              <Input id="followup-owner" required={isWaiting} maxLength={160} value={value.ownerName ?? ""} onChange={(event) => update({ ownerName: event.target.value || null })} />
            </div>
            {value.kind !== "shared" && <div className="space-y-1">
              <Label htmlFor="followup-point">Wildflower point person</Label>
              <select id="followup-point" className={fieldClass} value={value.pointPersonId ?? ""} onChange={(event) => update({ pointPersonId: event.target.value || null })}>
                <option value="">Opportunity owner</option>
                {users?.map((user) => <option value={user.id} key={user.id}>{user.displayName || user.email}</option>)}
              </select>
            </div>}
            {value.kind === "shared" && <div className="space-y-1">
              <Label htmlFor="followup-read">Read status</Label>
              <select id="followup-read" className={fieldClass} value={value.readStatus ?? "unknown"}
                onChange={(event) => update({ readStatus: event.target.value as SaveOpportunityFollowUpBody["readStatus"] })}>
                <option value="unknown">Unknown</option><option value="unread">Unread</option><option value="read">Read</option>
              </select>
            </div>}
          </div>
          {isWaiting && <>
            <div className="space-y-1">
              <Label htmlFor="followup-dependency">Start after we send</Label>
              <select id="followup-dependency" className={fieldClass} value={value.dependencyId ?? ""} onChange={(event) => update({ dependencyId: event.target.value || null, checkInOn: null })}>
                <option value="">No prerequisite</option>
                {items.filter((item) => item.kind === "ours").map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="followup-days">Days before checking in</Label>
                <Input id="followup-days" type="number" required min={1} max={365} value={value.checkInDays ?? 14} onChange={(event) => update({ checkInDays: Number(event.target.value), checkInOn: null })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="followup-external-due">Funder’s agreed deadline</Label>
                <Input id="followup-external-due" type="date" value={value.externalDueDate ?? ""} onChange={(event) => update({ externalDueDate: event.target.value || null })} />
              </div>
              {(!dependency || dependency.sentOn) && <div className="space-y-1">
                <Label htmlFor="followup-check-in">Internal check-in date</Label>
                <Input id="followup-check-in" type="date" value={value.checkInOn ?? ""} onChange={(event) => update({ checkInOn: event.target.value || null })} />
              </div>}
            </div>
          </>}
          <div className="space-y-1">
            <Label htmlFor="followup-source-link">Evidence link</Label>
            <Input id="followup-source-link" type="url" maxLength={1000} placeholder="https://" value={value.evidenceUrl ?? ""} onChange={(event) => update({ evidenceUrl: event.target.value || null })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="followup-source">Evidence note</Label>
            <Textarea id="followup-source" rows={3} maxLength={1500} value={value.evidenceNote ?? ""} onChange={(event) => update({ evidenceNote: event.target.value || null })} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save follow-up"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OpportunityFollowUps({ opportunityId }: { opportunityId: string }) {
  const { data, isLoading, isError } = useListOpportunityFollowUps(opportunityId);
  const { data: user } = useGetCurrentUser();
  const names = useUserNameMap();
  const { toast } = useToast();
  const query = useQueryClient();
  const [editor, setEditor] = useState<{ initial: SaveOpportunityFollowUpBody; id?: string } | null>(null);
  const [emailId, setEmailId] = useState<string | null>(null);
  const [markSent, setMarkSent] = useState<OpportunityFollowUp | null>(null);
  const [sentDate, setSentDate] = useState("");
  const writable = !!user && user.role !== "read_only";
  const refresh = async () => {
    await Promise.all([
      query.invalidateQueries({ queryKey: getListOpportunityFollowUpsQueryKey(opportunityId) }),
      query.invalidateQueries({ queryKey: getListDueOpportunityFollowUpsQueryKey() }),
      query.invalidateQueries({ predicate: ({ queryKey }) => typeof queryKey[0] === "string" && queryKey[0].endsWith("/relationship-summary") }),
    ]);
  };
  const create = useCreateOpportunityFollowUp({ mutation: { onSuccess: refresh } });
  const edit = useUpdateOpportunityFollowUp({ mutation: { onSuccess: refresh } });
  const rows = data?.items ?? [];
  const stage = (suggestion: OpportunityMeetingSuggestion) => {
    const dependency = rows.find((row) => row.kind === "ours" && row.title === suggestion.dependsOnTitle);
    setEditor({ initial: {
      kind: suggestion.kind, title: suggestion.title, ownerName: suggestion.ownerName,
      meetingNoteId: suggestion.meetingNoteId, suggestionKey: suggestion.key,
      evidenceNote: suggestion.evidence, evidenceEmailId: suggestion.evidenceEmailId,
      evidenceUrl: suggestion.evidenceUrl, readStatus: suggestion.readStatus,
      externalDueDate: suggestion.externalDueDate, dependencyId: dependency?.id,
    } });
  };
  async function setStatus(item: OpportunityFollowUp, action: NonNullable<UpdateOpportunityFollowUpBody["action"]>, date?: string) {
    try { await edit.mutateAsync({ id: item.id, data: { action, date } }); setMarkSent(null); }
    catch (error) { toast({ title: "Could not update follow-up", description: error instanceof Error ? error.message : undefined, variant: "destructive" }); }
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Opportunity follow-ups</CardTitle>
        {writable && <Button variant="outline" size="sm" onClick={() => setEditor({ initial: { kind: "ours", title: "" } })}>Add follow-up</Button>}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading follow-ups…</p>}
        {isError && <p className="text-sm text-destructive">Follow-ups could not be loaded.</p>}
        {!isLoading && !isError && !rows.length && !data?.suggestions.length && <p className="text-sm text-muted-foreground">No follow-ups tracked yet.</p>}
        {Object.entries(headings).map(([kind, heading]) => {
          const items = rows.filter((row) => row.kind === kind);
          if (!items.length) return null;
          return <section key={kind} className="space-y-2">
            <h3 className="text-sm font-semibold">{heading}</h3>
            {items.map((row) => <div key={row.id} className="space-y-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{row.title}</p><Badge variant={row.status === "due" ? "default" : "secondary"}>{statusLabel[row.status]}</Badge>
                {row.readStatus && row.readStatus !== "unknown" && <Badge variant="outline">{row.readStatus === "unread" ? "Unread" : "Read"}</Badge>}
              </div>
              {row.ownerName && <p className="text-muted-foreground">{row.ownerName}</p>}
              {row.pointPersonId && names.get(row.pointPersonId) && <p className="text-muted-foreground">Wildflower point person · {names.get(row.pointPersonId)}</p>}
              {row.sentOn && <p className="text-muted-foreground">{row.kind === "shared" ? "Shared" : "Sent"} {formatDate(row.sentOn)}</p>}
              {row.status === "blocked" && <p className="text-muted-foreground">Check-in starts when {rows.find((item) => item.id === row.dependencyId)?.title ?? "our deliverable"} is marked sent.</p>}
              {row.status === "due" && <p className="font-medium">Suggested action · Check in with {row.ownerName}</p>}
              {row.checkInOn && !row.resolvedOn && <p className="text-muted-foreground">Internal check-in {formatDate(row.checkInOn)}</p>}
              {row.externalDueDate && <p className="text-muted-foreground">Funder’s agreed deadline {formatDate(row.externalDueDate)}</p>}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {row.meetingNoteId && <Link className="text-primary underline" href={`/meetings/notes/${row.meetingNoteId}`}>Source meeting</Link>}
                {row.evidenceUrl && <a className="text-primary underline" href={row.evidenceUrl} target="_blank" rel="noreferrer">Source document</a>}
                {row.evidenceEmailId && <button className="text-primary underline" onClick={() => setEmailId(row.evidenceEmailId!)}>Source email</button>}
                {row.updateEmailId && <button className="text-primary underline" onClick={() => setEmailId(row.updateEmailId!)}>Resolution email</button>}
              </div>
              {row.evidenceNote && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Evidence note</summary><p className="mt-1 whitespace-pre-wrap">{row.evidenceNote}</p></details>}
              {writable && <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="ghost" size="sm" onClick={() => setEditor({ id: row.id, initial: row })}>Edit</Button>
                {row.status === "open" && <Button variant="outline" size="sm" onClick={() => { setSentDate(""); setMarkSent(row); }}>Mark sent</Button>}
                {row.status === "due" && <Button variant="outline" size="sm" disabled={edit.isPending} onClick={() => void setStatus(row, "checked_in")}>Record check-in</Button>}
                {row.kind === "waiting" && <Button variant="outline" size="sm" disabled={edit.isPending} onClick={() => void setStatus(row, row.resolvedOn ? "reopen" : "resolved")}>{row.resolvedOn ? "Reopen" : "Resolve"}</Button>}
              </div>}
            </div>)}
          </section>;
        })}
        {writable && !!data?.suggestions.length && <details className="border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium">Meeting suggestions ({data.suggestions.length})</summary>
          <ul className="mt-2 space-y-2">{data.suggestions.map((suggestion) => <li key={suggestion.key} className="flex items-start justify-between gap-2 rounded-md border p-2 text-sm">
            <div><p>{suggestion.title}</p><p className="text-xs text-muted-foreground">{headings[suggestion.kind]} · {suggestion.meetingTitle ?? "Meeting"}</p></div>
            <Button variant="outline" size="sm" onClick={() => stage(suggestion)}>Track</Button>
          </li>)}</ul>
        </details>}
      </CardContent>
      {editor && <FollowUpEditor initial={editor.initial} items={rows} editing={!!editor.id} pending={create.isPending || edit.isPending}
        onClose={() => setEditor(null)} onSave={(value) => editor.id
          ? edit.mutateAsync({ id: editor.id, data: { details: value } })
          : create.mutateAsync({ id: opportunityId, data: value })} />}
      {markSent && <Dialog open onOpenChange={(open) => { if (!open && !edit.isPending) setMarkSent(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark deliverable sent</DialogTitle><DialogDescription>Use the actual send date to start any linked check-ins. Leave blank for today.</DialogDescription></DialogHeader>
          <Label htmlFor="followup-sent-date">Sent date</Label>
          <Input id="followup-sent-date" type="date" value={sentDate} onChange={(event) => setSentDate(event.target.value)} />
          <DialogFooter><Button variant="outline" onClick={() => setMarkSent(null)}>Cancel</Button><Button disabled={edit.isPending} onClick={() => void setStatus(markSent, "sent", sentDate || undefined)}>Mark sent</Button></DialogFooter>
        </DialogContent>
      </Dialog>}
      {emailId && <EmailDetailDialog emailId={emailId} onClose={() => setEmailId(null)} />}
    </Card>
  );
}

export function DueOpportunityFollowUps() {
  const { data } = useListDueOpportunityFollowUps({ query: { queryKey: getListDueOpportunityFollowUpsQueryKey(), refetchInterval: 5 * 60_000 } });
  if (!data?.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Funder check-ins due</CardTitle></CardHeader>
      <CardContent><ul className="space-y-2">
        {data.map((item) => <li key={item.id} className="text-sm">
          <Link className="font-medium text-primary underline" href={`/opportunities/${item.opportunityId}`}>Check in with {item.ownerName}</Link>
          <p className="text-muted-foreground">{item.opportunityName ?? "Opportunity"} · {item.title}</p>
        </li>)}
      </ul></CardContent>
    </Card>
  );
}
