import {
  useListConferenceEvents,
  useListConferenceTypes,
} from "@workspace/api-client-react";

export function ConferenceAttendanceFilter({
  eventId,
  typeId,
  onChange,
  testId,
}: {
  eventId: string;
  typeId: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  const types = useListConferenceTypes({ active: true });
  const events = useListConferenceEvents();
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      Conference attendance
      <select
        className="h-8 rounded border bg-background px-2 text-sm text-foreground"
        value={eventId ? `event:${eventId}` : typeId ? `type:${typeId}` : ""}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      >
        <option value="">Any attendance</option>
        <optgroup label="Ever attended">
          {types.data?.map((type) => (
            <option key={type.id} value={`type:${type.id}`}>
              {type.displayName}
            </option>
          ))}
        </optgroup>
        <optgroup label="Specific event">
          {events.data?.map((event) => (
            <option key={event.id} value={`event:${event.id}`}>
              {event.conferenceTypeName} {event.year}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
