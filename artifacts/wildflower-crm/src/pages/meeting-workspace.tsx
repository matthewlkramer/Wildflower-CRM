import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeetingNoteQueryKey,
  getGetHouseholdQueryKey,
  getGetOrganizationQueryKey,
  getGetPersonQueryKey,
  getListCalendarEventsQueryKey,
  getListMeetingNotesQueryKey,
  getListTasksQueryKey,
  useCreateMeetingNote,
  useCreateTask,
  useDraftMeetingFollowUp,
  useGenerateMeetingNextSteps,
  useGetCalendarEvent,
  useGetHousehold,
  useGetMeetingNote,
  useGetOrganization,
  useGetPerson,
  useProcessMeetingMedia,
  useUpdateMeetingNote,
  type MeetingArtifact,
  type MeetingNextStepProposal,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  AudioLines,
  Calendar,
  Camera,
  CircleStop,
  ExternalLink,
  FileImage,
  Mail,
  Mic,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ContactPicker,
  MeetingNextStepsProposalDialog,
  MeetingNoteRow,
  type PickedContact,
} from "@/components/meeting-notes-panel";
import { AddTaskDialog } from "@/components/tasks-panel";
import {
  OrganizationRelationshipSummaryCard,
  PersonRelationshipSummaryCard,
} from "@/components/relationship-summary-card";

