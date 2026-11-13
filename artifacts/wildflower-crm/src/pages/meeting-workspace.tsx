import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCalendarEventQueryKey,
  getGetMeetingNoteQueryKey,
  getGetHouseholdQueryKey,
  getGetOrganizationQueryKey,
  getGetPersonQueryKey,
  getListCalendarEventsQueryKey,
  getListMeetingNotesQueryKey,
  useCreateMeetingNote,
  useGetCurrentUser,
  useDraftMeetingFollowUp,
  useGetCalendarEvent,
  useGetHousehold,
  useGetMeetingNote,
  useGetOrganization,
  useGetPerson,
  useProcessMeetingMedia,
  useUpdateMeetingNote,
  useUpdateCalendarEventAttendance,
  type MeetingArtifact,
  type CalendarEvent,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  AudioLines,
  Calendar,
  Camera,
  ChevronDown,
  CircleStop,
  ExternalLink,
  FileImage,
  Mail,
  Mic,
  Save,
  Trash2,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ContactPicker,
  MeetingNoteRow,
  type PickedContact,
} from "@/components/meeting-notes-panel";
import { AddTaskDialog } from "@/components/tasks-panel";
import {
  OrganizationRelationshipSummaryCard,
  PersonRelationshipSummaryCard,
} from "@/components/relationship-summary-card";
import { combineMeetingPhotoPages } from "@/lib/meeting-photo-pages";
import {
  meetingLinkIds,
  meetingLinksFromIds,
  uniqueMeetingLinks,
  type MeetingLink,
} from "@/lib/meeting-links";

type ContactRef = MeetingLink;

