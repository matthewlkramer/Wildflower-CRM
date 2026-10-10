import { DocumentImport } from "@/components/conferences/document-import";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListConferenceTypes, useListConferenceEvents, useGetConferenceEvent, useCreateConferenceEvent, useUpdateConferenceEvent, useConfirmConferenceEventDates,
  useListConferenceAttendance, useCreateConferenceAttendance, useStageConferenceImport, useConfirmConferenceImport,
  useListConferenceEmailSuggestions, useGenerateConferenceEmailSuggestions, useReviewConferenceAttendanceSuggestion,
  useCreateConferenceResearchRequest, useListConferenceResearchRequests, useRetryConferenceResearchRequest,
  useListConferenceSpeakerProposals, useBulkAddConferenceSpeakerProposals, useBulkIgnoreConferenceSpeakerProposals,
  useReopenConferenceSpeakerProposal, useEnqueueConferenceResearchBackfill,
  getGetConferenceEventQueryKey, getListConferenceResearchRequestsQueryKey, getListConferenceSpeakerProposalsQueryKey,
  type ConferenceEvent, type ConferenceEventInput, type ConferenceImportBatch, type ConferenceResearchRequest,
  type ConferenceSpeakerProposal, type ConferenceSpeakerProposalBulkInput,
} from "@workspace/api-client-react";
import { Archive, CalendarDays, Check, ClipboardPaste, ExternalLink, MailSearch, Plus, Search, Sparkles, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { EntityCombobox, usePersonName, usePersonSearch } from "@/components/entity-picker";
import { TypeManager, conferenceError } from "@/components/conferences/type-manager";

const formatDate = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Unknown";
const safeLink = (value?: string | null) => value && /^https?:\/\//i.test(value) ? value : null;
const dateOnly = (value?: string | null) => value?.slice(0, 10) ?? "";
const dateValid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const refreshPrefixes = ["/api/conference-events", "/api/conference-types", "/api/people", "/api/organizations"];

export function latestCompletedDateProposal(runs: ConferenceResearchRequest[]) {
  return runs.filter((run) => run.kind === "dates" && run.status === "completed" && run.proposedStartDate)
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))[0];
}

type SpeakerChoice = Pick<ConferenceSpeakerProposal, "id" | "candidatePersonIds" | "matchCandidates">;
export function speakerAddInput(proposals: SpeakerChoice[], selectedIds: string[], personChoices: Record<string, string>): ConferenceSpeakerProposalBulkInput | null {
  const selected = proposals.filter((proposal) => selectedIds.includes(proposal.id));
  if (!selected.length || selected.length !== selectedIds.length) return null;
  const personSelections: NonNullable<ConferenceSpeakerProposalBulkInput["personSelections"]> = [];
  for (const proposal of selected) {
    if (!proposal.candidatePersonIds.length) continue;
    const personId = personChoices[proposal.id];
    if (!personId || !proposal.candidatePersonIds.includes(personId) || !proposal.matchCandidates?.some((candidate) => candidate.personId === personId)) return null;
    personSelections.push({ proposalId: proposal.id, personId });
  }
  return { proposalIds: selectedIds, personSelections };
}

type EventFormState = { conferenceTypeId: string; year: string; nameOverride: string; startDate: string; endDate: string; datesUnknown: boolean; location: string; attendeeSiteUrl: string; source: string; status: "planned" | "completed" | "cancelled"; notes: string };
const emptyEvent = (): EventFormState => ({ conferenceTypeId: "", year: String(new Date().getFullYear()), nameOverride: "", startDate: "", endDate: "", datesUnknown: false, location: "", attendeeSiteUrl: "", source: "", status: "planned", notes: "" });
const formFromEvent = (event: ConferenceEvent): EventFormState => ({ conferenceTypeId: event.conferenceTypeId, year: String(event.year), nameOverride: event.nameOverride ?? "", startDate: dateOnly(event.startDate), endDate: dateOnly(event.endDate), datesUnknown: !event.startDate, location: event.location ?? "", attendeeSiteUrl: event.attendeeSiteUrl ?? "", source: event.source ?? "", status: event.status, notes: event.notes ?? "" });

