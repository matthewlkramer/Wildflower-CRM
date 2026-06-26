---
name: Pledge allocation expected_payment_date
description: Why expected_payment_date lives per-row on pledge allocations (not gifts, not per-grant-year) and how it rolls up.
---

# Pledge allocation expected_payment_date

`expected_payment_date` is a nullable per-ROW date on **pledge** allocations only
(`pledge_allocations`); gift allocations deliberately do NOT carry it.

**Why per-row and NOT keyed to grant year:** a single fiscal/grant year can hold
multiple expected payments, so the date cannot be derived from `grant_year`. Each
allocation row owns its own date.

**Rollup intent:** allocations sharing the same `expected_payment_date` are one
logical "expected payment" with N allocations (a 3-alloc set on the same date = one
expected payment). This is the foundation for flagging overdue committed/partially
-paid pledges.

**How to apply:**
- Nullable = unscheduled; never default it.
- It is plain scope on the allocation row — no derivation, no trigger. The server
  pledge-allocation create/PATCH routes just spread `...body`, so the contract-first
  chain (openapi.yaml → orval hooks/Zod) carries it end-to-end.
- PATCH sends `null` to clear (back to unscheduled); POST omits when empty.
- Keep it OFF gift allocations — `GIFT_HEADERS` must stay separate from
  `PLEDGE_HEADERS` (do not alias them) or the column/row count drifts.
- Additive nullable column → ships via Publish schema diff; no hand-SQL (prod
  invariant #7).
