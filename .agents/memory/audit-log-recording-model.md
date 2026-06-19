---
name: Audit log recording model
description: How the universal audit_log is recorded (two write paths) and why it's separate from bulk_operations.
---

# Audit log recording model

The CRM has a universal change-tracking ledger `audit_log` (a plain table — it
ships to prod via Publish's schema diff, no manual SQL needed). It is the
human-readable, entity-scoped timeline, distinct from `bulk_operations` which
keeps the row-level batch detail (which ids/fields, partial failures). A bulk op
emits ONE summary `audit_log` row plus the detailed `bulk_operations` row.

## Two write paths — pick by transaction context

- **`recordAudit(execOrTx, req, event)` — atomic, THROWS.** Pass a transaction
  handle so the audit row commits in lockstep with the mutation. Use ONLY where
  the mutation itself is already in a tx: the shared archive/unarchive helpers,
  bulk archive/update, and entity merge.
- **`safeRecordAudit(req, event)` — best-effort, NEVER throws.** Use AFTER a
  standalone create/PATCH has already committed (`auditCreate` / `auditUpdate`
  wrap this). An audit failure must never break a donor save, so it is logged
  and swallowed, not surfaced.

**Why:** a donor create/update is a single committed write with no surrounding
tx, so wrapping audit in the same tx isn't available; making audit throw there
would let a logging failure roll back / 500 a legitimate save. Inside a tx
(archive/bulk/merge) the opposite is true — the audit row should share the
mutation's atomicity.

**How to apply:** when you add a new audited write, decide first whether the
mutation runs inside a `db.transaction`. In-tx → `recordAudit(tx, …)`.
Already-committed standalone write → `auditCreate`/`auditUpdate` (or
`safeRecordAudit`). `diffChanges(before, after, Object.keys(body))` emits only
changed fields (Date→ISO normalized), so a no-op PATCH records nothing.

The read route is admin-only (server-side `requireAdmin`, 403 otherwise); the
frontend `/audit-log` page double-gates via `useIsAdmin` (early return + query
`enabled`) and the nav link is admin-filtered.
