import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateConferenceAttendance,
  useCreateConferenceEvent,
  useCreateConferenceResearchRequest,
  useConfirmConferenceImport,
  useGenerateConferenceEmailSuggestions,
  useListConferenceAttendance,
  useListConferenceEmailSuggestions,
  useListConferenceEvents,
  useListConferenceTypes,
  useReviewConferenceAttendanceSuggestion,
  useStageConferenceImport,
  type ConferenceImportBatch,
} from "@workspace/api-client-react";
import { CalendarDays, Check, ClipboardPaste, Copy, MailSearch, Plus, Search, Sparkles, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { EntityCombobox, usePersonName, usePersonSearch } from "@/components/entity-picker";

const refreshKey = ["/api/conference-events"];

export default function Conferences() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const typesQ = useListConferenceTypes({ active: true });
  const eventsQ = useListConferenceEvents();
  const [selectedEventId, setSelectedEventId] = useState("");
  const selected = eventsQ.data?.find((event) => event.id === selectedEventId) ?? null;
  const attendanceQ = useListConferenceAttendance(selectedEventId, { limit: 100 });
  const suggestionsQ = useListConferenceEmailSuggestions(selectedEventId);
  const [personId, setPersonId] = useState<string | null>(null);
  const [typeId, setTypeId] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [csvText, setCsvText] = useState("");
  const [stagedBatch, setStagedBatch] = useState<ConferenceImportBatch | null>(null);
  const [researchPrompt, setResearchPrompt] = useState("");

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: refreshKey });
    await attendanceQ.refetch();
    await suggestionsQ.refetch();
  };
  const createEvent = useCreateConferenceEvent({ mutation: { onSuccess: async (event) => { setSelectedEventId(event.id); await refresh(); toast({ title: "Conference event created" }); } } });
  const addAttendance = useCreateConferenceAttendance({ mutation: { onSuccess: async () => { setPersonId(null); await refresh(); toast({ title: "Attendance recorded" }); } } });
  const stageImport = useStageConferenceImport({ mutation: { onSuccess: (batch) => { setStagedBatch(batch); toast({ title: `${batch.rows.length} rows staged for review` }); } } });
  const confirmImport = useConfirmConferenceImport({ mutation: { onSuccess: async (batch) => { setStagedBatch(batch); await refresh(); toast({ title: "Reviewed rows added to attendance" }); } } });
  const research = useCreateConferenceResearchRequest({ mutation: { onSuccess: (request) => { setResearchPrompt(request.prompt); toast({ title: "Copyable research prompt created" }); } } });
  const generateSuggestions = useGenerateConferenceEmailSuggestions({ mutation: { onSuccess: async () => { await suggestionsQ.refetch(); toast({ title: "Review suggestions refreshed" }); } } });
  const reviewSuggestion = useReviewConferenceAttendanceSuggestion({ mutation: { onSuccess: async () => { await refresh(); } } });

  const eventTitle = useMemo(() => selected ? `${selected.conferenceTypeName} ${selected.year}` : "Choose an event", [selected]);

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-primary"><CalendarDays className="h-5 w-5" /><span className="text-sm font-semibold uppercase tracking-wide">Engagement</span></div>
          <h1 className="font-serif text-3xl font-medium text-foreground">Conferences</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Maintain annual events, review attendee evidence, and use attendance to focus relationship research.</p>
        </div>
        <div className="rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-primary">Attendance is person-owned; organization context follows affiliations.</div>
      </div>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader><CardTitle>Conference events</CardTitle><CardDescription>Select an annual event to manage its attendance record.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {eventsQ.isLoading ? <p className="text-sm text-muted-foreground">Loading events…</p> : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {eventsQ.data?.map((event) => (
                  <button key={event.id} type="button" onClick={() => setSelectedEventId(event.id)}
                    className={`rounded-lg border p-3 text-left transition ${selectedEventId === event.id ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border hover:border-primary/50 hover:bg-muted/40"}`}>
                    <div className="font-medium leading-tight">{event.conferenceTypeName}</div>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground"><span>{event.year}{event.location ? ` · ${event.location}` : ""}</span><Badge variant="secondary">{event.attendanceCount}</Badge></div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="border-primary/20">
          <CardHeader><CardTitle className="text-base">Add annual event</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><Label htmlFor="conference-type">Conference type</Label><select id="conference-type" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={typeId} onChange={(e) => setTypeId(e.target.value)}><option value="">Select a type</option>{typesQ.data?.map((type) => <option key={type.id} value={type.id}>{type.displayName}</option>)}</select></div>
            <div><Label htmlFor="conference-year">Year</Label><Input id="conference-year" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" /></div>
            <Button className="w-full" disabled={!typeId || !/^\d{4}$/.test(year) || createEvent.isPending} onClick={() => createEvent.mutate({ data: { conferenceTypeId: typeId, year: Number(year) } })}><Plus className="mr-2 h-4 w-4" />Create event</Button>
          </CardContent>
        </Card>
      </section>

      {selected ? <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card>
          <CardHeader className="border-b bg-muted/25"><CardTitle>{eventTitle}</CardTitle><CardDescription>Confirmed attendance and review actions are auditable.</CardDescription></CardHeader>
          <CardContent className="space-y-4 pt-5">
            <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">
              <div className="min-w-[260px] flex-1"><Label className="sr-only">Add person</Label><EntityCombobox value={personId} onChange={setPersonId} placeholder="Search CRM people…" useSearch={usePersonSearch} useResolve={usePersonName} allowNull /></div>
              <Button disabled={!personId || addAttendance.isPending} onClick={() => personId && addAttendance.mutate({ id: selected.id, data: { personId, status: "confirmed", sourceType: "manual" } })}><Plus className="mr-1 h-4 w-4" />Add attendee</Button>
            </div>
            <div className="overflow-hidden rounded-lg border">
              <div className="grid grid-cols-[minmax(0,1fr)_110px_110px] gap-3 bg-muted/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span>Person</span><span>Status</span><span>Evidence</span></div>
              {attendanceQ.data?.data.map((row) => <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_110px_110px] gap-3 border-t px-4 py-3 text-sm"><Link href={`/individuals/${row.personId}`} className="font-medium text-primary hover:underline">{row.personName}</Link><Badge variant="outline" className="w-fit">{row.status}</Badge><span className="truncate text-muted-foreground">{row.sourceType.replaceAll("_", " ")}</span></div>)}
              {!attendanceQ.data?.data.length && <p className="p-6 text-sm text-muted-foreground">No attendees have been recorded yet.</p>}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ClipboardPaste className="h-4 w-4" />Import attendee list</CardTitle><CardDescription>Paste CSV with Email and/or Name columns. Only unique exact email matches are preselected; review before applying.</CardDescription></CardHeader>
            <CardContent className="space-y-3"><Textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder={"Name,Email,Organization\nJordan Lee,jordan@example.org,Example Foundation"} rows={5} /><Button variant="outline" className="w-full" disabled={!csvText.trim() || stageImport.isPending} onClick={() => stageImport.mutate({ id: selected.id, data: { csvText, filename: "pasted-attendees.csv" } })}><Upload className="mr-2 h-4 w-4" />Stage for review</Button>
              {stagedBatch && <div className="rounded-md bg-muted p-3 text-sm"><div className="mb-2 font-medium">{stagedBatch.rows.length} staged rows</div><div className="mb-3 text-muted-foreground">{stagedBatch.rows.filter((row) => row.matchStatus === "exact").length} exact email matches will be applied. Ambiguous and unmatched rows stay out.</div><Button size="sm" disabled={stagedBatch.status === "confirmed" || confirmImport.isPending} onClick={() => confirmImport.mutate({ id: stagedBatch.id, data: {} })}><Check className="mr-1 h-4 w-4" />Confirm exact matches</Button></div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4" />Public research prompt</CardTitle><CardDescription>Creates a copyable prompt only. No credential collection, login, or automatic web access.</CardDescription></CardHeader>
            <CardContent className="space-y-3"><Button variant="outline" className="w-full" disabled={research.isPending} onClick={() => research.mutate({ id: selected.id, data: {} })}><Sparkles className="mr-2 h-4 w-4" />Create research prompt</Button>
              {researchPrompt && <><Textarea readOnly value={researchPrompt} rows={5} /><Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(researchPrompt).then(() => toast({ title: "Prompt copied" }))}><Copy className="mr-1 h-4 w-4" />Copy prompt</Button></>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MailSearch className="h-4 w-4" />Email-derived suggestions</CardTitle><CardDescription>Existing CRM email evidence only. Suggestions never auto-confirm attendance.</CardDescription></CardHeader>
            <CardContent className="space-y-3"><Button variant="outline" className="w-full" disabled={generateSuggestions.isPending} onClick={() => generateSuggestions.mutate({ id: selected.id })}>Scan CRM email evidence</Button>
              {suggestionsQ.data?.filter((suggestion) => suggestion.status === "pending").map((suggestion) => <div key={suggestion.id} className="rounded-md border p-3 text-sm"><div className="font-medium">{suggestion.personName}</div><p className="mt-1 text-xs text-muted-foreground">{suggestion.evidenceNote}</p><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => reviewSuggestion.mutate({ id: suggestion.id, data: { status: "accepted" } })}>Accept</Button><Button size="sm" variant="ghost" onClick={() => reviewSuggestion.mutate({ id: suggestion.id, data: { status: "dismissed" } })}>Dismiss</Button></div></div>)}
            </CardContent>
          </Card>
        </div>
      </section> : <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Choose an event above or create a new annual event to begin tracking attendance.</CardContent></Card>}
    </main>
  );
}