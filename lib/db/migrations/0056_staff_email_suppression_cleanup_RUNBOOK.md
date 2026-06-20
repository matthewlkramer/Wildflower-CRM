# Runbook — 0056_staff_email_suppression_cleanup

## What this does

Retroactively enforces the new **staff-default permanent sync suppression** on
data that was already synced before the feature shipped.

The feature: any **person** who owns an internal-domain email
(`wildflowerschools.org` / `blackwildflowers.org`, or whatever
`internal_email_domains` holds) is, by default, **permanently** suppressed from
email/calendar sync — i.e. that person is treated as Wildflower staff and must
never appear in `matched_person_ids` on a synced row. Admins can override an
individual via an explicit suppression window; **any** window (regardless of its
dates) removes the person from the staff-default set.

This file applies that rule to **existing** `email_messages` and
`calendar_events`:

- **(A) → (B)** An `email_messages` row whose person match(es) are *all* staff
  and which has **no** organization/household match becomes orphaned: it is first
  copied into `email_sync_skip` (so the sync won't re-create it), then deleted —
  exactly the live skip-table semantics for unmatched mail.
- **(C)** An `email_messages` row that still has another match (a non-staff
  person, or an org/household) is **kept**, with the staff person id(s) trimmed
  out of `matched_person_ids` (set to `NULL` when it becomes empty but an
  org/household match remains).
- **(D)** `calendar_events` are **never deleted** (there is no calendar skip
  table) — their `matched_person_ids` is trimmed the same way.

### Scope: staff-default only (windows untouched)

A person who has an **explicit** suppression window is intentionally **not**
touched by this file. A window overrides the staff default, and date-aware window
cleanup is the job of the `backfill-sync-suppression` script. Production
currently has **0** suppression windows, so in practice every internal-email
person is staff-default here.

### Mirrors the live matcher

The staff set is computed exactly as `emailMatcher.ts`
`loadStaffDefaultSuppressedPersonIds` does: people with an internal-domain email
and `NOT EXISTS` any `person_suppression_windows` row. The internal-domain list
is read from the `internal_email_domains` singleton, falling back to the two
hardcoded defaults if that row is absent.

## Safety

- **Additive where it can be, and fully idempotent.** Re-running is a no-op:
  orphan rows are already deleted, partial rows no longer overlap staff, and the
  skip inserts are `ON CONFLICT (mailbox_user_id, gmail_message_id) DO NOTHING`.
  Verified on development — a second apply produced `INSERT 0 0 / DELETE 0 /
  UPDATE 0 / UPDATE 0`.
- **Deletes are not data loss.** Every deleted `email_messages` row is first
  written to `email_sync_skip` (statement A) — the same table the live sync uses
  to remember "don't import this message." The message body was a staff↔staff /
  unmatched email with no donor relevance.
- **Ordering matters and is encoded in the file:** (A) insert-skip → (B) delete
  orphans → (C) trim partials → (D) trim calendar. (C) must run after (B) because
  it nulls the arrays the orphan predicate keys on.
- **No schema dependency.** All tables/columns already exist; this is a pure data
  change. No `BEGIN`/`COMMIT` in the file — `psql -1` wraps it in one
  transaction.
- **Applied + verified in development already** (numbers below).

## Preflight (production, before apply)

```sql
-- Staff set + how many synced rows currently leak a staff match.
WITH dom AS (
  SELECT COALESCE((SELECT domains FROM internal_email_domains WHERE id='singleton'),
                  ARRAY['wildflowerschools.org','blackwildflowers.org']) AS domains
),
staff AS (
  SELECT DISTINCT e.person_id FROM emails e, dom
  WHERE e.person_id IS NOT NULL
    AND lower(split_part(e.email,'@',2)) = ANY(dom.domains)
    AND NOT EXISTS (SELECT 1 FROM person_suppression_windows w WHERE w.person_id=e.person_id)
),
staff_arr AS (SELECT COALESCE(array_agg(person_id),'{}'::text[]) AS ids FROM staff),
em AS (
  SELECT cardinality(ARRAY(SELECT unnest(m.matched_person_ids) EXCEPT SELECT unnest(s.ids))) AS remaining,
         COALESCE(cardinality(m.matched_organization_ids),0) AS orgs,
         COALESCE(cardinality(m.matched_household_ids),0)    AS hh
  FROM email_messages m, staff_arr s
  WHERE m.matched_person_ids && s.ids
)
SELECT
  (SELECT count(*) FROM staff)                                              AS staff_people,
  (SELECT count(*) FROM person_suppression_windows)                        AS windows,
  (SELECT count(*) FROM em)                                                 AS emails_overlap_staff,
  (SELECT count(*) FROM em WHERE remaining=0 AND orgs=0 AND hh=0)           AS email_orphans_delete,
  (SELECT count(*) FROM em WHERE NOT (remaining=0 AND orgs=0 AND hh=0))     AS email_partials_trim,
  (SELECT count(*) FROM calendar_events c, staff_arr s
     WHERE c.matched_person_ids && s.ids)                                   AS calendar_trim;
```

`email_orphans_delete` should equal the `DELETE` count below; `email_partials_trim`
the first `UPDATE`; `calendar_trim` the second `UPDATE`. (The skip `INSERT` count
may be a few **less** than `email_orphans_delete` if some orphans were already
present in `email_sync_skip` — that is expected and harmless.)

## How to apply (production, by a human)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0056_staff_email_suppression_cleanup.sql
```

Expected output shape (4 lines): `INSERT 0 <orphans>` · `DELETE <orphans>` ·
`UPDATE <partials>` · `UPDATE <calendar>`. On a re-run (already applied):
`INSERT 0 0` · `DELETE 0` · `UPDATE 0` · `UPDATE 0`.

## Verify (production, after apply)

```sql
-- Expect 0 / 0: no synced row leaks a staff match anymore.
WITH dom AS (
  SELECT COALESCE((SELECT domains FROM internal_email_domains WHERE id='singleton'),
                  ARRAY['wildflowerschools.org','blackwildflowers.org']) AS domains
),
staff AS (
  SELECT DISTINCT e.person_id FROM emails e, dom
  WHERE e.person_id IS NOT NULL
    AND lower(split_part(e.email,'@',2)) = ANY(dom.domains)
    AND NOT EXISTS (SELECT 1 FROM person_suppression_windows w WHERE w.person_id=e.person_id)
),
staff_arr AS (SELECT COALESCE(array_agg(person_id),'{}'::text[]) AS ids FROM staff)
SELECT
  (SELECT count(*) FROM email_messages m, staff_arr s WHERE m.matched_person_ids && s.ids) AS emails_overlap_now,
  (SELECT count(*) FROM calendar_events c, staff_arr s WHERE c.matched_person_ids && s.ids) AS calendar_overlap_now;
```

## Development apply — actual numbers (2026-06-20)

Preflight (before): 30 staff people · 0 windows · 106,828 `email_messages` ·
**7,862** overlap staff → **5,693** orphans + **2,169** partials · **456**
calendar events overlap · 298,007 existing `email_sync_skip` rows.

Apply output:

```
INSERT 0 5689   -- 4 orphans were already in email_sync_skip (ON CONFLICT DO NOTHING)
DELETE 5693
UPDATE 2169     -- email_messages partials trimmed
UPDATE 456      -- calendar_events trimmed
```

After: **0** email overlap · **0** calendar overlap · 101,135 `email_messages`
(−5,693) · 303,696 `email_sync_skip` (+5,689). Idempotent re-run: `INSERT 0 0 /
DELETE 0 / UPDATE 0 / UPDATE 0`.

The `INSERT 5689` vs `DELETE 5693` gap (4 rows) is expected: those 4 orphans
already had a `(mailbox_user_id, gmail_message_id)` row in `email_sync_skip`, so
the conflict clause skipped the insert while the delete still removed the
duplicate `email_messages` row — no data lost.
