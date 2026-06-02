---
name: Entity-merge cascade-delete lock
description: Why the funder/people merge transaction must lock entity rows FOR UPDATE before rewriting/deleting.
---

# Entity merge must lock the entity rows FOR UPDATE before delete

The funder/people "merge duplicates" engine repoints all child references from the
loser rows to the primary, then deletes the losers — all in one transaction. It
**must** `SELECT id FROM <funders|people> WHERE id = ANY(allIds) FOR UPDATE` at the
top of that transaction, before any rewrite.

**Why:** Several child FKs to funders/people are `ON DELETE CASCADE`
(addresses, emails, phone_numbers, people_entity_roles, person_suppression_windows).
Without the lock, a concurrent INSERT of a child row pointing at a loser can land
*between* the FK rewrite and the loser DELETE and then be silently cascade-deleted —
real data loss. (The `restrict` FKs — gifts/opps/meeting_notes — are already safe:
the delete just aborts the txn.) `FOR UPDATE` conflicts with the `FOR KEY SHARE`
lock a child INSERT takes on its parent, so the concurrent insert blocks until the
merge commits and then fails its own FK check instead of vanishing. It also
serializes overlapping merges of the same records.

**How to apply:** Any future bulk-delete-after-reassign flow against a parent that
has cascade-delete children needs the same parent-row `FOR UPDATE` lock. Don't
assume "reassign then delete" is safe under concurrency just because references were
repointed first.

**Adjacent guard:** `merge-entities.test.ts` derives every id-targeting FK straight
from the Drizzle schema and asserts the merge config covers them exactly — a new FK
to funders/people will fail that test rather than silently orphan/cascade rows on
merge. Keep that guard; don't loosen it without listing the omission + reason.