export function EventForm({ initial, types, pending, onSave, onCancel }: { initial?: ConferenceEvent; types: { id: string; displayName: string }[]; pending: boolean; onSave: (data: ConferenceEventInput) => void; onCancel: () => void }) {
  const [form, setForm] = useState<EventFormState>(() => initial ? formFromEvent(initial) : emptyEvent());
  const [validation, setValidation] = useState("");
  const set = (field: keyof EventFormState, value: string | boolean) => setForm((old) => ({ ...old, [field]: value }));
  return <form className="space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4" onSubmit={(event) => {
    event.preventDefault();
    if (!form.conferenceTypeId || !/^\d{4}$/.test(form.year) || Number(form.year) < 2000 || Number(form.year) > 2200) { setValidation("Choose a type and a year between 2000 and 2200."); return; }
    if (!form.datesUnknown && (!dateValid(form.startDate) || !!form.endDate && (!dateValid(form.endDate) || form.endDate < form.startDate))) { setValidation("Enter a start date and an optional end date on or after the start."); return; }
    setValidation("");
    onSave({ conferenceTypeId: form.conferenceTypeId, year: Number(form.year), nameOverride: form.nameOverride.trim() || null, startDate: form.datesUnknown ? null : form.startDate, endDate: form.datesUnknown ? null : form.endDate || null, datesUnknown: form.datesUnknown, location: form.location.trim() || null, attendeeSiteUrl: form.attendeeSiteUrl.trim() || null, source: form.source.trim() || null, status: form.status, notes: form.notes.trim() || null });
  }}>
    <div><h3 className="font-serif text-xl">{initial ? "Edit annual event" : "Add annual event"}</h3><p className="text-xs text-muted-foreground">Dates are required unless you explicitly ask us to find them.</p></div>
    <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="event-type">Conference type</Label><select id="event-type" required className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.conferenceTypeId} onChange={(event) => set("conferenceTypeId", event.target.value)}><option value="">Select a type</option>{types.map((type) => <option key={type.id} value={type.id}>{type.displayName}</option>)}</select></div><div><Label htmlFor="event-year">Year</Label><Input id="event-year" required type="number" min={2000} max={2200} value={form.year} onChange={(event) => set("year", event.target.value)} /></div></div>
    <div><Label htmlFor="event-name">Display name override</Label><Input id="event-name" placeholder="Uses conference type name if blank" value={form.nameOverride} onChange={(event) => set("nameOverride", event.target.value)} /></div>
    <fieldset className="space-y-3 rounded-md border bg-card p-3"><legend className="px-1 text-sm font-medium">When is this event?</legend><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={form.datesUnknown} onChange={(event) => setForm((old) => ({ ...old, datesUnknown: event.target.checked, startDate: event.target.checked ? "" : old.startDate, endDate: event.target.checked ? "" : old.endDate }))} />I don’t know — find the dates using public sources</label>{!form.datesUnknown && <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="event-start">Start date</Label><Input id="event-start" type="date" required value={form.startDate} onChange={(event) => set("startDate", event.target.value)} /></div><div><Label htmlFor="event-end">End date (optional)</Label><Input id="event-end" type="date" min={form.startDate} value={form.endDate} onChange={(event) => set("endDate", event.target.value)} /></div></div>}</fieldset>
    <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="event-location">Location</Label><Input id="event-location" value={form.location} onChange={(event) => set("location", event.target.value)} /></div><div><Label htmlFor="event-url">Official or attendee website</Label><Input id="event-url" type="url" value={form.attendeeSiteUrl} onChange={(event) => set("attendeeSiteUrl", event.target.value)} /></div></div>
    <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="event-source">Source note</Label><Input id="event-source" value={form.source} onChange={(event) => set("source", event.target.value)} /></div><div><Label htmlFor="event-status">Status</Label><select id="event-status" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.status} onChange={(event) => set("status", event.target.value)}><option value="planned">Planned</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></div></div>
    <div><Label htmlFor="event-notes">Notes</Label><Textarea id="event-notes" value={form.notes} onChange={(event) => set("notes", event.target.value)} /></div>
    {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
    <div className="flex gap-2"><Button type="submit" disabled={pending}>{initial ? "Save event" : "Create event"}</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
  </form>;
}

