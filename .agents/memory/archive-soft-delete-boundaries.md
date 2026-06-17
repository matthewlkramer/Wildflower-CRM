---
name: archive soft-delete rollout boundaries
description: Where the archived_at soft-delete applies (list pages) vs where hard delete intentionally stays (detail pages), and what is deliberately out of scope.
---

# Archive soft-delete: scope boundaries (by design, not bugs)

`archived_at` is a SEPARATE axis from real statuses (activeStatus / active /
lossType / deceased) and from hard delete. The rollout was scoped to **list
("big") pages** only.

## What archive replaces
- On LIST pages, archive REPLACES delete: per-row hard delete and bulk delete
  were removed from list UIs; bulk delete → bulk archive. Anyone can archive.
- DETAIL pages intentionally KEEP their hard-delete button, and the per-row
  `DELETE /{entity}/{id}` server routes stay (individual/funding-entity/
  household/gift/opportunity detail). Do NOT "fix" these as leftovers.
- payment-intermediaries is the reference page and keeps hard delete entirely
  (it is a small ref table, not a soft-delete entity).

## Admin gating is LIST-only by design
- "Show archived" + unarchive is admin-only and **server-enforced**, but only on
  LIST endpoints (`activeOnlyUnlessAdmin` / `canIncludeArchived`): default
  `archived_at IS NULL`; a non-admin's `includeArchived` is ignored.
- Detail GET-by-id still returns archived records to any authed user. This is
  intentional — the user's decision scoped "only admins can view" to the
  list Show-archived feature. Do NOT add 404/403 on detail GET/PATCH unless the
  user explicitly asks.

## Dropped surfaces
- households / schools / regions / fiscal-years were DROPPED from the FE archive
  rollout: they have NO list pages/routes/nav (only detail pages + an admin.tsx
  fiscal-year goal matrix). Backend archive endpoints exist but there is no list
  UI to attach row actions to.

## Known gap (out of scope)
- Aggregates (lifetimeGiving / dashboard-summary / projections / grants-calendar
  sums) still include archived gifts/opps. Whether archive should remove records
  from operational reporting is a separate, explicit decision.

**Why:** the user's authoritative decision scoped "no hard delete" and
"only admins view archived" to list pages; extending to detail pages, detail
GETs, or aggregates is unspecified product work that could break existing flows.

**How to apply:** when touching list pages, route deletes through archive; when
touching detail pages, leave the existing delete affordance; don't treat
detail-page delete, detail-GET archived visibility, or archived-in-aggregates as
bugs — they are deliberate boundaries.
