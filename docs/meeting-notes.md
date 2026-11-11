---
status: ratified
last_verified: 2026-11-11
---

# Meeting-note links

A meeting note is one record, optionally anchored to one synced calendar event, and can be explicitly linked to any number of people, organizations, and households. None of those CRM links is "primary." A calendar-anchored note may have no CRM match yet; a standalone note needs a CRM link or a weekly development agenda.

`meeting_notes.person_ids`, `organization_ids`, and `household_ids` are the authoritative CRM links, following the existing free-form `notes` and `interactions` array pattern. The meeting workspace initially selects all calendar-matched records, lets staff remove incorrect matches or add other records, and never infers an exclusive person-versus-organization choice. A note appears once in each linked record's activity and meeting views. Promoted tasks inherit the complete set of note links.

The former `person_id`, `organization_id`, and `household_id` columns are migration-only compatibility columns. They must not be read or written by the new application. Migration 0272 backfills the arrays from them and removes the old XOR constraint. Their transitional constraint allowance exists only to admit old-app writes between migration and Publish; rerun 0272 immediately after Publish to backfill any such rows. Once that release window is closed and verified, a later cleanup can drop the legacy columns and tighten the constraint to array links or event only.

The calendar event remains the meeting's identity anchor and is unique on `meeting_notes`; linking several CRM records never creates duplicate notes. Calendar sync owns matched-record suggestions, while meeting-note links are staff-editable CRM associations and do not change when a person changes organizations.

## Capture and follow-up tasks

Voice dictation is cleaned for readability without summarizing distinct facts;
if cleanup fails, the original transcription remains available. Next-step
proposals use the shared Anthropic integration, concurrency limit, and retry
boundary. Only staff notes and source transcripts establish tasks: generated
summaries and earlier generated action items are not evidence of a commitment.
Each proposal must quote source evidence, duplicates are removed, and no tasks
is a valid result. At most six proposals are presented for explicit review.

Generating tasks saves the current source notes silently; the independent Save
notes action keeps its save notification. The review dialog uses wrapped task
text, expands on desktop, fits mobile, and blocks repeated confirmation while
creation is pending. The Meetings owner filter is stored for each CRM account
in browser storage until the user changes it.

## Weekly development meetings

Meetings → Weekly development meetings opens a shared agenda for the selected
Chicago calendar week. The occurrence uses the regular meeting note with a
unique week as its anchor. It can exist before any CRM donor or synced
calendar event is attached. Staff can reorder and run the agenda, add public
findings or shared Grant Leads, pick donors, and record item-level notes and
decisions. The donor panel shows the relationship owner, open asks and
pledges, recent interactions, and open tasks.

Agenda tasks use regular CRM tasks. Staff choose the assignee and may set a
due date. Pending or deferred discussion items and their open tasks carry
forward to the next agenda, with prior decisions retained in history. Staff
can filter meeting history by donor and review linked task statuses.
Concurrent edits are checked against the saved agenda item revision.

Staff can paste or upload a transcript into the occurrence to generate a
summary and proposed next steps. The existing summary-only privacy preference
still controls raw transcript retention. Suggestions from saved discussion
notes use the existing evidence-based task proposal workflow. Staff choose
the agenda item and assignee before creating a task. Automatic Zoom recording
and transcript delivery require the separate Zoom integration.

Apply database migration 0279 after 0272 and before publishing the app that
opens development agendas. Migration 0279 extends the meeting note anchor
constraint and creates the agenda and funder scan tables. Keep the 0279
constraint in place for existing weekly agendas.