function MeetingAttendance({ event, editable, pending, onChange }: {
  event: CalendarEvent;
  editable: boolean;
  pending: boolean;
  onChange: (email: string, absent: boolean) => void;
}) {
  const invited = [...new Set((event.attendeeEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const speakers = event.transcriptAttendees ?? [];
  const byEmail = new Map(speakers.flatMap((speaker) => speaker.email ? [[speaker.email, speaker.name] as const] : []));
  const absent = new Set(event.absentAttendeeEmails);
  const guests = speakers.filter((speaker) => !speaker.email);
  if (!invited.length && !guests.length) return null;
  const held = Date.parse(event.endAt ?? event.startAt) <= Date.now() || speakers.length > 0;
  const confirmed = invited.filter((email) => byEmail.has(email) && !absent.has(email)).length;
  return (
    <details className="group rounded-lg border bg-card px-3 py-2.5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-sm [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-medium">
          <UsersRound className="h-4 w-4 text-muted-foreground" /> Attendance
        </span>
        <span className="text-muted-foreground">
          {confirmed > 0 ? `${confirmed} confirmed · ` : ""}
          {invited.length} invited{guests.length ? ` · ${guests.length} other speaker${guests.length === 1 ? "" : "s"}` : ""}
        </span>
        <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <ul className="mt-2 divide-y text-sm">
        {invited.map((email) => {
          const name = byEmail.get(email);
          const isAbsent = absent.has(email);
          return (
            <li key={email} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" title={email}>{name || email}</span>
              <span className="text-xs text-muted-foreground">
                {isAbsent ? "Absent" : name ? "In transcript" : held ? "Unconfirmed" : "Invited"}
              </span>
              {editable && (
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs"
                  disabled={pending} aria-label={`${isAbsent ? "Clear absence for" : "Mark absent:"} ${email}`}
                  onClick={() => onChange(email, !isAbsent)}>
                  {isAbsent ? "Undo" : "Mark absent"}
                </Button>
              )}
            </li>
          );
        })}
        {guests.map(({ name }) => (
          <li key={name} className="flex items-center justify-between gap-2 py-1.5">
            <span>{name}</span><span className="text-xs text-muted-foreground">In transcript · unmatched</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatMeetingTime(startAt: string, endAt?: string | null) {
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : null;
  return `${start.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}${
    end
      ? ` – ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
      : ""
  }`;
}

function ContactChoice({
  contact,
  linked,
  focused,
  onToggle,
  onFocus,
}: {
  contact: ContactRef;
  linked: boolean;
  focused: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const person = useGetPerson(contact.kind === "person" ? contact.id : "", {
    query: {
      enabled: contact.kind === "person",
      queryKey: getGetPersonQueryKey(
        contact.kind === "person" ? contact.id : "",
      ),
    },
  });
  const organization = useGetOrganization(
    contact.kind === "organization" ? contact.id : "",
    {
      query: {
        enabled: contact.kind === "organization",
        queryKey: getGetOrganizationQueryKey(
          contact.kind === "organization" ? contact.id : "",
        ),
      },
    },
  );
  const household = useGetHousehold(
    contact.kind === "household" ? contact.id : "",
    {
      query: {
        enabled: contact.kind === "household",
        queryKey: getGetHouseholdQueryKey(
          contact.kind === "household" ? contact.id : "",
        ),
      },
    },
  );
  const name =
    contact.kind === "person"
      ? person.data?.fullName ||
        [person.data?.firstName, person.data?.lastName]
          .filter(Boolean)
          .join(" ")
      : contact.kind === "organization"
        ? organization.data?.name
        : household.data?.name;
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${linked ? "border-primary bg-primary/5" : ""}`}
    >
      <Checkbox
        checked={linked}
        onCheckedChange={onToggle}
        aria-label={`${linked ? "Unlink" : "Link"} ${name || contact.id}`}
      />
      <button
        type="button"
        onClick={onFocus}
        className="min-w-0 flex-1 text-left hover:underline"
        aria-pressed={focused}
      >
        <span className="font-medium">{name || "Loading contact…"}</span>
        <span className="ml-2 text-xs capitalize text-muted-foreground">
          {contact.kind}
        </span>
      </button>
      {focused ? (
        <span className="text-xs text-muted-foreground">Briefing</span>
      ) : null}
    </div>
  );
}

function ContactPreparation({ contact }: { contact: ContactRef | null }) {
  if (!contact) {
    return (
      <p className="text-sm text-muted-foreground">
        Select a record to view its relationship briefing.
      </p>
    );
  }
  if (contact.kind === "person") {
    return (
      <PersonRelationshipSummaryCard personId={contact.id} meetingPreparation />
    );
  }
  if (contact.kind === "organization") {
    return (
      <OrganizationRelationshipSummaryCard
        organizationId={contact.id}
        meetingPreparation
      />
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      <Link
        href={`/households/${contact.id}`}
        className="text-primary hover:underline"
      >
        Open the household record
      </Link>{" "}
      for its members, giving history, and recent activity.
    </p>
  );
}

async function uploadPrivateFile(file: File) {
  const request = await fetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type || "application/octet-stream",
    }),
  });
  if (!request.ok) throw new Error("Could not prepare the source-file upload.");
  const upload = (await request.json()) as {
    uploadURL: string;
    objectPath: string;
  };
  const stored = await fetch(upload.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!stored.ok) throw new Error("Could not upload the meeting source file.");
  return upload.objectPath;
}

export default function MeetingWorkspacePage() {
  const { id = "", noteId: routeNoteId = "" } = useParams<{
    id?: string;
    noteId?: string;
  }>();
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();
  const isNewMeeting = id === "new";
  const eventId = routeNoteId || isNewMeeting ? "" : id;
  const event = useGetCalendarEvent(eventId, {
    query: {
      enabled: Boolean(eventId),
      queryKey: getGetCalendarEventQueryKey(eventId),
    },
  });
  const existingNoteId = routeNoteId || event.data?.meetingNoteId || "";
  const [createdNoteId, setCreatedNoteId] = useState("");
  const noteId = existingNoteId || createdNoteId;
  const note = useGetMeetingNote(noteId, {
    query: {
      enabled: Boolean(noteId),
      queryKey: getGetMeetingNoteQueryKey(noteId),
    },
  });
  const noteEventId = !eventId ? note.data?.calendarEventId ?? "" : "";
  const linkedEvent = useGetCalendarEvent(noteEventId, {
    query: { enabled: Boolean(noteEventId), queryKey: getGetCalendarEventQueryKey(noteEventId) },
  });
  const calendarEvent = event.data ?? linkedEvent.data;
  const [manualNotes, setManualNotes] = useState("");
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [showTranscriptInput, setShowTranscriptInput] = useState(false);
  const [showSources, setShowSources] = useState<boolean | null>(null);
  const [showBriefing, setShowBriefing] = useState<boolean | null>(null);
  useEffect(() => {
    if (event.data?.id && window.location.hash === "#meeting-preparation") {
      setShowBriefing(true);
      document.getElementById("meeting-preparation")?.scrollIntoView();
    }
  }, [event.data?.id]);
  const [artifacts, setArtifacts] = useState<MeetingArtifact[]>([]);
  const [photoPages, setPhotoPages] = useState<File[]>([]);
  const [linkedContacts, setLinkedContacts] = useState<ContactRef[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactRef | null>(
    null,
  );
  const [manualContact, setManualContact] = useState<PickedContact | null>(
    null,
  );
  const [recordingMode, setRecordingMode] = useState<
    "meeting" | "dictation" | null
  >(null);
  const [processingLabel, setProcessingLabel] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoLibraryInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptFileInput = useRef<HTMLInputElement | null>(null);
  const initializedNoteId = useRef("");
  const initializedLinksForRef = useRef<string | null>(null);
  const startedAtRef = useRef(new Date().toISOString());
  const draftKey = `wfcrm-meeting-draft:${routeNoteId || id}`;
  const transcriptDraftKey = `${draftKey}:transcript`;

  const requestedContact = useMemo<ContactRef | null>(() => {
    if (!isNewMeeting) return null;
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("contactKind");
    const contactId = params.get("contactId")?.trim();
    if (
      !contactId ||
      (kind !== "person" && kind !== "organization" && kind !== "household")
    ) {
      return null;
    }
    return { kind, id: contactId };
  }, [isNewMeeting, location]);

  const contacts = useMemo<ContactRef[]>(() => {
    const value = event.data;
    const linked: ContactRef[] = value
      ? [
          ...(value.matchedPersonIds ?? []).map((contactId) => ({
            kind: "person" as const,
            id: contactId,
          })),
          ...(value.matchedOrganizationIds ?? []).map((contactId) => ({
            kind: "organization" as const,
            id: contactId,
          })),
          ...(value.matchedHouseholdIds ?? []).map((contactId) => ({
            kind: "household" as const,
            id: contactId,
          })),
        ]
      : [];
    for (const contact of [
      ...meetingLinksFromIds(note.data ?? {}),
      ...linkedContacts,
      requestedContact,
    ]) {
      if (
        contact &&
        !linked.some(
          (item) => item.kind === contact.kind && item.id === contact.id,
        )
      ) {
        linked.push(contact);
      }
    }
    return linked;
  }, [event.data, note.data, linkedContacts, requestedContact]);

  useEffect(() => {
    if (!note.data) initializedNoteId.current = "";
    if (note.data && initializedNoteId.current !== note.data.id) {
      initializedNoteId.current = note.data.id;
      setManualNotes(
        sessionStorage.getItem(draftKey) ?? note.data.manualNotes ?? "",
      );
      setArtifacts(note.data.artifacts ?? []);
      const links = meetingLinksFromIds(note.data);
      setLinkedContacts(links);
      setSelectedContact(links[0] ?? null);
    }
  }, [note.data]);

  useEffect(() => {
    const draft = sessionStorage.getItem(transcriptDraftKey) ?? "";
    setTranscriptDraft(draft);
    setShowTranscriptInput(Boolean(draft));
    setShowSources(null);
    setShowBriefing(window.location.hash === "#meeting-preparation" ? true : null);
  }, [transcriptDraftKey]);

  useEffect(() => {
    if (!note.data && sessionStorage.getItem(draftKey)) {
      setManualNotes(sessionStorage.getItem(draftKey) ?? "");
    }
  }, [draftKey, note.data]);

  useEffect(() => {
    if (
      !noteId &&
      contacts.length > 0 &&
      initializedLinksForRef.current !== id
    ) {
      setLinkedContacts(contacts);
      setSelectedContact(contacts[0]);
      initializedLinksForRef.current = id;
    }
  }, [contacts, noteId, id]);

  useEffect(
    () => () => {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      streamsRef.current.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      void audioContextRef.current?.close();
    },
    [],
  );

  const create = useCreateMeetingNote();
  const attendance = useUpdateCalendarEventAttendance({
    mutation: {
      onSuccess: (_, { id }) => {
        void queryClient.invalidateQueries({
          queryKey: getGetCalendarEventQueryKey(id),
        });
        void queryClient.invalidateQueries({
          queryKey: getListCalendarEventsQueryKey(),
        });
      },
      onError: (error) =>
        toast({
          title: "Could not save attendance",
          description: error.message,
          variant: "destructive",
        }),
    },
  });
  const update = useUpdateMeetingNote();
  const processMedia = useProcessMeetingMedia();
  const draftFollowUp = useDraftMeetingFollowUp();

  function changeTranscriptDraft(value: string) {
    setTranscriptDraft(value);
    try {
      sessionStorage.setItem(transcriptDraftKey, value);
    } catch {
      // The current draft still works when browser storage is full.
    }
  }

  async function loadTranscriptFile(file: File) {
    try {
      if (file.size > 1_200_000) throw new Error("Choose a transcript of at most 300,000 characters.");
      const text = (await file.text()).trim();
      if (!text || text.length > 300_000 || text.includes("\0")) {
        throw new Error("Choose a nonempty text, VTT, or SRT transcript of at most 300,000 characters.");
      }
      changeTranscriptDraft(text);
      setShowTranscriptInput(true);
    } catch (error) {
      toast({ title: "Transcript could not be loaded", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  }

  async function processFile(
    file: File,
    kind: "handwritten_notes" | "audio_recording" | "voice_dictation",
  ) {
    setProcessingLabel(
      kind === "handwritten_notes"
        ? "Reading handwritten notes…"
        : kind === "voice_dictation"
          ? "Transcribing voice notes…"
          : "Transcribing recording…",
    );
    try {
      const objectPath = await uploadPrivateFile(file);
      const processed = await processMedia.mutateAsync({
        data: {
          kind,
          objectPath,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
      });
      setArtifacts((current) => [...current, processed]);
      toast({
        title:
          kind === "handwritten_notes"
            ? "Handwritten notes transcribed"
            : kind === "voice_dictation"
              ? "Voice notes transcribed"
              : "Recording transcribed",
      });
    } catch (error) {
      toast({
        title: "Source file could not be processed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setProcessingLabel("");
    }
  }

  async function processPhotoPages() {
    if (!photoPages.length) return;
    if (photoPages.length > 24) {
      toast({
        title: "Paper notes can have at most 24 pages",
        variant: "destructive",
      });
      return;
    }
    setProcessingLabel(
      `Reading ${photoPages.length} page${photoPages.length === 1 ? "" : "s"}…`,
    );
    try {
      const processed: MeetingArtifact[] = [];
      for (const file of photoPages) {
        const objectPath = await uploadPrivateFile(file);
        processed.push(
          await processMedia.mutateAsync({
            data: {
              kind: "handwritten_notes",
              objectPath,
              fileName: file.name,
              mimeType: file.type || "image/jpeg",
              sizeBytes: file.size,
            },
          }),
        );
      }
      const combined = combineMeetingPhotoPages(processed);
      setArtifacts((current) => [...current, combined]);
      setPhotoPages([]);
      toast({
        title: `${processed.length} paper-note page${processed.length === 1 ? "" : "s"} combined into one transcript`,
      });
    } catch (error) {
      toast({
        title: "Paper notes could not be processed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setProcessingLabel("");
    }
  }

  function updateArtifactTranscript(index: number, transcript: string) {
    setArtifacts((current) =>
      current.map((artifact, itemIndex) =>
        itemIndex === index ? { ...artifact, transcript } : artifact,
      ),
    );
  }

  async function startRecording(mode: "meeting" | "dictation") {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      (mode === "meeting" && !navigator.mediaDevices.getDisplayMedia) ||
      typeof MediaRecorder === "undefined"
    ) {
      toast({
        title: "Recording is not available in this browser",
        description: "Use current Chrome or Edge on the Windows computer.",
        variant: "destructive",
      });
      return;
    }
    if (
      mode === "meeting" &&
      !window.confirm(
        "Start recording after everyone in the meeting has agreed. The CRM will capture the shared system audio and your microphone.",
      )
    ) {
      return;
    }
    try {
      const display =
        mode === "meeting"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: true,
            })
          : null;
      streamsRef.current = display ? [display] : [];
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamsRef.current.push(microphone);
      const context = display ? new AudioContext() : null;
      audioContextRef.current = context;
      const destination = context?.createMediaStreamDestination() ?? null;
      if (display && context && destination) {
        if (display.getAudioTracks().length > 0) {
          context.createMediaStreamSource(display).connect(destination);
        }
        context.createMediaStreamSource(microphone).connect(destination);
      }
      const recordingStream = destination?.stream ?? microphone;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(recordingStream, {
        mimeType,
        audioBitsPerSecond: 24_000,
      });
      chunksRef.current = [];
      if (destination) streamsRef.current.push(destination.stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (item) => {
        if (item.data.size > 0) chunksRef.current.push(item.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        streamsRef.current.forEach((stream) =>
          stream.getTracks().forEach((track) => track.stop()),
        );
        streamsRef.current = [];
        void audioContextRef.current?.close();
        audioContextRef.current = null;
        recorderRef.current = null;
        setRecordingMode(null);
        if (blob.size > 0) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          void processFile(
            new File(
              [blob],
              `${mode === "dictation" ? "voice-notes" : "meeting"}-${stamp}.webm`,
              { type: "audio/webm" },
            ),
            mode === "dictation" ? "voice_dictation" : "audio_recording",
          );
        }
      };
      display?.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorder.state === "recording") recorder.stop();
      });
      recorder.start(1_000);
      setRecordingMode(mode);
    } catch (error) {
      streamsRef.current.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      streamsRef.current = [];
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      recorderRef.current = null;
      setRecordingMode(null);
      toast({
        title: "Recording did not start",
        description:
          error instanceof Error
            ? error.message
            : "Check the browser's microphone and screen-audio permissions.",
        variant: "destructive",
      });
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  async function saveMeeting(notify = true) {
    const links = meetingLinkIds(linkedContacts);
    if (
      !event.data?.id &&
      !note.data?.calendarEventId &&
      linkedContacts.length === 0
    ) {
      throw new Error(
        "Link at least one CRM record to a meeting without a calendar event. Your typed notes remain here.",
      );
    }
    let savedId = noteId;
    if (savedId) {
      const saved = await update.mutateAsync({
        id: savedId,
        data: {
          manualNotes: manualNotes.trim() || null,
          artifacts,
          transcript: transcriptDraft.trim() || undefined,
          ...links,
        },
      });
      setArtifacts(saved.artifacts ?? []);
    } else {
      const saved = await create.mutateAsync({
        data: {
          title:
            event.data?.summary?.trim() ||
            (isNewMeeting ? "Meeting" : undefined),
          meetingDate: event.data?.startAt ?? startedAtRef.current,
          attendees:
            event.data?.attendeeEmails?.filter(
              (email) =>
                !event.data?.absentAttendeeEmails?.includes(
                  email.trim().toLowerCase(),
                ),
            ) ?? undefined,
          calendarEventId: event.data?.id,
          manualNotes: manualNotes.trim() || undefined,
          transcript: transcriptDraft.trim() || undefined,
          artifacts: artifacts.length ? artifacts : undefined,
          ...links,
        },
      });
      savedId = saved.id;
      setArtifacts(saved.artifacts ?? []);
      setCreatedNoteId(saved.id);
      if (isNewMeeting) navigate(`/meetings/notes/${saved.id}`);
    }
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetMeetingNoteQueryKey(savedId),
      }),
      queryClient.invalidateQueries({
        queryKey: getListMeetingNotesQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: getListCalendarEventsQueryKey(),
      }),
      calendarEvent ? queryClient.invalidateQueries({ queryKey: getGetCalendarEventQueryKey(calendarEvent.id) }) : undefined,
    ]);
    if (notify) toast({ title: "Meeting notes saved" });
    sessionStorage.removeItem(draftKey);
    sessionStorage.removeItem(transcriptDraftKey);
    setTranscriptDraft("");
    setShowTranscriptInput(false);
    return savedId;
  }

  async function saveMeetingAndReport() {
    try {
      await saveMeeting();
    } catch (error) {
      toast({
        title: "Meeting notes could not be saved",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  }

  async function openFollowUpDraft() {
    try {
      const savedId = await saveMeeting();
      const draft = await draftFollowUp.mutateAsync({ id: savedId });
      const href = `mailto:${draft.recipients.join(",")}?subject=${encodeURIComponent(
        draft.subject,
      )}&body=${encodeURIComponent(draft.body)}`;
      window.location.href = href;
    } catch (error) {
      toast({
        title: "Follow-up draft could not be created",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  }

  if ((eventId && event.isLoading) || (routeNoteId && note.isLoading))
    return <p className="text-sm text-muted-foreground">Loading meeting…</p>;
  if (
    (eventId && (event.isError || !event.data)) ||
    (routeNoteId && (note.isError || !note.data)) ||
    (isNewMeeting && !requestedContact)
  ) {
    return (
      <p className="text-sm text-destructive">
        This meeting could not be loaded.
      </p>
    );
  }

  const hasNotes = Boolean(
    noteId || manualNotes.trim() || transcriptDraft.trim() || artifacts.length > 0,
  );
  const taskContext = { defaultLinks: meetingLinkIds(linkedContacts) };
  const meetingTitle =
    event.data?.summary?.trim() ||
    note.data?.title?.trim() ||
    (isNewMeeting ? "New meeting" : "Meeting workspace");
  const meetingStartAt =
    calendarEvent?.startAt ?? note.data?.meetingDate ?? startedAtRef.current;
  const isPastMeeting = !isNewMeeting && (
    Boolean(note.data?.aiSummary) || Date.parse(calendarEvent?.endAt ?? meetingStartAt) <= Date.now()
  );
  const briefingOpen = showBriefing ?? !isPastMeeting;
  const savedLinks = meetingLinksFromIds(note.data ?? {});
  const linksChanged = !!note.data && (linkedContacts.length !== savedLinks.length ||
    linkedContacts.some((link) => !savedLinks.some((saved) => saved.id === link.id && saved.kind === link.kind)));
  const sourcesOpen = showSources ?? (!isPastMeeting || !note.data || showTranscriptInput);
  let savedTranscript = note.data?.rawTranscript ?? "";
  // Earlier versions copied source artifacts into the combined transcript.
  // Each artifact already has its own entry and editor in this workspace.
  for (const artifact of note.data?.artifacts ?? []) {
    if (!artifact.transcript.trim()) continue;
    const label = artifact.kind === "handwritten_notes" ? "Handwritten notes" :
      artifact.kind === "voice_dictation" ? "Dictated voice notes" : "Recorded meeting";
    savedTranscript = savedTranscript
      .replace(`${label} (${artifact.fileName}):\n${artifact.transcript.trim()}`, "")
      .replace(`${label}:\n${artifact.transcript.trim()}`, "");
  }
  savedTranscript = savedTranscript.trim();
  const sourceCount = Number(Boolean(savedTranscript)) + Number(Boolean(manualNotes.trim())) + artifacts.length;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/meetings">
            <ArrowLeft className="mr-1 h-4 w-4" /> Meetings
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-serif font-bold">{meetingTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
                {formatMeetingTime(meetingStartAt, calendarEvent?.endAt)}
            </p>
          </div>
          <div className="flex gap-2">
            {calendarEvent?.htmlLink ? (
              <Button asChild variant="outline">
                <a href={calendarEvent.htmlLink} target="_blank" rel="noreferrer">
                  <Calendar className="mr-1 h-4 w-4" /> Calendar
                  <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-6">
          {calendarEvent && (
            <MeetingAttendance
              event={calendarEvent}
              editable={!!currentUser && currentUser.role !== "read_only"}
              pending={attendance.isPending}
              onChange={(emailAddress, absent) => attendance.mutate({ id: calendarEvent.id, data: { emailAddress, absent } })}
            />
          )}
          <Card id="meeting-preparation">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                Linked CRM records
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {contacts.length > 0 ? (
                <div className="space-y-2">
                  {contacts.map((contact) => (
                    <ContactChoice
                      key={`${contact.kind}-${contact.id}`}
                      contact={contact}
                      linked={linkedContacts.some(
                        (item) =>
                          item.kind === contact.kind && item.id === contact.id,
                      )}
                      focused={
                        selectedContact?.kind === contact.kind &&
                        selectedContact.id === contact.id
                      }
                      onToggle={() =>
                        setLinkedContacts((current) =>
                          current.some(
                            (item) =>
                              item.kind === contact.kind &&
                              item.id === contact.id,
                          )
                            ? current.filter(
                                (item) =>
                                  item.kind !== contact.kind ||
                                  item.id !== contact.id,
                              )
                            : uniqueMeetingLinks([...current, contact]),
                        )
                      }
                      onFocus={() => { setSelectedContact(contact); setShowBriefing(true); }}
                    />
                  ))}
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>Add another CRM record</Label>
                <ContactPicker
                  value={manualContact}
                  onChange={(contact) => {
                    setManualContact(contact);
                    if (contact) {
                      const link = { kind: contact.kind, id: contact.id };
                      setLinkedContacts((current) =>
                        uniqueMeetingLinks([...current, link]),
                      );
                      setSelectedContact(link);
                    }
                  }}
                />
              </div>
              {selectedContact && (
                <details open={briefingOpen} onToggle={(item) => {
                  if (item.currentTarget.open !== briefingOpen) setShowBriefing(item.currentTarget.open);
                }} className="group border-t pt-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
                    {isPastMeeting ? "Relationship briefing" : "Pre-meeting briefing"}
                    <ChevronDown className="h-4 w-4 text-muted-foreground group-open:rotate-180" />
                  </summary>
                  <div className="mt-3">
                    {briefingOpen && <ContactPreparation contact={selectedContact} />}
                  </div>
                </details>
              )}
              {linksChanged && currentUser?.role !== "read_only" && (
                <Button type="button" variant="outline" size="sm" disabled={update.isPending}
                  onClick={async () => {
                    if (!noteId) return;
                    try {
                      const saved = await update.mutateAsync({ id: noteId, data: meetingLinkIds(linkedContacts) });
                      queryClient.setQueryData(getGetMeetingNoteQueryKey(noteId), saved);
                      void queryClient.invalidateQueries({ queryKey: getListMeetingNotesQueryKey() });
                      toast({ title: "Meeting links saved" });
                    } catch (error) {
                      toast({ title: "Could not save meeting links", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
                    }
                  }}>
                  Save links
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {note.data && (
            <Card className={isPastMeeting ? undefined : "order-1"}>
              <CardContent className="pt-5">
                <ul><MeetingNoteRow note={note.data} workspace /></ul>
              </CardContent>
            </Card>
          )}
          <details open={sourcesOpen} onToggle={(item) => {
            if (item.currentTarget.open !== sourcesOpen) setShowSources(item.currentTarget.open);
          }} className="group rounded-xl border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
              Meeting sources
              {sourceCount > 0 && <Badge variant="secondary">{sourceCount}</Badge>}
              <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 px-5 pb-5">
              <div className="space-y-2">
                <Label htmlFor="meeting-live-notes">Live notes</Label>
                <Textarea
                  id="meeting-live-notes"
                  value={manualNotes}
                  onChange={(item) => {
                    setManualNotes(item.target.value);
                    sessionStorage.setItem(draftKey, item.target.value);
                  }}
                  rows={5}
                  placeholder="Add notes from the meeting…"
                  data-testid="input-meeting-live-notes"
                />
              </div>
              {savedTranscript && (
                <details className="rounded-md border px-3 py-2 text-sm">
                  <summary className="cursor-pointer font-medium">Saved transcript</summary>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{savedTranscript}</pre>
                </details>
              )}
              {note.data?.summaryOnly && (
                <p className="text-xs text-muted-foreground">Summary-only mode discards transcript text after processing.</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={Boolean(processingLabel) || Boolean(recordingMode)}>
                      Add source <ChevronDown className="ml-1 h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => setShowTranscriptInput(true)}>Paste transcript</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => transcriptFileInput.current?.click()}>Upload transcript</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => photoInputRef.current?.click()}><Camera className="mr-2 h-4 w-4" /> Photograph paper notes</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => photoLibraryInputRef.current?.click()}><FileImage className="mr-2 h-4 w-4" /> Choose page images</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void startRecording("meeting")}><Mic className="mr-2 h-4 w-4" /> Record meeting</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void startRecording("dictation")}><AudioLines className="mr-2 h-4 w-4" /> Dictate notes</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {recordingMode && (
                  <Button type="button" size="sm" variant="destructive" onClick={stopRecording}>
                    <CircleStop className="mr-1 h-4 w-4" /> Stop {recordingMode === "dictation" ? "dictation" : "recording"}
                  </Button>
                )}
                <input ref={photoInputRef} type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={(item) => {
                    const file = item.target.files?.[0];
                    if (file) setPhotoPages((current) => [...current, file]);
                    item.target.value = "";
                  }} />
                <input ref={photoLibraryInputRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={(item) => {
                    setPhotoPages((current) => [...current, ...Array.from(item.target.files ?? [])]);
                    item.target.value = "";
                  }} />
                <input ref={transcriptFileInput} type="file" accept=".txt,.vtt,.srt,text/plain,text/vtt" className="hidden"
                  onChange={(item) => {
                    const file = item.target.files?.[0];
                    item.target.value = "";
                    if (file) void loadTranscriptFile(file);
                  }} />
              </div>
              {showTranscriptInput && (
                <div className="space-y-2">
                  <Label htmlFor="meeting-transcript-input">Transcript to add</Label>
                  <Textarea id="meeting-transcript-input" rows={6} value={transcriptDraft} maxLength={300000}
                    placeholder="Paste transcript text or Zoom captions…"
                    onChange={(item) => changeTranscriptDraft(item.target.value)} />
                  <Button type="button" variant="ghost" size="sm" onClick={() => {
                    changeTranscriptDraft("");
                    setShowTranscriptInput(false);
                  }}>Discard transcript draft</Button>
                </div>
              )}
              {photoPages.length > 0 ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">
                    Paper notes: {photoPages.length} page
                    {photoPages.length === 1 ? "" : "s"} queued in order
                  </p>
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    {photoPages.map((file, index) => (
                      <li key={`${file.name}-${index}`}>
                        {file.name}{" "}
                        <button
                          type="button"
                          className="text-destructive underline"
                          onClick={() =>
                            setPhotoPages((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ol>
                  <Button
                    type="button"
                    disabled={Boolean(processingLabel)}
                    onClick={() => void processPhotoPages()}
                  >
                    Transcribe {photoPages.length} page
                    {photoPages.length === 1 ? "" : "s"} as one note
                  </Button>
                </div>
              ) : null}
              {processingLabel ? (
                <p className="text-sm text-primary">{processingLabel}</p>
              ) : null}

              {artifacts.map((artifact, index) => (
                <div
                  key={artifact.id}
                  className="space-y-2 rounded-md border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {artifact.kind === "handwritten_notes" ? (
                        <FileImage className="h-4 w-4 shrink-0" />
                      ) : (
                        <AudioLines className="h-4 w-4 shrink-0" />
                      )}
                      <span className="truncate text-sm font-medium">
                        {artifact.fileName}
                      </span>
                      <Badge variant="secondary">
                        {artifact.kind === "handwritten_notes"
                          ? "Photo"
                          : artifact.kind === "voice_dictation"
                            ? "Voice notes"
                            : "Recording"}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${artifact.fileName}`}
                      onClick={() =>
                        setArtifacts((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {(artifact.sourcePages?.length
                      ? artifact.sourcePages
                      : [artifact]
                    ).map((page, pageIndex) => (
                      <a
                        key={`${page.objectPath}-${pageIndex}`}
                        href={`/api/storage${page.objectPath}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline"
                      >
                        {artifact.sourcePages?.length
                          ? `Source page ${pageIndex + 1}`
                          : "Source file"}
                      </a>
                    ))}
                  </div>
                  <Label htmlFor={`artifact-transcript-${index}`}>
                    Transcript
                  </Label>
                  <Textarea
                    id={`artifact-transcript-${index}`}
                    value={artifact.transcript}
                    onChange={(item) =>
                      updateArtifactTranscript(index, item.target.value)
                    }
                    rows={7}
                  />
                </div>
              ))}

              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !hasNotes ||
                    Boolean(processingLabel) ||
                    create.isPending ||
                    update.isPending
                  }
                  onClick={() => void saveMeetingAndReport()}
                >
                  <Save className="mr-1 h-4 w-4" /> Save sources
                </Button>
              </div>
              {linkedContacts.length === 0 && hasNotes && !calendarEvent ? (
                <p className="text-right text-sm text-amber-700">
                  Link a CRM record before saving this standalone meeting.
                </p>
              ) : null}
            </div>
          </details>
          <div className="order-2 flex flex-wrap justify-end gap-2">
            <AddTaskDialog ctx={taskContext} trigger={<Button variant="outline" size="sm">Add task</Button>} />
            <Button type="button" variant="outline" size="sm"
              disabled={!hasNotes || Boolean(processingLabel) || create.isPending || update.isPending || draftFollowUp.isPending}
              onClick={() => void openFollowUpDraft()}>
              <Mail className="mr-1 h-4 w-4" /> Draft follow-up email
            </Button>
          </div>
        </div>
      </div>

    </div>
  );
}
