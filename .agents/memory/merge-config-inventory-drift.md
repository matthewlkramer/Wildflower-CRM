---
name: merge-config FK inventory test
description: New tables with FKs targeting organizations/people must be registered in mergeEntities or a schema-derived test fails.
---

# Merge-config FK inventory must track every donor-linked FK

`artifacts/api-server/src/lib/mergeEntities.ts` lists every FK column that the
entity-merge engine reassigns from a "loser" record to the surviving "primary"
(`ORGANIZATION_FK_REFS`, `PERSON_FK_REFS`). A unit test in
`merge-entities.test.ts` **derives the expected set directly from the Drizzle
schema** (every FK targeting `organizations.id` / `people.id`) and asserts the
config matches exactly, minus an `EXPECTED_FK_OMISSIONS` allowlist.

**Rule:** whenever you add a table (or column) with a FK to `organizations` or
`people`, add it to the matching `*_FK_REFS` array (or to
`EXPECTED_FK_OMISSIONS` with a reason). There is no household merge config today,
so household FKs aren't checked.

**Why:** if a FK is `onDelete: "set null"` and isn't reassigned, merging two
entities silently nulls that link when the loser row is deleted — quiet data
loss, not an error. The inventory test is the guardrail.

**How to apply:** this test catches cross-task drift too — a separately-merged
feature (`grant_leads.target_organization_id`) had never been registered, so a
later schema addition surfaced the long-standing gap. If the org/person merge
inventory test fails after you add an unrelated table, check for a pre-existing
unregistered FK, not just your own.
