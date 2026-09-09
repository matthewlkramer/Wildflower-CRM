export type TripWindow = { startAt: Date; endAt: Date };

/** Coalesce overlapping/adjacent trip ranges before querying Google Calendar. */
export function mergeTripWindows(windows: TripWindow[]): TripWindow[] {
  const sorted = windows
    .filter(
      (window) =>
        Number.isFinite(window.startAt.getTime()) &&
        Number.isFinite(window.endAt.getTime()) &&
        window.endAt > window.startAt,
    )
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const merged: TripWindow[] = [];
  for (const window of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || window.startAt > previous.endAt) {
      merged.push({ ...window });
      continue;
    }
    if (window.endAt > previous.endAt) previous.endAt = window.endAt;
  }
  return merged;
}

/** Google timeMin/timeMax semantics: event end is after start; start is before end. */
export function eventOverlapsTripWindows(
  eventStart: Date,
  eventEnd: Date | null,
  windows: TripWindow[],
): boolean {
  const start = eventStart.getTime();
  const end = Math.max(eventEnd?.getTime() ?? start, start + 1);
  return windows.some(
    (window) =>
      end > window.startAt.getTime() && start < window.endAt.getTime(),
  );
}

/** Default privacy before the calendar owner makes an explicit CRM choice. */
export function shouldAutoPrivateCalendarEvent(
  hasCrmMatch: boolean,
  googleVisibility?: string | null,
): boolean {
  return (
    !hasCrmMatch ||
    googleVisibility === "private" ||
    googleVisibility === "confidential"
  );
}
