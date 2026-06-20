---
name: Bulk owner-reassignment column coverage
description: Which user FK columns an offboarding/owner-reassignment must move vs. must preserve, and why there's no test guarding the set.
---

# Bulk owner-reassignment (offboarding) column coverage

A bulk "reassign all of user A's records to user B" must update **every
owner/assignee FK to `users`**, but must **leave provenance FKs untouched**.

**Owner/assignee columns to MOVE** (these are ON DELETE RESTRICT, so they block
archiving a departing user until reassigned):
people.owner_user_id, organizations.owner_user_id,
opportunities_and_pledges.owner_user_id, gifts_and_payments.owner_user_id,
interactions.owner_user_id, tasks.assignee_user_id, grant_leads.assignee_user_id.

**Provenance / system FKs to PRESERVE** (never bulk-reassign): tasks.created_by_user_id,
any *createdBy/author/resolvedBy/convertedBy/archivedBy*, audit-log actor,
mailbox/email-sync ownership, and personal saved-views ownership.

**Why this is a recurring trap:** the owner-vs-provenance distinction is a
judgment call, not something grep tells you — many tables have *several* user
FKs and only one is "ownership." Unlike entity-merge (which has an FK-inventory
drift test that derives the expected set from the schema and fails on drift),
the reassignment route has **no such guard**. So a newly-added owner/assignee
column can be silently missed. `grant_leads.assignee_user_id` was missed on the
first pass and only caught in code review.

**How to apply:** whenever you add a new table with an `owner_user_id` or
`assignee_user_id` (or rename one), update the reassignment route's count +
transaction + the OwnedRecordCounts spec/UI in lockstep. The DB-backed
integration test seeds one row per owner-bearing table — extend it too. Consider
adding a schema-derived inventory test mirroring the merge one if this set keeps
growing.
