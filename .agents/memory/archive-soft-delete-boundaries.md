---
name: archive soft-delete boundaries
description: archived_at soft-delete REPLACED hard delete app-wide (list + detail); the only deliberate hard-delete exceptions; and the admin-gating / dropped-surface / aggregates boundaries that are by design, not bugs.
---

# Archive soft-delete: scope boundaries (by design, not bugs)

`archived_at` is a SEPARATE axis from real statuses (activeStatus / active /
lossType / deceased). The project-wide goal "get rid of ALL delete functionality
in favor of archive" is COMPLETE across CRM entities, on **both list and detail
pages**.

## Archive has replaced hard delete everywhere
- All CRM entities archive instead of delete: list pages (per-row + bulk),
  detail pages, and the corresponding `DELETE /{entity}/{id}` server routes were
  removed in favor of `POST /{entity}/{id}/archive` + `/unarchive`.
- payment-intermediaries also archives now (schema `archived_at` + index,
  archive/unarchive routes, list `includeArchived`, FE ShowArchivedToggle).
- Shared helpers: `activeOnlyUnlessAdmin` / `archiveOne` / `unarchiveOne` in
  `artifacts/api-server/src/lib/archive.ts`.
- FE pattern: list pages archive DIRECTLY (no confirm dialog) — see
  `funding-entities.tsx`; payment-intermediaries mirrors it. Anyone can archive.

## The ONLY hard-delete exceptions (user-confirmed — keep them)
- **Gift merge / consolidation** still hard-deletes the merged-away gift.
- **QuickBooks staged-payment revert** still hard-deletes its staged rows.
Do NOT convert these two to archive unless the user explicitly asks.

## Admin gating is LIST-only by design
- "Show archived" + unarchive is admin-only and **server-enforced**, but only on
  LIST endpoints (`activeOnlyUnlessAdmin`): default `archived_at IS NULL`; a
  non-admin's `includeArchived` is ignored. `ShowArchivedToggle` returns null for
  non-admins.
- Detail GET-by-id still returns archived records to any authed user. Intentional
  — do NOT add 404/403 on detail GET/PATCH unless the user asks.

## Dropped surfaces (no list UI to attach actions to)
- households / schools / regions / fiscal-years have NO list pages/routes/nav
  (detail pages only + an admin.tsx fiscal-year goal matrix). Backend archive
  endpoints may exist but there is no list UI for row actions.

## Archived gifts are EXCLUDED from analytics totals (global)
- Gift-based analytics sums now filter `giftsAndPayments.archivedAt IS NULL` at
  every site in `analytics.ts` (lifetimeGiving, dashboard-summary, projections,
  grants-calendar). Archiving a gift removes it from operational reporting.
- This REVERSED the earlier "aggregates include archived" gap. The trigger was
  the Stripe↔QB three-way reconciliation REPLACE path: it archives the coarse
  QB-derived gift while the per-charge Stripe gifts cover the SAME money, so
  counting archived gifts double-counts. The fix had to be global, not
  reconciliation-only, or the double-count leaks through every aggregate.

**Why:** the user's authoritative decision was "no hard delete, use archive"
app-wide, with only the gift-merge and QuickBooks-revert hard-deletes explicitly
retained. Archive is the soft-delete; an archived gift is logically deleted, so
it must not inflate fundraising totals — otherwise REPLACE (and any future
archive-then-supersede flow) double-counts the same dollars. The user was shown
the tradeoff (a "housekeeping" archive of a *real* received gift, or archiving a
gift from an already-reported/closed period, will silently drop it from totals)
and explicitly chose the GLOBAL behavior because archive is strictly a
soft-delete here. Do NOT revert this to "aggregates include archived." The
considered-but-deferred alternative was an archive *reason* (duplicate / error /
superseded / housekeeping) that excludes only the "not real money" reasons —
revisit that only if the team starts archiving real received gifts for tidiness.

**How to apply:** route every new delete affordance through archive; never
reintroduce a hard-delete button or `DELETE` route except the two confirmed
exceptions; keep show-archived/unarchive admin-gated and LIST-only; don't treat
detail-GET archived visibility as a bug. Any NEW gift aggregate must add the
`archivedAt IS NULL` filter to stay consistent with the four existing sites.
