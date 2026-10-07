---
status: ratified
last_verified: 2026-10-07
---

# Meeting-note links

A meeting note is one record, optionally anchored to one synced calendar event, and can be explicitly linked to any number of people, organizations, and households. None of those CRM links is "primary." A calendar-anchored note may have no CRM match yet; a standalone note must have at least one CRM link.

`meeting_notes.person_ids`, `organization_ids`, and `household_ids` are the authoritative CRM links, following the existing free-form `notes` and `interactions` array pattern. The meeting workspace initially selects all calendar-matched records, lets staff remove incorrect matches or add other records, and never infers an exclusive person-versus-organization choice. A note appears once in each linked record's activity and meeting views. Promoted tasks inherit the complete set of note links.

The former `person_id`, `organization_id`, and `household_id` columns are migration-only compatibility columns. They must not be read or written by the new application. Migration 0272 backfills the arrays from them and removes the old XOR constraint. Their transitional constraint allowance exists only to admit old-app writes between migration and Publish; rerun 0272 immediately after Publish to backfill any such rows. Once that release window is closed and verified, a later cleanup can drop the legacy columns and tighten the constraint to array links or event only.

The calendar event remains the meeting's identity anchor and is unique on `meeting_notes`; linking several CRM records never creates duplicate notes. Calendar sync owns matched-record suggestions, while meeting-note links are staff-editable CRM associations and do not change when a person changes organizations.
