export type TripTravelBookingKind = "flight" | "hotel";
export type TripTravelBookingSource = "calendar" | "gmail";

type TripWindow = {
  travelStartsAt: Date | string;
  travelEndsAt: Date | string;
  destinationCity?: string | null;
};

export type TripTravelEvidence = {
  id: string;
  source: TripTravelBookingSource;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
  sentAt?: Date | string | null;
  fromEmail?: string | null;
  gmailMessageId?: string | null;
  htmlLink?: string | null;
  status?: string | null;
};

export type DerivedTripTravelBooking = {
  kind: TripTravelBookingKind;
  source: TripTravelBookingSource;
  sourceId: string;
  title: string;
  provider: string | null;
  confirmationNumber: string | null;
  startAt: string | null;
  endAt: string | null;
  location: string | null;
  details: string | null;
  sourceUrl: string | null;
};

const FLIGHT_IN_TITLE = /\bflight\b/i;
const FLIGHT_DOCUMENT = /\b(?:boarding pass|record locator|e-?ticket)\b/i;
const FLIGHT_BOOKING_CONTEXT =
  /\b(?:booking|confirm(?:ation|ed)?|gate|itinerary|passenger|reservation|seat|terminal|ticket)\b/i;
const FLIGHT_NUMBER_CONTEXT =
  /\b(?:airline|airport|departure|departing|arrival|arriving)\b/i;
const HOTEL_LANGUAGE =
  /\b(?:accommodation|hotel|lodging|room reservation|stay at)\b/i;
const HOTEL_CONFIRMATION_TITLE =
  /\b(?:booking|reservation)\s+confirm(?:ation|ed)\b/i;
const HOTEL_CHECK_DATES = /\bcheck[ -]?(?:in|out)\b/i;
const HOTEL_GUEST_CONTEXT = /\b(?:guest|reservation|room|stay)\b/i;
const FLIGHT_NUMBER =
  /\b(?!(?:Q[1-4]|FY)\b)(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4}\b/;
const CONFIRMATION_PATTERNS = [
  /\bconfirmation(?:\s+(?:number|no\.?|code))?\s*[:#-]?\s*([A-Z0-9]{5,12})\b/i,
  /\b(?:record locator|booking reference|reservation number)\s*[:#-]?\s*([A-Z0-9]{5,12})\b/i,
  /\bconf(?:irmation)?\s*#\s*([A-Z0-9]{5,12})\b/i,
];
const INVALID_CONFIRMATIONS = new Set([
  "BOOKING",
  "CONFIRM",
  "CONFIRMED",
  "DETAILS",
  "FLIGHT",
  "HOTEL",
  "NUMBER",
  "RESERVATION",
]);
const MONTH_DATE =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)?/gi;
const NUMERIC_DATE =
  /\b\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)?/gi;

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  return asDate(value)?.toISOString() ?? null;
}

function evidenceText(evidence: TripTravelEvidence): string {
  return [
    evidence.title,
    evidence.description,
    evidence.location,
    evidence.fromEmail,
  ]
    .filter(Boolean)
    .join(" \n")
    .slice(0, 30_000);
}

export function detectTripTravelKind(
  evidence: Pick<
    TripTravelEvidence,
    "title" | "description" | "location" | "fromEmail"
  >,
): TripTravelBookingKind | null {
  const text = evidenceText({ id: "", source: "calendar", ...evidence });
  const title = evidence.title?.trim() ?? "";
  const hasFlightNumber = FLIGHT_NUMBER.test(text.toUpperCase());
  // Ordinary correspondence often mentions somebody's arrival, departure,
  // airport, or flight while coordinating a meeting. Treat those as travel
  // bookings only when the subject explicitly identifies a flight, the
  // message contains a booking document marker, or a flight number appears
  // alongside itinerary/booking context.
  if (
    FLIGHT_IN_TITLE.test(title) ||
    FLIGHT_DOCUMENT.test(text) ||
    (hasFlightNumber &&
      (FLIGHT_BOOKING_CONTEXT.test(text) ||
        FLIGHT_NUMBER_CONTEXT.test(text))) ||
    (/\bflight\b/i.test(text) && FLIGHT_BOOKING_CONTEXT.test(text))
  ) {
    return "flight";
  }
  if (
    HOTEL_LANGUAGE.test(title) ||
    (HOTEL_LANGUAGE.test(text) &&
      ((HOTEL_CHECK_DATES.test(text) && HOTEL_GUEST_CONTEXT.test(text)) ||
        HOTEL_CONFIRMATION_TITLE.test(title) ||
        extractTravelConfirmation(text) !== null))
  ) {
    return "hotel";
  }
  return null;
}

