---
name: emails global uniqueness
description: email addresses are globally unique on lower(email); how it's enforced and how the dedupe migration must behave.
---

# Email addresses are globally unique (case-insensitive)

An email address may be attached to exactly ONE `emails` row anywhere in the CRM
(person / organization / payment-intermediary / household). Uniqueness is on
`lower(email)` (no trim), enforced by the `emails_email_lower_unique` functional
unique index + an API `23505 → 409` map in `routes/emails.ts` (POST + PATCH).

**Why:** confirmed product rule ("no email entered twice anywhere"); real data
held a case-only duplicate, so the index normalizes on `lower(email)` to match
the normalization every read path already uses (no trimming anywhere).

**How to apply (dedupe migrations / prod):**
- The DB unique index is the source of truth — never replace it with pre-check
  -only logic, and never let a Publish drop it (it is declared in the Drizzle
  schema, so keep it there).
- A dedupe must repoint the ONLY FK to `emails.id` —
  `email_proposals.target_email_id` (which is `ON DELETE SET NULL`) — off the
  rows it deletes *before* the DELETE, via a separate UPDATE (not a single
  data-modifying CTE), so ordering is guaranteed.
- Keeper rule: `is_preferred DESC, created_at ASC, id ASC`.
- Prod sequence: run the dedupe-and-index SQL file FIRST, THEN Publish. Both
  declare the same index name; running the idempotent file first cleans dupes so
  the unique-index build can't fail, and makes Publish's diff a no-op.