function ResearchPanel({ event, refresh }: { event: ConferenceEvent; refresh: () => void }) {
  const { toast } = useToast();
  const [error, setError] = useState("");
  const [confirmingId, setConfirmingId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const runsQ = useListConferenceResearchRequests(event.id, { query: { queryKey: getListConferenceResearchRequestsQueryKey(event.id), refetchInterval: 15000 } });
  const runs = runsQ.data ?? [];
  const newestDates = latestCompletedDateProposal(runs);
  const create = useCreateConferenceResearchRequest({ mutation: { onSuccess: () => { refresh(); toast({ title: "Research queued" }); }, onError: (reason) => setError(conferenceError(reason)) } });
  const retry = useRetryConferenceResearchRequest({ mutation: { onSuccess: () => { refresh(); toast({ title: "Research queued again" }); }, onError: (reason) => setError(conferenceError(reason)) } });
  const confirm = useConfirmConferenceEventDates({ mutation: { onSuccess: () => { setConfirmingId(""); refresh(); toast({ title: "Dates confirmed" }); }, onError: (reason) => setError(conferenceError(reason)) } });
  const startReview = (run: ConferenceResearchRequest) => { setConfirmingId(run.id); setSourceUrl(run.sources?.[0]?.url ?? ""); setEvidenceText(run.evidence?.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") || `Date proposal from research run ${run.id}`); };
  const nextWindows = event.startDate ? [21, 2].map((days) => { const date = new Date(`${dateOnly(event.startDate)}T12:00:00`); date.setDate(date.getDate() - days); return { days, date }; }) : [];
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" />Public research</CardTitle><CardDescription>Official public pages only. No private directories or credentials. Research does not change uncertain dates without review.</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={create.isPending} onClick={() => create.mutate({ id: event.id, data: { kind: "dates", attendeeSiteUrl: event.attendeeSiteUrl ?? null } })}>Find dates now</Button><Button variant="outline" disabled={create.isPending} onClick={() => create.mutate({ id: event.id, data: { kind: "agenda_speakers", attendeeSiteUrl: event.attendeeSiteUrl ?? null } })}>Research agenda &amp; speakers now</Button></div>
    {!event.startDate && <p className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-sm text-amber-950">Dates unknown. Find dates now, inspect the evidence, then confirm the proposal. Agenda research can still be requested separately.</p>}
    {!!nextWindows.length && <p className="text-xs text-muted-foreground">Agenda research windows: {nextWindows.map(({ days, date }) => `${days} days before (${date.toLocaleDateString()})`).join(" · ")}. Scheduled runs and catch-up are managed by the server.</p>}
    {runsQ.isLoading && <div className="h-12 animate-pulse rounded bg-muted" />}
    {runsQ.isError && <Button variant="outline" onClick={() => void runsQ.refetch()}>Could not load research runs. Retry</Button>}
    {newestDates && <div className="space-y-2 rounded-md border border-primary/25 bg-primary/5 p-3"><div className="flex items-center gap-2"><strong className="text-sm">Researched date proposal</strong><Badge variant="secondary">{newestDates.proposedDateConfidence ?? "Unrated"} confidence</Badge></div><p className="text-sm">{formatDate(newestDates.proposedStartDate)}{newestDates.proposedEndDate ? ` – ${formatDate(newestDates.proposedEndDate)}` : ""}</p>{newestDates.sources?.map((source) => safeLink(source.url) && <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="block break-all text-xs text-primary underline">{source.title || source.url} <ExternalLink className="inline h-3 w-3" /></a>)}{newestDates.evidence?.map((item, index) => <p key={index} className="break-words text-xs text-muted-foreground">{typeof item === "string" ? item : JSON.stringify(item)}</p>)}
      {confirmingId === newestDates.id ? <div className="space-y-2 border-t pt-3"><p className="text-xs">Check the cited source and evidence before confirming. This will save the proposed dates.</p><div><Label htmlFor="confirm-source">Cited source URL</Label><Input id="confirm-source" type="url" required value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} /></div><div><Label htmlFor="confirm-evidence">Evidence</Label><Textarea id="confirm-evidence" required value={evidenceText} onChange={(event) => setEvidenceText(event.target.value)} /></div><Button disabled={confirm.isPending || !safeLink(sourceUrl) || !evidenceText.trim()} onClick={() => { if (!newestDates.proposedStartDate || !newestDates.proposedDateConfidence) return; confirm.mutate({ id: event.id, data: { researchRequestId: newestDates.id, startDate: newestDates.proposedStartDate, endDate: newestDates.proposedEndDate ?? null, dateSourceUrl: sourceUrl, dateEvidence: evidenceText.trim(), dateConfidence: newestDates.proposedDateConfidence, expectedUpdatedAt: event.updatedAt, confirmed: true } }); }}>Confirm dates</Button><Button variant="ghost" onClick={() => setConfirmingId("")}>Cancel</Button></div> : <Button size="sm" variant="outline" onClick={() => startReview(newestDates)}>Review proposed dates</Button>}</div>}
    <div className="space-y-2"><h4 className="text-sm font-medium">Research runs</h4>{!runsQ.isLoading && !runs.length && <p className="text-xs text-muted-foreground">No research runs yet. Start with dates or the agenda above.</p>}{runs.map((run) => <div key={run.id} className="rounded-md border p-3 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{run.kind === "agenda_speakers" ? "Agenda & speakers" : "Dates"}</strong><Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{run.status.replaceAll("_", " ")}</Badge></div><div className="mt-1 text-muted-foreground">Requested {new Date(run.createdAt).toLocaleString()}{run.completedAt ? ` · Finished ${new Date(run.completedAt).toLocaleString()}` : ""}{run.attempts ? ` · ${run.attempts} attempts` : ""}{run.nextAttemptAt ? ` · Next retry ${new Date(run.nextAttemptAt).toLocaleString()}` : ""}</div>{run.error && <p role="alert" className="mt-2 text-destructive">{run.error}</p>}{run.sources?.map((source) => safeLink(source.url) && <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-primary underline">{source.title || source.url}{source.fetchedAt ? ` · fetched ${new Date(source.fetchedAt).toLocaleString()}` : ""}</a>)}{run.evidence?.map((item, index) => <p key={index} className="mt-1 break-words text-muted-foreground">{typeof item === "string" ? item : JSON.stringify(item)}</p>)}{run.status === "failed" && <Button size="sm" variant="outline" className="mt-2" disabled={retry.isPending} onClick={() => retry.mutate({ id: run.id })}>Retry run</Button>}</div>)}</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </CardContent></Card>;
}

function ProposalsPanel({ eventId, refresh }: { eventId: string; refresh: () => void }) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [personChoices, setPersonChoices] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState("");
  const query = useListConferenceSpeakerProposals(eventId, undefined, { query: { queryKey: getListConferenceSpeakerProposalsQueryKey(eventId), refetchInterval: 15000 } });
  const proposals = query.data ?? [];
  const pending = proposals.filter((item) => item.status === "pending");
  const visible = showAll ? proposals : pending;
  const chosen = selected.filter((id) => pending.some((proposal) => proposal.id === id));
  const addInput = speakerAddInput(pending, chosen, personChoices);
  const done = (result: { succeededCount: number; conflictCount: number }, action: string) => { setSelected([]); setPersonChoices({}); refresh(); void query.refetch(); toast({ title: `${result.succeededCount} proposals ${action}` }); if (result.conflictCount) setError(`${result.conflictCount} proposals could not be ${action}. Refresh and inspect the duplicate or candidate details before retrying.`); else setError(""); };
  const fail = (reason: unknown) => setError(`${conferenceError(reason)} Review matching candidates and existing people before retrying.`);
  const add = useBulkAddConferenceSpeakerProposals({ mutation: { onSuccess: (result) => done(result, "added"), onError: fail } });
  const ignore = useBulkIgnoreConferenceSpeakerProposals({ mutation: { onSuccess: (result) => done(result, "ignored"), onError: fail } });
  const reopen = useReopenConferenceSpeakerProposal({ mutation: { onSuccess: () => { refresh(); toast({ title: "Proposal reopened" }); }, onError: fail } });
  const busy = add.isPending || ignore.isPending || reopen.isPending;
  return <Card><CardHeader><CardTitle className="text-base">Speaker proposals <Badge variant="secondary" className="ml-2">{pending.length} pending</Badge></CardTitle><CardDescription>For possible matches, explicitly choose the existing CRM person below—even if there is just one candidate. Unmatched speakers can be added as new people with confirmed Speaker attendance. Organizations are not created.</CardDescription></CardHeader><CardContent className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={!addInput || busy} onClick={() => { if (addInput && window.confirm(`Add ${chosen.length} selected speaker proposals to CRM? Existing people will be checked again for duplicates.`)) add.mutate({ id: eventId, data: addInput }); }}>Add selected to CRM</Button><Button size="sm" variant="outline" disabled={!chosen.length || busy} onClick={() => { if (window.confirm(`Ignore ${chosen.length} selected speaker proposals?`)) ignore.mutate({ id: eventId, data: { proposalIds: chosen } }); }}>Ignore selected</Button><Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Show pending" : "Show all statuses"}</Button></div>
    {chosen.length > 0 && !addInput && <p role="status" className="text-xs text-amber-800">Choose an existing CRM person for every selected proposal with possible matches before adding. If candidate details are unavailable, refresh the proposals or ignore that proposal for now.</p>}
    {!!pending.length && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={chosen.length === pending.length} onChange={(event) => setSelected(event.target.checked ? pending.map((item) => item.id) : [])} />Select all pending ({pending.length})</label>}
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {query.isLoading && <div className="h-24 animate-pulse rounded bg-muted" />}{query.isError && <Button variant="outline" onClick={() => void query.refetch()}>Could not load speaker proposals. Retry</Button>}
    {!query.isLoading && !query.isError && !visible.length && <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">{showAll ? "No proposals have been found for this event." : "No speaker proposals await review. Run agenda research to discover public speakers."}</p>}
    {visible.map((proposal) => <div key={proposal.id} className="rounded-lg border p-3 text-sm">
      <div className="flex items-start gap-3">
        {proposal.status === "pending" && <input type="checkbox" className="mt-1" aria-label={`Select ${proposal.name}`} checked={chosen.includes(proposal.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, proposal.id] : old.filter((id) => id !== proposal.id))} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><strong>{proposal.name}</strong><Badge variant="outline">{proposal.confidence} confidence</Badge><Badge variant="secondary">{proposal.status}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">{[proposal.title, proposal.organizationName].filter(Boolean).join(" · ")}</p>
          {proposal.bio && <p className="mt-2 text-xs">{proposal.bio}</p>}
          {proposal.sessionEvidence && <p className="mt-2 border-l-2 border-primary/30 pl-2 text-xs text-muted-foreground">{proposal.sessionEvidence}</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {safeLink(proposal.sourceUrl) && <a href={proposal.sourceUrl!} target="_blank" rel="noreferrer" className="text-primary underline">Agenda source</a>}
            {safeLink(proposal.profileUrl) && <a href={proposal.profileUrl!} target="_blank" rel="noreferrer" className="text-primary underline">Speaker profile</a>}
          </div>
          {!!proposal.candidatePersonIds.length && <div className="mt-3 rounded-md bg-muted/50 p-3 text-xs">
            <Label htmlFor={`candidate-${proposal.id}`}>Choose the matching CRM person for {proposal.name}</Label>
            {proposal.matchCandidates?.length ? <>
              <select id={`candidate-${proposal.id}`} value={personChoices[proposal.id] ?? ""} disabled={proposal.status !== "pending" || busy} onChange={(event) => setPersonChoices((old) => ({ ...old, [proposal.id]: event.target.value }))} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="">Select an existing person — required to add</option>
                {proposal.matchCandidates.filter((candidate) => proposal.candidatePersonIds.includes(candidate.personId)).map((candidate) => <option key={candidate.personId} value={candidate.personId}>{candidate.name}{candidate.organizationName ? ` · ${candidate.organizationName}` : ""}</option>)}
              </select>
              {proposal.matchCandidates.map((candidate) => <div key={candidate.personId} className="mt-2">
                <Link href={`/individuals/${candidate.personId}`} className="text-primary underline">{candidate.name}</Link>
                {candidate.organizationName ? ` · ${candidate.organizationName}` : ""}
                {candidate.matchEvidence ? ` · ${candidate.matchEvidence}` : ""}
              </div>)}
              <p className="mt-2 text-muted-foreground">No person is chosen automatically. Check their CRM record and select the exact match before adding.</p>
            </> : <p className="mt-2 text-amber-800">Candidate details are unavailable. Refresh proposals to review the possible match; this proposal cannot be added without a choice.</p>}
          </div>}
          {proposal.matchedPersonId && <p className="mt-2 text-xs text-amber-700">Already matched to a CRM person. Confirm the existing record before adding another.</p>}
          {proposal.status === "ignored" && <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={() => reopen.mutate({ id: proposal.id })}>Reopen proposal</Button>}
          {proposal.addedPersonId && <Link href={`/individuals/${proposal.addedPersonId}`} className="mt-2 block text-xs text-primary underline">View added person</Link>}
        </div>
      </div>
    </div>)}
  </CardContent></Card>;
}

function EventWorkspace({ eventId, onClose, types, refresh }: { eventId: string; onClose: () => void; types: { id: string; displayName: string }[]; refresh: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [role, setRole] = useState("Attendee");
  const [sourceReference, setSourceReference] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [error, setError] = useState("");
  const eventQ = useGetConferenceEvent(eventId, { query: { queryKey: getGetConferenceEventQueryKey(eventId), refetchInterval: 15000 } });
  const event = eventQ.data;
  const attendanceQ = useListConferenceAttendance(eventId, { limit: 100 });
  const suggestionsQ = useListConferenceEmailSuggestions(eventId);
  const localRefresh = () => { refresh(); void eventQ.refetch(); void attendanceQ.refetch(); void suggestionsQ.refetch(); };
  const fail = (reason: unknown) => setError(conferenceError(reason));
  const update = useUpdateConferenceEvent({ mutation: { onSuccess: () => { setEditing(false); localRefresh(); toast({ title: "Event updated" }); }, onError: fail } });
  const addAttendance = useCreateConferenceAttendance({ mutation: { onSuccess: () => { setPersonId(null); setEvidenceNote(""); setSourceReference(""); localRefresh(); toast({ title: "Attendance recorded" }); }, onError: fail } });
  const generateSuggestions = useGenerateConferenceEmailSuggestions({ mutation: { onSuccess: () => { void suggestionsQ.refetch(); toast({ title: "Email suggestions refreshed" }); }, onError: fail } });
  const reviewSuggestion = useReviewConferenceAttendanceSuggestion({ mutation: { onSuccess: () => localRefresh(), onError: fail } });
  if (eventQ.isLoading) return <div className="h-48 animate-pulse rounded-xl bg-muted" />;
  if (eventQ.isError || !event) return <Card><CardContent className="flex flex-wrap items-center gap-3 py-8"><p role="alert">Could not load this event.</p><Button variant="outline" onClick={() => void eventQ.refetch()}>Retry</Button><Button variant="ghost" onClick={onClose}>Back to events</Button></CardContent></Card>;
  const rowCount = attendanceQ.data?.data.length ?? 0;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4"><div><Button size="sm" variant="ghost" className="mb-2 -ml-3" onClick={onClose}>← All events</Button><h2 className="font-serif text-3xl">{event.nameOverride || types.find((type) => type.id === event.conferenceTypeId)?.displayName || "Conference"} <span className="text-muted-foreground">{event.year}</span></h2><p className="mt-1 text-sm text-muted-foreground">{event.startDate ? `${formatDate(event.startDate)}${event.endDate ? ` – ${formatDate(event.endDate)}` : ""}` : "Dates unknown — research needed"}{event.location ? ` · ${event.location}` : ""} · {event.status}</p></div><Button variant="outline" onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit event"}</Button></div>
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {editing && <EventForm key={event.id + event.updatedAt} initial={event} types={types} pending={update.isPending} onSave={(data) => update.mutate({ id: event.id, data })} onCancel={() => setEditing(false)} />}
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{event.dateSourceUrl && safeLink(event.dateSourceUrl) && <a href={event.dateSourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">Date source <ExternalLink className="inline h-3 w-3" /></a>}{event.dateEvidence && <span>Date evidence: {event.dateEvidence}</span>}{event.dateConfidence && <span>Confidence: {event.dateConfidence}</span>}{event.dateResearchedAt && <span>Researched {new Date(event.dateResearchedAt).toLocaleDateString()}</span>}{event.dateReviewedAt && <span>Reviewed {new Date(event.dateReviewedAt).toLocaleDateString()}</span>}{event.attendeeSiteUrl && safeLink(event.attendeeSiteUrl) && <a href={event.attendeeSiteUrl} target="_blank" rel="noreferrer" className="text-primary underline">Official website</a>}</div>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]"><div className="space-y-5"><ResearchPanel event={event} refresh={localRefresh} /><ProposalsPanel eventId={eventId} refresh={localRefresh} /><Card><CardHeader><CardTitle className="text-base">Attendance <Badge variant="secondary" className="ml-2">{attendanceQ.data?.pagination.total ?? rowCount}</Badge></CardTitle><CardDescription>Person-owned attendance. Organization context follows affiliations; speaker evidence remains attached to the attendance record.</CardDescription></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2"><div className="sm:col-span-2"><Label htmlFor="attendance-person">Person</Label><div id="attendance-person"><EntityCombobox value={personId} onChange={setPersonId} placeholder="Search CRM people…" useSearch={usePersonSearch} useResolve={usePersonName} allowNull /></div></div><div><Label htmlFor="attendance-role">Role</Label><select id="attendance-role" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={role} onChange={(event) => setRole(event.target.value)}><option>Attendee</option><option>Speaker</option></select></div><div><Label htmlFor="attendance-source">Source URL or reference</Label><Input id="attendance-source" value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} /></div><div className="sm:col-span-2"><Label htmlFor="attendance-evidence">Evidence note</Label><Input id="attendance-evidence" value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} /></div><Button disabled={!personId || addAttendance.isPending} onClick={() => personId && addAttendance.mutate({ id: eventId, data: { personId, status: "confirmed", role, sourceType: "manual", sourceReference: sourceReference.trim() || null, evidenceNote: evidenceNote.trim() || null } })}><Plus className="mr-1 h-4 w-4" />Add attendance</Button></div>
      {attendanceQ.isLoading && <div className="h-20 animate-pulse rounded bg-muted" />}{attendanceQ.isError && <Button variant="outline" onClick={() => void attendanceQ.refetch()}>Could not load attendance. Retry</Button>}
      {!attendanceQ.isLoading && !attendanceQ.isError && !rowCount && <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">No attendance recorded. Add a person, review an import, or research speakers.</p>}
      <div className="divide-y rounded-md border">{attendanceQ.data?.data.map((row) => <div key={row.id} className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm"><div><Link href={`/individuals/${row.personId}`} className="font-medium text-primary hover:underline">{row.personName}</Link>{row.organizationName && <p className="text-xs text-muted-foreground">{row.organizationName}</p>}{row.evidenceNote && <p className="mt-1 text-xs text-muted-foreground">{row.evidenceNote}</p>}{row.sourceReference && (safeLink(row.sourceReference) ? <a href={row.sourceReference} target="_blank" rel="noreferrer" className="break-all text-xs text-primary underline">View evidence</a> : <p className="text-xs text-muted-foreground">{row.sourceReference}</p>)}</div><div className="flex flex-wrap gap-1"><Badge variant="outline">{row.role || "Attendee"}</Badge><Badge variant="secondary">{row.status}</Badge>{row.registrationListed && <Badge variant="outline">Listed / registered</Badge>}<Badge variant="outline">{row.sourceType.replaceAll("_", " ")}</Badge></div></div>)}</div>{attendanceQ.data && attendanceQ.data.pagination.total > rowCount && <p className="text-xs text-muted-foreground">Showing {rowCount} of {attendanceQ.data.pagination.total} attendance records.</p>}
    </CardContent></Card></div><div className="space-y-5"><DocumentImport eventId={eventId} onComplete={localRefresh} />
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><MailSearch className="h-4 w-4" />Email-derived suggestions</CardTitle><CardDescription>Existing CRM email evidence only. Suggestions never auto-confirm attendance.</CardDescription></CardHeader><CardContent className="space-y-3"><Button variant="outline" className="w-full" disabled={generateSuggestions.isPending} onClick={() => generateSuggestions.mutate({ id: eventId })}>Scan CRM email evidence</Button>{suggestionsQ.isLoading && <div className="h-12 animate-pulse rounded bg-muted" />}{suggestionsQ.isError && <Button variant="ghost" onClick={() => void suggestionsQ.refetch()}>Could not load suggestions. Retry</Button>}{suggestionsQ.data?.filter((item) => item.status === "pending").map((item) => <div key={item.id} className="rounded-md border p-3 text-sm"><div className="font-medium">{item.personName} <Badge variant="outline">{item.confidence}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{item.evidenceNote}</p><div className="mt-2 flex gap-2"><Button size="sm" disabled={reviewSuggestion.isPending} onClick={() => reviewSuggestion.mutate({ id: item.id, data: { status: "accepted" } })}>Accept</Button><Button size="sm" variant="ghost" disabled={reviewSuggestion.isPending} onClick={() => reviewSuggestion.mutate({ id: item.id, data: { status: "dismissed" } })}>Dismiss</Button></div></div>)}{suggestionsQ.data && !suggestionsQ.data.some((item) => item.status === "pending") && <p className="text-xs text-muted-foreground">No email suggestions awaiting review.</p>}</CardContent></Card>
    </div></div>
  </div>;
}

export default function Conferences() {
  const client = useQueryClient();
  const { toast } = useToast();
  const typesQ = useListConferenceTypes();
  const eventsQ = useListConferenceEvents();
  const [selectedId, setSelectedId] = useState("");
  const [section, setSection] = useState<"events" | "types">("events");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [includeKnownDates, setIncludeKnownDates] = useState(false);
  const [includeCompletedEvents, setIncludeCompletedEvents] = useState(true);
  const [error, setError] = useState("");
  const refresh = () => { refreshPrefixes.forEach((prefix) => void client.invalidateQueries({ queryKey: [prefix] })); if (selectedId) { void client.invalidateQueries({ queryKey: [`/api/conference-events/${selectedId}`] }); void client.invalidateQueries({ queryKey: [`/api/conference-events/${selectedId}/attendance`] }); void client.invalidateQueries({ queryKey: [`/api/conference-events/${selectedId}/research-requests`] }); void client.invalidateQueries({ queryKey: [`/api/conference-events/${selectedId}/speaker-proposals`] }); void client.invalidateQueries({ queryKey: [`/api/conference-events/${selectedId}/email-suggestions`] }); } };
  const create = useCreateConferenceEvent({ mutation: { onSuccess: (event) => { setCreating(false); setSelectedId(event.id); refresh(); toast({ title: "Conference event created" }); }, onError: (reason) => setError(conferenceError(reason)) } });
  const backfill = useEnqueueConferenceResearchBackfill({ mutation: { onSuccess: (result) => { setBackfillOpen(false); refresh(); toast({ title: `Backfill queued: ${result.dateRunsQueued} date runs, ${result.agendaRunsQueued} agenda runs` }); }, onError: (reason) => setError(conferenceError(reason)) } });
  const types = typesQ.data ?? [];
  const events = eventsQ.data ?? [];
  const visible = useMemo(() => events.filter((event) => `${event.nameOverride ?? ""} ${event.conferenceTypeName} ${event.year} ${event.location ?? ""}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.year - a.year), [events, search]);
  return <main className="mx-auto max-w-7xl space-y-6 p-4 pb-16 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="mb-1 flex items-center gap-2 text-primary"><CalendarDays className="h-5 w-5" /><span className="text-sm font-semibold uppercase tracking-wide">Engagement</span></div><h1 className="font-serif text-3xl font-medium text-foreground">Conferences</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Track annual events, document attendance, and review publicly researched speakers with source evidence.</p></div><div className="rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-primary">Attendance belongs to people; organization context follows affiliations.</div></div>
    <nav aria-label="Conference sections" className="flex gap-1 border-b"><Button variant="ghost" className={section === "events" ? "border-b-2 border-primary rounded-none" : ""} onClick={() => { setSection("events"); setSelectedId(""); }}>Annual events</Button><Button variant="ghost" className={section === "types" ? "border-b-2 border-primary rounded-none" : ""} onClick={() => { setSection("types"); setSelectedId(""); }}>Manage types</Button></nav>
    {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {section === "types" ? <TypeManager types={types} events={events} /> : selectedId ? <EventWorkspace key={selectedId} eventId={selectedId} onClose={() => setSelectedId("")} types={types} refresh={refresh} /> : <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-serif text-2xl">Annual events</h2><p className="text-sm text-muted-foreground">Select an event to manage dates, research, proposals and attendance.</p></div><Button onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" />Add event</Button></div>
      {creating && <EventForm types={types.filter((type) => type.active)} pending={create.isPending} onSave={(data) => create.mutate({ data })} onCancel={() => setCreating(false)} />}
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" aria-label="Search annual events" placeholder="Search event, year, or location…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      {eventsQ.isLoading && <div className="grid gap-3 sm:grid-cols-2"><div className="h-28 animate-pulse rounded-xl bg-muted" /><div className="h-28 animate-pulse rounded-xl bg-muted" /></div>}{eventsQ.isError && <Card><CardContent className="flex items-center gap-3 py-6"><p role="alert">Could not load events.</p><Button variant="outline" onClick={() => void eventsQ.refetch()}>Retry</Button></CardContent></Card>}{typesQ.isError && <Button variant="outline" onClick={() => void typesQ.refetch()}>Could not load conference types. Retry</Button>}
      {!eventsQ.isLoading && !eventsQ.isError && !visible.length && <div className="rounded-xl border border-dashed p-9 text-center text-sm text-muted-foreground">{search ? "No events match this search." : "No annual events yet. Add one to begin tracking attendance."}</div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visible.map((event) => <button key={event.id} type="button" onClick={() => setSelectedId(event.id)} className="group rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><div className="flex items-start justify-between gap-2"><div className="font-serif text-xl leading-tight">{event.nameOverride || event.conferenceTypeName}</div><span className="text-sm font-medium text-primary">{event.year}</span></div><div className="mt-3 text-xs text-muted-foreground">{event.startDate ? `${formatDate(event.startDate)}${event.endDate ? ` – ${formatDate(event.endDate)}` : ""}` : "Dates unknown · needs research"}{event.location ? ` · ${event.location}` : ""}</div><div className="mt-4 flex items-center justify-between border-t pt-3"><Badge variant="secondary">{event.attendanceCount} attendance</Badge><span className="text-xs text-primary group-hover:underline">Open event →</span></div></button>)}</div>
      <Card className="border-primary/20"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Archive className="h-4 w-4" />Historical coverage</CardTitle><CardDescription>Admin action: enqueue missing-date research followed by agenda research for existing events. This does not confirm dates or add ambiguous people automatically.</CardDescription></CardHeader><CardContent className="space-y-3">{backfillOpen ? <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm"><label className="flex items-start gap-2"><input type="checkbox" checked={includeCompletedEvents} onChange={(event) => setIncludeCompletedEvents(event.target.checked)} />Include completed historical events</label><label className="flex items-start gap-2"><input type="checkbox" checked={includeKnownDates} onChange={(event) => setIncludeKnownDates(event.target.checked)} />Also research dates already known</label><p className="text-xs text-muted-foreground">This queues work for existing events. The server handles idempotency, retry, and research scheduling. Review findings on each event.</p><div className="flex gap-2"><Button disabled={backfill.isPending} onClick={() => { if (window.confirm("Queue retroactive conference research for existing events?")) backfill.mutate({ data: { includeCompletedEvents, includeKnownDates } }); }}>Queue backfill</Button><Button variant="ghost" onClick={() => setBackfillOpen(false)}>Cancel</Button></div></div> : <Button variant="outline" onClick={() => setBackfillOpen(true)}>Prepare retroactive research</Button>}</CardContent></Card>
    </div>}
  </main>;
}