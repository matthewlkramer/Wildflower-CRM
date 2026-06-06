---
name: QuickBooks non-destructive full re-pull
description: How to backfill new staged_payments capture columns without wiping review state (the alternative to 0024 clean re-ingest).
---

# QuickBooks non-destructive full re-pull

To backfill NEW read-only QB capture columns onto existing `staged_payments`
rows, use a **full re-pull** (`syncQuickbooks({ fullResync: true })`), NOT the
destructive `0024_quickbooks_clean_reingest.sql` (which DELETEs every row).

**Why:** prod holds live review state (donor matches, approvals, exclusions,
deposit groups). A clean re-ingest discards all of it. Once new capture columns
exist, the only need is to refresh QB facts on rows that already exist.

**How to apply / the mechanism:**
- `fullResync` sets `since=null` so the watermark is ignored and the whole QB
  back-catalog is re-fetched. The watermark is still advanced at the end and is
  seeded from its stored floor so it never regresses.
- `buildStagedLineUpsert(values, { enrichAllStatuses: true })` DROPS the
  `setWhere status in ('pending','excluded')` guard so approved/rejected rows
  also get refreshed. This is safe ONLY because the `set` clause touches
  exclusively read-only QB mirror columns (qb_*) via `coalesce(excluded.x,
  stored.x)` — never status/donor/match/gift/approval columns. If you ever add a
  review column to that `set`, the enrichAllStatuses path would clobber overrides.
- Triggers: admin `POST /api/quickbooks/resync-full`, the "Re-pull all fields"
  button on the reconciler, or `pnpm --filter @workspace/api-server run
  resync:quickbooks`.

**Verbatim raw JSON** (`qb_raw`, `qb_raw_line`) is stored for audit but
destructured OUT of `stagedSelect` (and omitted from the OpenAPI schema) so it
never bloats list/detail responses.
