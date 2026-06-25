# 0075 — Link Wildwood school to the Stranahan FY2021 $30k allocation

## What this does

Sets `gift_allocations.school_recipient_id` on the Stranahan FY2021 $30,000
allocation so the money trail points at the Wildwood Montessori school.

| field | value |
| --- | --- |
| gift | `recwKC3JHKRY2QYHe` |
| allocation | `ga-stranahan-fy21-wildwood` (`sub_amount` 30000.00) |
| school | `rec5wLfcIiuFSJCj1` — "Wildwood" / "Wildwood Montessori" (permanently closed) |

It also **inserts the Wildwood school row** if it is missing. Wildwood exists in
the Airtable "Schools" source (and in dev) but is not yet in prod's `schools`
table. The allocation link can't be set until that row exists, because
`gift_allocations.school_recipient_id -> schools.id` is `ON DELETE RESTRICT`. So
the file is self-contained: school first, then link.

## Changes (additive, non-destructive)

1. `INSERT INTO schools (...) VALUES ('rec5wLfcIiuFSJCj1', 'Wildwood', ...) ON CONFLICT (id) DO NOTHING`
2. `UPDATE gift_allocations SET school_recipient_id='rec5wLfcIiuFSJCj1' WHERE id='ga-stranahan-fy21-wildwood' AND school_recipient_id IS NULL`
3. A read-only verification `SELECT`.

Nothing is dropped; no other rows are touched.

## Idempotency

- School insert is `ON CONFLICT (id) DO NOTHING` — a no-op if the row already
  exists (e.g. the scheduled prod Airtable school sync created it first). That
  sync uses `onConflictDoUpdate`, so it will reconcile this row to authoritative
  Airtable values on its next run regardless of this insert.
- The allocation update is guarded by `school_recipient_id IS NULL`, so
  re-running the file never overwrites a later or different link (second run
  reports `UPDATE 0`).

## Apply

From the repo root (do **not** add `BEGIN`/`COMMIT` — `-1` runs the whole file in
one transaction):

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0075_wildwood_school_allocation_link.sql
```

Expected output on the first prod run: `INSERT 0 1` (school created) or
`INSERT 0 0` (already synced), `UPDATE 1`, then the verification row showing
`school_name = Wildwood`.

## Relationship to the Airtable school sync

This file is independent of Publish — `schools` and `gift_allocations` already
exist in prod. Publishing the latest code (the `AIRTABLE_API_TOKEN`-aware client
and the fixed school-sync stale check) is still recommended separately so prod's
scheduled school sync keeps Wildwood and all other schools current going forward.

## Rollback

To unlink (leaves the Wildwood school row in place, which is harmless and
authoritative):

```sql
UPDATE gift_allocations
   SET school_recipient_id = NULL
 WHERE id = 'ga-stranahan-fy21-wildwood'
   AND school_recipient_id = 'rec5wLfcIiuFSJCj1';
```
