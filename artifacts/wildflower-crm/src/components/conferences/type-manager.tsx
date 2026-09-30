import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateConferenceType, useDeleteConferenceType, useMergeConferenceType, useUpdateConferenceType, type ConferenceType, type ConferenceEventSummary } from "@workspace/api-client-react";
import { Archive, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

export function conferenceError(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { message?: string; error?: string; response?: { data?: { message?: string; error?: string; details?: unknown } }; data?: { message?: string; error?: string; details?: unknown } };
    const body = value.response?.data ?? value.data;
    const details = body?.details;
    return [body?.message ?? body?.error ?? value.message ?? value.error, details && typeof details === "object" ? JSON.stringify(details) : null].filter(Boolean).join(" — ") || "The request could not be completed.";
  }
  return "The request could not be completed.";
}

type Form = { displayName: string; aliases: string; organizer: string; websiteUrl: string; notes: string; active: boolean };
const blank: Form = { displayName: "", aliases: "", organizer: "", websiteUrl: "", notes: "", active: true };
const fromType = (type: ConferenceType): Form => ({ displayName: type.displayName, aliases: type.aliases.join(", "), organizer: type.organizer ?? "", websiteUrl: type.websiteUrl ?? "", notes: type.notes ?? "", active: type.active });

export function TypeManager({ types, events }: { types: ConferenceType[]; events: ConferenceEventSummary[] }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [confirmedCollisions, setConfirmedCollisions] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => { void client.invalidateQueries({ queryKey: ["/api/conference-types"] }); void client.invalidateQueries({ queryKey: ["/api/conference-events"] }); };
  const success = (message: string) => { setError(""); refresh(); toast({ title: message }); };
  const fail = (reason: unknown) => setError(conferenceError(reason));
  const create = useCreateConferenceType({ mutation: { onSuccess: () => { setForm(blank); setEditing(null); success("Conference type added"); }, onError: fail } });
  const update = useUpdateConferenceType({ mutation: { onSuccess: () => { setEditing(null); success("Conference type saved"); }, onError: fail } });
  const remove = useDeleteConferenceType({ mutation: { onSuccess: () => success("Unused conference type deleted"), onError: fail } });
  const merge = useMergeConferenceType({ mutation: { onSuccess: (result) => { setSourceId(""); setTargetId(""); setConfirmedCollisions(false); success(`${result.reassignedEventCount} events reassigned; history preserved`); }, onError: fail } });
  const source = types.find((type) => type.id === sourceId);
  const target = types.find((type) => type.id === targetId);
  const sourceEvents = events.filter((event) => event.conferenceTypeId === sourceId);
  const targetEvents = events.filter((event) => event.conferenceTypeId === targetId);
  const collisions = sourceEvents.flatMap((event) => targetEvents.filter((other) => other.year === event.year).map((other) => ({ sourceEventId: event.id, targetEventId: other.id, year: event.year })));
  const payload = { displayName: form.displayName.trim(), aliases: [...new Set(form.aliases.split(",").map((alias) => alias.trim()).filter(Boolean))], organizer: form.organizer.trim() || null, websiteUrl: form.websiteUrl.trim() || null, notes: form.notes.trim() || null, active: form.active };
  const busy = create.isPending || update.isPending || remove.isPending || merge.isPending;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-serif text-2xl text-foreground">Conference types</h2><p className="text-sm text-muted-foreground">Maintain the series behind each annual event. Archiving keeps its history intact.</p></div>
      <Button variant="outline" onClick={() => { setEditing("new"); setForm(blank); setError(""); }}><Plus className="mr-2 h-4 w-4" />Add type</Button>
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error} Check event links or use merge before deleting a referenced type.</p>}
    <Input aria-label="Search conference types" placeholder="Search names, aliases, organizers…" value={search} onChange={(event) => setSearch(event.target.value)} />
    {editing && <form className="space-y-3 rounded-lg border bg-muted/25 p-4" onSubmit={(event) => { event.preventDefault(); if (!payload.displayName) return; if (editing === "new") create.mutate({ data: payload }); else update.mutate({ id: editing, data: payload }); }}>
      <h3 className="font-medium">{editing === "new" ? "Add a conference type" : "Edit conference type"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label htmlFor="type-name">Display name</Label><Input id="type-name" required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></div>
        <div><Label htmlFor="type-aliases">Aliases (comma separated)</Label><Input id="type-aliases" value={form.aliases} onChange={(event) => setForm({ ...form, aliases: event.target.value })} /></div>
        <div><Label htmlFor="type-organizer">Organizer</Label><Input id="type-organizer" value={form.organizer} onChange={(event) => setForm({ ...form, organizer: event.target.value })} /></div>
        <div><Label htmlFor="type-website">Default website URL</Label><Input id="type-website" type="url" value={form.websiteUrl} onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })} /></div>
      </div>
      <div><Label htmlFor="type-notes">Notes</Label><Textarea id="type-notes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Active</label>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Save type</Button><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
    </form>}
    <div className="divide-y rounded-lg border bg-card">
      {types.filter((type) => [type.displayName, type.organizer, ...type.aliases].join(" ").toLowerCase().includes(search.toLowerCase())).map((type) => {
        const count = events.filter((event) => event.conferenceTypeId === type.id).length;
        return <div key={type.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{type.displayName}</strong><Badge variant="secondary">{count} events</Badge>{!type.active && <Badge variant="outline">Archived</Badge>}</div><div className="text-xs text-muted-foreground">{[type.organizer, type.aliases.length ? `Also: ${type.aliases.join(", ")}` : null].filter(Boolean).join(" · ")}</div></div>
          <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={() => { setEditing(type.id); setForm(fromType(type)); setError(""); }}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => update.mutate({ id: type.id, data: { active: !type.active } })}><Archive className="mr-1 h-3.5 w-3.5" />{type.active ? "Archive" : "Activate"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (count) { setSourceId(type.id); setError("This type has events. Reassign its events individually, merge it, or archive it instead of deleting."); return; } if (window.confirm(`Delete unused type “${type.displayName}”? This cannot be undone.`)) remove.mutate({ id: type.id }); }}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button></div>
        </div>;
      })}
      {!types.length && <p className="p-5 text-sm text-muted-foreground">No conference types yet. Add one to start tracking events.</p>}
    </div>
    <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div><h3 className="font-medium">Merge conference types</h3><p className="text-xs text-muted-foreground">Move every annual event from the source into the target. Existing attendance, research, imports and review history must be retained.</p></div>
      <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="merge-source">Source type (will be removed)</Label><select id="merge-source" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setConfirmedCollisions(false); }}><option value="">Select source</option>{types.map((type) => <option key={type.id} value={type.id}>{type.displayName}</option>)}</select></div><div><Label htmlFor="merge-target">Target type (will remain)</Label><select id="merge-target" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={targetId} onChange={(event) => { setTargetId(event.target.value); setConfirmedCollisions(false); }}><option value="">Select target</option>{types.filter((type) => type.id !== sourceId).map((type) => <option key={type.id} value={type.id}>{type.displayName}</option>)}</select></div></div>
      {source && target && <p className="text-sm">{sourceEvents.length} source events will move from {source.displayName} to {target.displayName}.</p>}
      {!!collisions.length && <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900"><strong>Same-year events need an explicit decision: {collisions.map((item) => item.year).join(", ")}.</strong><p className="mt-1">The target event remains; source event history is consolidated into it. Review both records before proceeding.</p><label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={confirmedCollisions} onChange={(event) => setConfirmedCollisions(event.target.checked)} />I reviewed these overlapping years and want to preserve all history in the target events.</label></div>}
      <Button variant="outline" disabled={!source || !target || !!collisions.length && !confirmedCollisions || busy} onClick={() => { if (!source || !target || !window.confirm(`Merge “${source.displayName}” into “${target.displayName}”? The source type will be removed.`)) return; merge.mutate({ id: source.id, data: { targetTypeId: target.id, eventResolutions: collisions.map(({ sourceEventId, targetEventId }) => ({ sourceEventId, targetEventId, strategy: "preserve_all_history" })) } }); }}>Merge into target</Button>
    </div>
  </div>;
}