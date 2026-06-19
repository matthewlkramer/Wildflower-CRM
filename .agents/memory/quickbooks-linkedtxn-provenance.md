---
name: QuickBooks LinkedTxn provenance (line-level vs top-level)
description: What QBO's two LinkedTxn locations mean, and why the deposit link is derived from qb_raw at query time instead of a stored column.
---

QBO exposes `LinkedTxn` in two places with **different meanings**:

- **Line-level** (`Line[].LinkedTxn`) — what a Payment/SalesReceipt *applies to*:
  the Invoices / CreditMemos / JournalEntries / Expenses. This is captured into
  the `qb_linked_txn` column at ingest.
- **Top-level** (`<entity>.LinkedTxn`) — for a Payment/SalesReceipt this is the
  **Deposit it was deposited into** (in our prod data it is 100% `TxnType=Deposit`).
  This was NOT captured in any column; it lives only in the stored raw payload.

**Decision:** surface the deposit link as a display-only derived response field by
extracting it from the already-stored raw QB payload at query time, rather than
adding a new column + re-pull/backfill.

**Why:** the raw payload is fully populated for every staged row, so deriving works
immediately on all existing rows with no schema migration, no prod backfill, and
no re-pull; it is reversible and cannot mutate any payment field.

**How to apply:** when exposing additional QB-derived *reference* data, prefer
deriving from the stored raw payload over a new column + re-pull — UNLESS the value
becomes a filter/sort key or the list endpoint stops being paginated (the per-row
scalar subquery detoasts the raw jsonb, fine only on a paginated page). The
customer/vendor/employee record a payment points to is already in the
`qb_payer_type` / `qb_payer_id` / `payer_name` fields — no lookup needed.
