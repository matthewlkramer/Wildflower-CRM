export const ZOOM_START_WINDOW_MS = 20 * 60_000;

export function zoomMeetingIdFromInvite(
  ...fields: (string | null | undefined)[]
): string | null {
  const ids = new Set<string>();
  for (const field of fields) {
    const links = field?.match(/https:\/\/[^\s<>"']+/gi) ?? [];
    for (const link of links) {
      try {
        const url = new URL(link);
        if (
          url.username ||
          url.password ||
          url.port ||
          (url.hostname !== "zoom.us" && !url.hostname.endsWith(".zoom.us"))
        )
          continue;
        const id = /^\/(?:j|wc\/join)\/(\d{9,11})\/?$/.exec(url.pathname)?.[1];
        if (id) ids.add(id);
      } catch {
        // An invite may contain malformed text alongside a valid join link.
      }
    }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

type MeetingEvent = {
  kind: "started" | "joined" | "ended" | "transcript";
  uuid: string;
  hostId: string;
  meetingId: string;
  at: Date;
  hostEmail: string | null;
  participantEmail: string | null;
  meetingType: number | null;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function email(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  return address.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)
    ? address
    : null;
}

export function parseZoomMeetingEvent(
  event: string,
  payload: unknown,
  eventTime: number | undefined,
  accountId: string,
  now = Date.now(),
): MeetingEvent | null {
  const kind =
    event === "meeting.started"
      ? "started"
      : event === "meeting.participant_joined"
        ? "joined"
        : event === "meeting.ended"
          ? "ended"
          : event === "meeting.aic_transcript_completed"
            ? "transcript"
            : null;
  const body = object(payload);
  const meeting = object(body?.object);
  if (
    !kind ||
    !meeting ||
    body?.account_id !== accountId ||
    !Number.isSafeInteger(eventTime) ||
    eventTime! > now + 60_000 ||
    now - eventTime! > 7 * 86_400_000
  )
    return null;
  const uuid = kind === "transcript" ? meeting.meeting_uuid : meeting.uuid;
  const id = kind === "transcript" ? meeting.meeting_id : meeting.id;
  const meetingId =
    typeof id === "string" || typeof id === "number" ? String(id) : "";
  const hostId = meeting.host_id;
  if (
    typeof uuid !== "string" ||
    !/^[\w+/=-]{1,128}$/.test(uuid) ||
    typeof hostId !== "string" ||
    !/^[\w-]{1,128}$/.test(hostId) ||
    !/^\d{9,11}$/.test(meetingId)
  )
    return null;
  if (kind === "transcript" && meeting.attach_type !== "durable_transcript")
    return null;
  const hostEmail = email(meeting.host_email);
  const participantEmail = email(object(meeting.participant)?.email);
  const meetingType =
    typeof meeting.type === "number" &&
    [0, 1, 2, 3, 4, 8].includes(meeting.type)
      ? meeting.type
      : null;
  if (kind === "started" && (!hostEmail || meetingType === null)) return null;
  if (kind === "joined" && !participantEmail) return null;
  return {
    kind,
    uuid,
    hostId,
    meetingId,
    at: new Date(eventTime!),
    hostEmail,
    participantEmail,
    meetingType,
  };
}