export function extractTravelConfirmation(text: string): string | null {
  const bounded = text.slice(0, 30_000);
  for (const pattern of CONFIRMATION_PATTERNS) {
    const value = pattern.exec(bounded)?.[1]?.toUpperCase() ?? null;
    if (value && !INVALID_CONFIRMATIONS.has(value)) return value;
  }
  return null;
}

function parseDateText(value: string, fallbackYear: number): Date | null {
  const hasYear = /\b\d{4}\b/.test(value);
  const withYear = hasYear ? value : `${value}, ${fallbackYear}`;
  const date = new Date(withYear.replace(/\bat\b/i, ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function datesFromText(text: string, fallbackYear: number): Date[] {
  const matches = [
    ...(text.match(MONTH_DATE) ?? []),
    ...(text.match(NUMERIC_DATE) ?? []),
  ];
  const unique = new Map<number, Date>();
  for (const match of matches.slice(0, 12)) {
    const parsed = parseDateText(match, fallbackYear);
    if (parsed) unique.set(parsed.getTime(), parsed);
  }
  return [...unique.values()].sort((a, b) => a.getTime() - b.getTime());
}

function emailDatesForTrip(text: string, trip: TripWindow) {
  const tripStart = asDate(trip.travelStartsAt)!;
  const tripEnd = asDate(trip.travelEndsAt)!;
  const padding = 3 * 86_400_000;
  const dates = datesFromText(text, tripStart.getUTCFullYear()).filter(
    (date) =>
      date.getTime() >= tripStart.getTime() - padding &&
      date.getTime() <= tripEnd.getTime() + padding,
  );
  return {
    startAt: dates[0]?.toISOString() ?? null,
    endAt: dates.length > 1 ? dates[dates.length - 1].toISOString() : null,
  };
}

function providerFromEmail(value: string | null | undefined): string | null {
  const domain = value
    ?.split("@")[1]
    ?.toLowerCase()
    .replace(/^mail\./, "");
  if (!domain) return null;
  const label = domain.split(".")[0]?.replace(/[-_]+/g, " ").trim();
  return label
    ? label.replace(/\b\w/g, (letter) => letter.toUpperCase())
    : null;
}

function gmailEvidenceMatchesTrip(
  text: string,
  dates: { startAt: string | null; endAt: string | null },
  trip: TripWindow,
): boolean {
  if (dates.startAt) return true;
  const destination = trip.destinationCity?.trim().toLowerCase();
  return !!destination && text.toLowerCase().includes(destination);
}

function bookingKey(booking: DerivedTripTravelBooking): string {
  if (booking.confirmationNumber) {
    return `${booking.kind}:confirmation:${booking.confirmationNumber}`;
  }
  const title = booking.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${booking.kind}:${title}:${booking.startAt?.slice(0, 10) ?? "unknown"}`;
}

export function deriveTripTravelBookings(
  trip: TripWindow,
  evidence: readonly TripTravelEvidence[],
): DerivedTripTravelBooking[] {
  const bookings: DerivedTripTravelBooking[] = [];
  for (const item of evidence) {
    if (item.status === "cancelled") continue;
    const kind = detectTripTravelKind(item);
    if (!kind) continue;
    const text = evidenceText(item);
    const emailDates =
      item.source === "gmail"
        ? emailDatesForTrip(text, trip)
        : { startAt: null, endAt: null };
    if (
      item.source === "gmail" &&
      !gmailEvidenceMatchesTrip(text, emailDates, trip)
    ) {
      continue;
    }
    const startAt = toIso(item.startAt) ?? emailDates.startAt;
    const endAt = toIso(item.endAt) ?? emailDates.endAt;
    bookings.push({
      kind,
      source: item.source,
      sourceId: item.id,
      title: item.title?.trim() || (kind === "flight" ? "Flight" : "Hotel"),
      provider:
        item.source === "gmail" ? providerFromEmail(item.fromEmail) : null,
      confirmationNumber: extractTravelConfirmation(text),
      startAt,
      endAt,
      location: item.location?.trim() || null,
      details: item.description?.trim().slice(0, 2_000) || null,
      sourceUrl:
        item.htmlLink ??
        (item.gmailMessageId
          ? `https://mail.google.com/mail/u/0/#all/${item.gmailMessageId}`
          : null),
    });
  }

  const deduped = new Map<string, DerivedTripTravelBooking>();
  for (const booking of bookings) {
    const key = bookingKey(booking);
    const existing = deduped.get(key);
    if (
      !existing ||
      (existing.source === "gmail" && booking.source === "calendar")
    ) {
      deduped.set(key, booking);
    }
  }
  return [...deduped.values()].sort((a, b) => {
    if (!a.startAt && !b.startAt) return a.title.localeCompare(b.title);
    if (!a.startAt) return 1;
    if (!b.startAt) return -1;
    return a.startAt.localeCompare(b.startAt);
  });
}