type ContactKind = "person" | "organization" | "household";
type ContactRef = { kind: ContactKind; id: string };

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
  selected,
  onSelect,
}: {
  contact: ContactRef;
  selected: boolean;
  onSelect: () => void;
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
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"
      }`}
      aria-pressed={selected}
    >
      <span className="font-medium">{name || "Loading contact…"}</span>
      <span className="ml-2 text-xs capitalize text-muted-foreground">
        {contact.kind}
      </span>
    </button>
  );
}

function ContactPreparation({ contact }: { contact: ContactRef | null }) {
  if (!contact) {
    return (
      <p className="text-sm text-muted-foreground">
        Choose the primary contact to load the relationship briefing.
      </p>
    );
  }
  if (contact.kind === "person") {
    return <PersonRelationshipSummaryCard personId={contact.id} />;
  }
  if (contact.kind === "organization") {
    return <OrganizationRelationshipSummaryCard organizationId={contact.id} />;
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
  const { id = "" } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const event = useGetCalendarEvent(id);
  const existingNoteId = event.data?.meetingNoteId ?? "";
  const [createdNoteId, setCreatedNoteId] = useState("");
  const noteId = existingNoteId || createdNoteId;
  const note = useGetMeetingNote(noteId, {
    query: {
      enabled: Boolean(noteId),
      queryKey: getGetMeetingNoteQueryKey(noteId),
    },
  });
  const [manualNotes, setManualNotes] = useState("");
  const [artifacts, setArtifacts] = useState<MeetingArtifact[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactRef | null>(
    null,
  );
  const [manualContact, setManualContact] = useState<PickedContact | null>(null);
  const [recording, setRecording] = useState(false);
  const [processingLabel, setProcessingLabel] = useState("");
  const [proposals, setProposals] = useState<MeetingNextStepProposal[]>([]);
  const [proposalOpen, setProposalOpen] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const contacts = useMemo<ContactRef[]>(() => {
    const value = event.data;
    if (!value) return [];
    return [
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
    ];
  }, [event.data]);

  useEffect(() => {
    if (note.data) {
      setManualNotes(note.data.manualNotes ?? "");
      setArtifacts(note.data.artifacts ?? []);
      setSelectedContact(
        note.data.personId
          ? { kind: "person", id: note.data.personId }
          : note.data.organizationId
            ? { kind: "organization", id: note.data.organizationId }
            : note.data.householdId
              ? { kind: "household", id: note.data.householdId }
              : null,
      );
    }
  }, [note.data]);

  useEffect(() => {
    if (!noteId && !selectedContact && contacts.length === 1) {
      setSelectedContact(contacts[0]);
    }
  }, [contacts, noteId, selectedContact]);

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
  const update = useUpdateMeetingNote();
  const processMedia = useProcessMeetingMedia();
  const generate = useGenerateMeetingNextSteps();
  const createTask = useCreateTask();
  const draftFollowUp = useDraftMeetingFollowUp();

  async function processFile(
    file: File,
    kind: "handwritten_notes" | "audio_recording",
  ) {
    setProcessingLabel(
      kind === "handwritten_notes"
        ? "Reading handwritten notes…"
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

  function updateArtifactTranscript(index: number, transcript: string) {
    setArtifacts((current) =>
      current.map((artifact, itemIndex) =>
        itemIndex === index ? { ...artifact, transcript } : artifact,
      ),
    );
  }

  async function startRecording() {
    if (
      !navigator.mediaDevices?.getDisplayMedia ||
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
      !window.confirm(
        "Start recording after everyone in the meeting has agreed. The CRM will capture the shared system audio and your microphone.",
      )
    ) {
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      if (display.getAudioTracks().length > 0) {
        context.createMediaStreamSource(display).connect(destination);
      }
      context.createMediaStreamSource(microphone).connect(destination);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(destination.stream, {
        mimeType,
        audioBitsPerSecond: 24_000,
      });
      chunksRef.current = [];
      streamsRef.current = [display, microphone, destination.stream];
      audioContextRef.current = context;
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
        setRecording(false);
        if (blob.size > 0) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          void processFile(
            new File([blob], `meeting-${stamp}.webm`, { type: "audio/webm" }),
            "audio_recording",
          );
        }
      };
      display.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorder.state === "recording") recorder.stop();
      });
      recorder.start(1_000);
      setRecording(true);
    } catch (error) {
      streamsRef.current.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      setRecording(false);
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

  async function saveMeeting() {
    if (!event.data || !selectedContact)
      throw new Error("Choose a primary contact.");
    const contact = {
      personId:
        selectedContact.kind === "person" ? selectedContact.id : undefined,
      organizationId:
        selectedContact.kind === "organization"
          ? selectedContact.id
          : undefined,
      householdId:
        selectedContact.kind === "household" ? selectedContact.id : undefined,
    };
    let savedId = noteId;
    if (savedId) {
      await update.mutateAsync({
        id: savedId,
        data: {
          manualNotes: manualNotes.trim() || null,
          artifacts,
          ...contact,
        },
      });
    } else {
      const saved = await create.mutateAsync({
        data: {
          title: event.data.summary?.trim() || undefined,
          meetingDate: event.data.startAt,
          attendees: event.data.attendeeEmails ?? undefined,
          calendarEventId: event.data.id,
          manualNotes: manualNotes.trim() || undefined,
          artifacts: artifacts.length ? artifacts : undefined,
          ...contact,
        },
      });
      savedId = saved.id;
      setCreatedNoteId(saved.id);
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
    ]);
    toast({ title: "Meeting notes saved" });
    return savedId;
  }

  async function saveAndGenerateTasks() {
    try {
      const savedId = await saveMeeting();
      const result = await generate.mutateAsync({ id: savedId });
      setProposals(result.proposals);
      setProposalOpen(true);
    } catch (error) {
      toast({
        title: "Next steps could not be generated",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
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

  if (event.isLoading)
    return <p className="text-sm text-muted-foreground">Loading meeting…</p>;
  if (event.isError || !event.data) {
    return (
      <p className="text-sm text-destructive">
        This meeting could not be loaded.
      </p>
    );
  }

  const canSave = Boolean(
    selectedContact && (noteId || manualNotes.trim() || artifacts.length > 0),
  );
  const taskContext = selectedContact
    ? {
        personId:
          selectedContact.kind === "person" ? selectedContact.id : undefined,
        organizationId:
          selectedContact.kind === "organization"
            ? selectedContact.id
            : undefined,
        householdId:
          selectedContact.kind === "household" ? selectedContact.id : undefined,
      }
    : {};

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
            <h1 className="text-3xl font-serif font-bold">
              {event.data.summary?.trim() || "Meeting workspace"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatMeetingTime(event.data.startAt, event.data.endAt)}
            </p>
          </div>
          <div className="flex gap-2">
            {event.data.htmlLink ? (
              <Button asChild variant="outline">
                <a href={event.data.htmlLink} target="_blank" rel="noreferrer">
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
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="h-4 w-4 text-primary" /> Meeting
                preparation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {contacts.length > 0 ? (
                <div className="space-y-2">
                  <Label>Primary contact</Label>
                  {contacts.map((contact) => (
                    <ContactChoice
                      key={`${contact.kind}-${contact.id}`}
                      contact={contact}
                      selected={
                        selectedContact?.kind === contact.kind &&
                        selectedContact.id === contact.id
                      }
                      onSelect={() => {
                        setManualContact(null);
                        setSelectedContact(contact);
                      }}
                    />
                  ))}
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>
                  {contacts.length > 0
                    ? "Or link another CRM contact"
                    : "Primary contact"}
                </Label>
                <ContactPicker
                  value={manualContact}
                  onChange={(contact) => {
                    setManualContact(contact);
                    setSelectedContact(
                      contact ? { kind: contact.kind, id: contact.id } : null,
                    );
                  }}
                />
              </div>
              <ContactPreparation contact={selectedContact} />
              {event.data.description ? (
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Calendar description
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {event.data.description}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                Notes and source material
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="meeting-live-notes">Live notes</Label>
                <Textarea
                  id="meeting-live-notes"
                  value={manualNotes}
                  onChange={(item) => setManualNotes(item.target.value)}
                  rows={14}
                  placeholder="Take notes while you talk…"
                  data-testid="input-meeting-live-notes"
                />
                <p className="text-xs text-muted-foreground">
                  Saved verbatim and kept separate from generated summaries.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={Boolean(processingLabel)}
                >
                  <Camera className="mr-1 h-4 w-4" /> Photograph paper notes
                </Button>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(item) => {
                    const file = item.target.files?.[0];
                    if (file) void processFile(file, "handwritten_notes");
                    item.target.value = "";
                  }}
                />
                {recording ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={stopRecording}
                  >
                    <CircleStop className="mr-1 h-4 w-4" /> Stop recording
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void startRecording()}
                    disabled={Boolean(processingLabel)}
                  >
                    <Mic className="mr-1 h-4 w-4" /> Record meeting
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Recording asks you to choose the meeting window with system
                audio and then enables your microphone. The CRM does not join
                the video call.
              </p>
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
                      <a
                        href={`/api/storage${artifact.objectPath}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-sm font-medium text-primary hover:underline"
                      >
                        {artifact.fileName}
                      </a>
                      <Badge variant="secondary">
                        {artifact.kind === "handwritten_notes"
                          ? "Photo"
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
                <AddTaskDialog
                  ctx={taskContext}
                  trigger={
                    <Button variant="outline" disabled={!selectedContact}>
                      Add task by hand
                    </Button>
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canSave || create.isPending || update.isPending}
                  onClick={() => void saveMeetingAndReport()}
                >
                  <Save className="mr-1 h-4 w-4" /> Save notes
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canSave || generate.isPending}
                  onClick={() => void saveAndGenerateTasks()}
                >
                  <Sparkles className="mr-1 h-4 w-4" /> Generate next tasks
                </Button>
                <Button
                  type="button"
                  disabled={!canSave || draftFollowUp.isPending}
                  onClick={() => void openFollowUpDraft()}
                >
                  <Mail className="mr-1 h-4 w-4" /> Draft follow-up email
                </Button>
              </div>
              <p className="text-right text-xs text-muted-foreground">
                The email opens in your computer’s mail app. You review and send
                it yourself.
              </p>
            </CardContent>
          </Card>

          {note.data ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Saved meeting record</CardTitle>
              </CardHeader>
              <CardContent>
                <ul>
                  <MeetingNoteRow note={note.data} />
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      <MeetingNextStepsProposalDialog
        open={proposalOpen}
        proposals={proposals}
        onOpenChange={setProposalOpen}
        onConfirm={async (selected) => {
          await Promise.all(
            selected.map((proposal) =>
              createTask.mutateAsync({
                data: {
                  title: proposal.title,
                  description: proposal.description ?? undefined,
                  dueDate: proposal.dueDate ?? undefined,
                  assigneeUserId: proposal.assigneeUserId ?? undefined,
                  personIds: taskContext.personId
                    ? [taskContext.personId]
                    : undefined,
                  organizationIds: taskContext.organizationId
                    ? [taskContext.organizationId]
                    : undefined,
                  householdIds: taskContext.householdId
                    ? [taskContext.householdId]
                    : undefined,
                },
              }),
            ),
          );
          await queryClient.invalidateQueries({
            queryKey: getListTasksQueryKey(),
          });
          setProposalOpen(false);
          toast({
            title: `${selected.length} task${selected.length === 1 ? "" : "s"} created`,
          });
        }}
      />
    </div>
  );
}
