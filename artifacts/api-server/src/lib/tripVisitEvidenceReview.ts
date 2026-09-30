const VALID_STATUSES = new Set([
  "not_invited",
  "invited",
  "responded",
  "confirmed",
  "bounced",
]);

export type TripVisitEvidenceStatus =
  | "not_invited"
  | "invited"
  | "responded"
  | "confirmed"
  | "bounced";

export interface TripVisitEvidenceReview {
  status: TripVisitEvidenceStatus;
  summary: string;
  confirmedTime: string | null;
  confirmedAt: string | null;
}

export interface TripVisitEvidenceInput {
  trip: {
    title?: string | null;
    destinationCity?: string | null;
    destinationState?: string | null;
    timeZone: string;
    travelStartsAt: Date;
    travelEndsAt: Date;
  };
  personName: string;
  messages: Array<{
    id: string;
    direction: string;
    sentAt: Date;
    subject?: string | null;
    snippet?: string | null;
    bodyText?: string | null;
    aiSummary?: string | null;
  }>;
  calendarEvents: Array<{
    id: string;
    summary?: string | null;
    description?: string | null;
    location?: string | null;
    startAt: Date | string;
    endAt?: Date | string | null;
    status?: string | null;
  }>;
}

export function parseTripVisitEvidenceReview(
  input: Record<string, unknown>,
): TripVisitEvidenceReview | null {
  if (typeof input.status !== "string" || !VALID_STATUSES.has(input.status)) {
    return null;
  }
  const summary =
    typeof input.summary === "string" ? input.summary.trim().slice(0, 500) : "";
  if (!summary) return null;
  const confirmedTime =
    typeof input.confirmedTime === "string" && input.confirmedTime.trim()
      ? input.confirmedTime.trim().slice(0, 160)
      : null;
  const rawConfirmedAt =
    typeof input.confirmedAt === "string" ? input.confirmedAt.trim() : "";
  const confirmedAt =
    rawConfirmedAt && Number.isFinite(new Date(rawConfirmedAt).getTime())
      ? new Date(rawConfirmedAt).toISOString()
      : null;
  const status = input.status as TripVisitEvidenceStatus;

  // A confirmation must contain an actual time. An agreement to meet without
  // one is still a response and should not be presented as scheduled.
  if (status === "confirmed" && !confirmedTime && !confirmedAt) {
    return {
      status: "responded",
      summary,
      confirmedTime: null,
      confirmedAt: null,
    };
  }
  return { status, summary, confirmedTime, confirmedAt };
}
