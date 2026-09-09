---
status: ratified
last_verified: 2026-09-09
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
- The visit list is editable CRM planning state. A team member can add, remove,
  reorder, and annotate people. The system-draft action adds up to 25 active,
  living CRM people whose address city (and state, when entered) exactly matches
  the destination and whose own solicitation priority, or a current affiliated
  organization's solicitation priority, is `medium`, `high`, or `top`. It orders
  eligible people by the highest applicable priority and then traveler ownership.
  Low-priority and unprioritized people and organizations are never system-drafted.
  The action never overwrites a team's existing refinements; manual additions
  remain available regardless of priority.
- Invitation, response, scheduled-meeting, scheduled-time, and availability
  fields are derived at read time. They are never stored as a second status.

## Evidence and privacy boundaries

- Gmail owns message facts. A candidate is `invited` only when a visible sent
  message from the traveler's synced mailbox contains meeting/visit language.
  `responded` requires a later visible received message in the same Gmail
  thread. Private messages are visible and count only for their mailbox owner.
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

## Data model

- `trip_plans` is the CRM-owned trip header and is soft-deleted with
  `archived_at`.
- `trip_visit_candidates` is unique by trip and person. Removing a person
  archives the row; adding them again revives it. `source` distinguishes a
  `system_draft` suggestion from a `manual` addition.
- No trip table points to Gmail messages or Calendar events. Evidence links are
  derived from the existing matched-person arrays, mailbox/calendar owner, and
  provider thread/event facts.
