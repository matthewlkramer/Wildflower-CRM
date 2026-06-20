---
name: Staff-default permanent sync suppression
description: How email/calendar sync auto-suppresses Wildflower staff (internal-domain email owners) and the cache-invalidation contract that keeps it correct.
---

# Staff-default permanent sync suppression

Email/calendar sync treats a PERSON who owns an internal-domain email
(`wildflowerschools.org` / `blackwildflowers.org`, configurable via the
`internal_email_domains` singleton) as Wildflower staff and, BY DEFAULT,
**permanently** suppresses them — they are never attached as a `matched_person`
on a synced `email_messages` / `calendar_events` row.

Rule (derived, never written):
`suppressed(person, date) = (an explicit window covers date) OR (person owns an
internal email AND has NO suppression-window rows at all)`.

**Window overrides the default.** Adding ANY `person_suppression_windows` row for
that person removes them from the staff-default set; from then on only the
window's dates govern. This lets an admin convert "always suppressed" into a
specific employment window.

**Why:** the team needs staff (incl. former staff) kept off donor timelines
without per-person bookkeeping, but must still be able to surface a specific
person for a bounded period.

## Former-staff stickiness invariant

Stickiness relies on the internal-domain email staying on the person record after
they leave. **Do NOT delete a staff member's internal email to "reactivate" their
sync — add an explicit window instead.** Deleting the email silently drops them
out of the staff set with no audit trail.

## Cache-invalidation contract

The staff-default set is cached (short TTL) because `matchEmails` would otherwise
recompute it per synced message. It is derived from the **emails** table, so
**every** write that can change internal-domain email ownership must bust the
cache — not just suppression-window or internal-domain-list edits. Known paths:

- suppression-window create / update / delete
- internal-domain-list change
- direct emails create / update / delete
- proposal-apply actions that attach a person email (add-email, create-person)
- person merge (re-points `emails.person_id` between records)

**Why:** a warm cache otherwise mis-attributes a just-added staff person (or
keeps suppressing a removed one) for up to the TTL during sync — and this is
easy to miss because the writers are spread across several modules.

**How to apply:** any new code that writes `emails.email` / `emails.person_id`
(bulk importers, merges, admin tools) must also invalidate the staff-default
cache, then prove it with a warm-cache → mutate → re-read-without-manual-
invalidate test.

## Retroactive cleanup ordering

The one-time backfill that strips already-synced staff matches must run in this
order (encoded in the cleanup SQL): insert-skip → delete-orphans → trim-partials
→ trim-calendar. A row with ONLY staff person matches and no org/household match
is orphaned: copy it into `email_sync_skip` first, then delete it (mirrors live
unmatched-mail semantics). Rows that still have a non-staff match are kept with
staff ids trimmed. **Calendar events are never deleted** (there is no calendar
skip table) — only trimmed. The cleanup is idempotent (overlap predicates +
`ON CONFLICT DO NOTHING`).
