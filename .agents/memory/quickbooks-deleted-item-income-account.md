---
name: QBO inactive-item income-account gap
description: Why deleted QuickBooks Product/Service items resolve no income account, and how to fetch them.
---

QuickBooks Online's `/query` endpoint **implicitly filters `Active = true`**. A
Product/Service item that was "deleted" in QB is really just inactivated (its
name gets a `(deleted)` suffix) but it KEEPS its `IncomeAccountRef`. So a query
like `SELECT * FROM Item WHERE Id IN (...)` silently omits deleted items, and any
paid invoice line that used a since-deleted service item resolves **no income
account** — the payment then looks uncoded (no revenue coding like
"4020 Services - Earned Income") in the reconciliation queue even though the item
NAME still resolves (the name lives on the invoice line, not the item).

**Fix:** fetch inactive items in a second additive pass and merge by item id:
`WHERE Id IN (...)` (active) + `WHERE Active = false AND Id IN (...)` (deleted).
Prefer the two explicit passes over a single `Active IN (true,false)` — it never
regresses the active path and doesn't rely on broader boolean-IN behavior.

**Why:** older invoiced *service* payments showed a blank income account in the
Finance Reconciliation queue. Prod diagnosis: of the genuinely-fixable blank
"payment" rows (non-voided, has an Invoice LinkedTxn, has items), **every one**
had only `(deleted)` items — that was the entire fixable population. The other
blanks are not bugs: voided/zero-amount payments, payments whose invoice is only
referenced in free-text memo (no machine-readable LinkedTxn), and
JournalEntry-coded rows.

**How to apply:** any QBO entity fetch that must see deleted/inactive records
needs an explicit `Active = false` pass. Historical staged rows only backfill via
the **non-destructive full re-pull** (`since=null` fullResync + enrichAllStatuses,
which re-invokes the item fetch and overwrites blank arrays with newly non-empty
ones while preserving review state) — the incremental watermark sync never
re-touches old transactions. The agent cannot write prod, so a human runs the
full re-pull after Publish.
