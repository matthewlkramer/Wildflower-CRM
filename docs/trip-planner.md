---
status: ratified
last_verified: 2026-09-30
---

# Trip planner

## Product behavior

- A trip belongs to one active CRM team user and has one required availability
  window. Its destination is optional so tentative travel can be recorded
  before a city is chosen. The interface does not ask for separate travel dates,
  meeting dates, or outbound and return travel time.
- The compatibility fields `travel_starts_at` and `travel_ends_at` store that
  availability window. The older optional meeting-window and travel-minute
  columns remain nullable for compatibility, are cleared whenever a trip is
  saved in the CRM, and are not separate planning authorities.
- Every trip has an IANA `time_zone`. The destination state selects a sensible
  US default and the editor can override it. Travel windows, booking times,
  confirmed visits, calendar day headings, and calendar-event times are all
  rendered in that trip zone and include an explicit abbreviation such as EDT.
- The visit list is editable CRM planning state. A team member can add, remove,
  reorder, and annotate people. The add dialog accepts multiple selections and
  submits them together. Each person has separate planning notes and a
  next step, plus the name and timestamp of the teammate who last edited those
  fields. The system-draft action adds up to 25 active,
  living CRM people whose address city (and state, when entered) exactly matches
  the destination and whose own solicitation priority, or a current affiliated
  organization's solicitation priority, is `medium`, `high`, or `top`. It orders
  eligible people by the highest applicable priority and then traveler ownership.
  Low-priority and unprioritized people and organizations are never system-drafted.
  The action never overwrites a team's existing refinements; manual additions
  remain available regardless of priority.
- Each visit row has two planning actions. `Unavailable` archives the candidate
  and immediately hides them from this trip; adding the person later revives
  that row. `Update from Gmail & Calendar` asks AI to review the latest visible
  messages for that person together with matching trip-window Calendar events.
  For the mailbox owner, it also performs a bounded, read-only Gmail lookup.
  This recovers messages placed in the unmatched ledger before a personal
  address was linked to the CRM and delivery failures elsewhere in the same
  conversation, without moving a sync cursor. It classifies the latest status
  as not invited, invited, bounced, responded, or confirmed and extracts a
  meeting time only when the evidence supports one. The review result and
  timestamp are cached on the visit row; Gmail and Google Calendar remain the
  underlying authorities. A later synced
  message or Calendar change automatically makes the cached review stale, so
  the normal source-derived status takes over until the next AI review.
- The trip index can be filtered to one team traveler. Each trip card identifies
  its traveler, travel dates, and destination city when one has been entered.
- Invitation, response, scheduled-meeting, scheduled-time, and availability
  fields are derived at read time. They are never stored as a second status.
- The trip summary separates detected flights and hotels. It shows each
  booking's dates, location, and confirmation number when available; otherwise
  it displays `No flights` or `No hotel booked`. Dated Gmail bookings and
  Calendar bookings also appear in the schedule. Lodging confirmations take
  precedence over incidental flight-like codes in their body text.

## Evidence and privacy boundaries

- Gmail owns message facts. A candidate is `invited` only when a visible sent
  message from the traveler's synced mailbox contains meeting/visit language.
  `responded` requires a later visible received message in the same Gmail
  thread. Private messages are visible and count only for their mailbox owner.
  A permanent delivery failure for the trip invitation produces `bounced`;
  unrelated auto-replies do not count as a response.
- Flight and hotel evidence is derived at read time from the trip window's
  visible Calendar events and the traveler's synced Gmail message index. A
  bounded set of travel-shaped messages that did not match a CRM contact is
  fetched from Gmail for the traveler without persisting the message body.
  Gmail booking details are available only to the mailbox owner; teammates see
  only Calendar evidence allowed by the existing event privacy rule. Cancelled
  Calendar events are excluded, and Gmail evidence must match the trip's dates
  or destination.
- Google Calendar owns event facts. Every regular calendar sync also performs a
  bounded-date sweep for each of the user's active CRM trip windows, which
  captures complete schedule details even when no attendee matches a CRM
  contact. This sweep is necessary because Google's incremental cursor does not
  replay an unchanged event merely because a trip was added later.
- Creating, changing, or archiving a trip marks the affected traveler's
  calendar sync due, so the in-process scheduler performs the bounded pass on
  its next tick rather than waiting for the normal steady-state interval.
- Unmatched trip-window events default private. The traveler can see their full
  details; other team members see only events permitted by the existing
  calendar privacy rule. A manual privacy choice remains authoritative across
  later syncs. Unmatched rows are removed after they no longer overlap an active
  trip, unless a CRM note is linked to the event.
- A candidate is scheduled when a visible event matches the person. Only busy,
  non-cancelled event overlap inside the availability window is subtracted from
  estimated availability; Google events marked `transparent` remain visible
  but do not consume available time.
- The availability estimate is viewer-scoped: it is the availability-window
  duration minus the union of overlapping events visible to the caller, so
  simultaneous events are not double-counted. The traveler sees the full
  primary-calendar schedule captured for their trip dates; another team member
  may see a partial estimate when the traveler has private events.
- The trip calendar hides birthday events by default. A viewer can also hide
  any other event for that trip and later reveal or restore hidden events. This
  browser-persisted choice is keyed by the Google calendar and event IDs so it
  survives a refreshed CRM calendar row. It changes only the trip calendar
  presentation: it does not alter Google Calendar, shared synced evidence, or
  availability math.

## Data model

- `trip_plans` is the CRM-owned trip header, stores the display `time_zone`,
  and is soft-deleted with `archived_at`.
- `trip_visit_candidates` is unique by trip and person. Removing a person
  archives the row; adding them again revives it. `source` distinguishes a
  `system_draft` suggestion from a `manual` addition. The `evidence_*` fields
  cache the most recent AI review of source-owned Gmail and Calendar facts so
  the result remains visible after a page reload.
  When a current review supplies the displayed outreach status, its summary
  takes precedence over dates from an older raw keyword match that may relate
  to a different trip.
- No trip table points to Gmail messages or Calendar events. Evidence links are
  derived from the existing matched-person arrays, mailbox/calendar owner, and
  provider thread/event facts.
- Travel bookings are likewise derived response data rather than stored trip
  state, so Gmail and Google Calendar remain authoritative.
- `trip_plans.notes` is the shared, editable trip scratchpad.
- `trip_plan_comments` is an append-only team discussion with an author and
  timestamp on every comment; it never overwrites the scratchpad.
