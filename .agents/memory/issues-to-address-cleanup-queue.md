---
name: issues_to_address → cleanup_queue
description: Retiring a per-row free-text finance note column by migrating it into the polymorphic cleanup_queue.
---

# Retiring per-row free-text notes into `cleanup_queue`

`cleanup_queue` is the app-wide polymorphic sink (target_type/target_id, no FK,
reason_code, note NOT NULL, status open/resolved/dismissed, unique
`(target_type,target_id,reason_code)`) for "something is off with this record"
flags. When a per-row free-text "issue" column is retired, migrate its notes here
rather than inventing a new table.

**Rule:** give the migrated notes their OWN `reason_code` (e.g.
`issues_to_address`), never reuse `needs_research`.

**Why:** the unique key is `(target_type,target_id,reason_code)` and the data-move
uses `ON CONFLICT DO NOTHING`. Under a shared reason_code, any record already
carrying that flag would silently drop the incoming note. A distinct reason_code
keeps both as separate rows, keeps the migrated set a recognisable bucket, and
still shows in the default queue view (the list route filters by **status**, not
reason_code; resolve/dismiss are reason-agnostic; reasonCode is a plain string in
the generated types — no enum gate).

**How to apply:**
- Data-move SQL must be idempotent + order-independent: `ON CONFLICT DO NOTHING`,
  deterministic id, and an `information_schema` column-exists guard wrapped around a
  dynamic `EXECUTE` so the file is a clean no-op even after the drop file has
  removed the source column.
- Ship as the standard invariant-#7 pair: `NNNN_move_*.sql` then
  `NNNN_drop_*.sql`, Publish-first, prod-then-dev back-to-back, no Publish between
  (see the co-located RUNBOOK and the 0108 precedent).
- **Frontend coupling:** the cleanup-queue page maps `target_type` →
  `targetHref()` and the list route maps it → a display name. Any target_type that
  can now ENTER the queue needs a matching `targetHref` case, or its rows link to a
  bogus default (`/pledges/<id>`). `staged_payment`/`stripe_payout` have no detail
  page → link to `/reconciliation-workbench`; `gift` → `/gifts/<id>` with an
  id-only fallback name.
