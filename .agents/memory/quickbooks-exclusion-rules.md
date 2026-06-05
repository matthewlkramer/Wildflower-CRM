---
name: QuickBooks staged-payment exclusion rules
description: How the auto-exclude "noise" classifier and its SQL backfill must stay in lockstep, plus the enum/taxonomy constraints.
---

# QuickBooks staged-payment auto-exclude rules

The review-queue noise classifier lives in
`artifacts/api-server/src/lib/quickbooksExclusionRules.ts` (pure, unit-tested) and
filters **new** pulls automatically. Existing queue rows are reclassified by
hand-written SQL backfills in `lib/db/migrations/`.

**Rule:** the TS classifier and the SQL backfill must stay in EXACT lockstep.
Adding/changing a rule means touching all of: the classifier, the
`ExclusionReason` union, the `staged_payment_exclusion_reason` pgEnum
(`lib/db/src/schema/_enums.ts`), the OpenAPI `StagedPaymentExclusionReason` enum
(then re-run codegen), the frontend `EXCLUSION_REASON_LABELS` map, the
`excludedByReason` summary map in `routes/quickbooks.ts`, and a matching SQL
backfill. Account matching is by **QB account-code prefix** (lower+trim,
`startsWith` in TS == `LIKE 'code%'` in SQL); items by case-insensitive
substring. A mismatch silently under- or over-classifies real money.

**Why:** an over-broad rule can wrongly hide a real gift; an under-broad backfill
leaves noise in the queue. Equivalence is the safety property.

**Donation-first guard:** all *line-based* rules (guaranty/interest/tax_refund)
are suppressed when the row also carries a real donation line (4000/4100-series
account or a "Donation" item), so a bundled deposit is never hidden. Payer-identity
rules (e.g. exact "CSP" government reimbursement) are intentionally NOT guarded.

**Taxonomy decisions (enum values are sticky — hard to drop later):**
- Guaranty fees reuse the existing `loan` reason (they are loan activity), no new value.
- `tax_refund` groups unemployment-tax and workers-comp refunds — those have NO
  QB item/account of their own; they post back to expense accounts
  (`7010.4` payroll taxes, `7020` taxes, `7006` insurance). Split only via a new migration.
- `interest` (`4010` Interest Earned / `INTEREST` item) and
  `government_reimbursement` (exact payer `CSP`) are their own enum values.

## Two-file enum migration gotcha

`ALTER TYPE ... ADD VALUE` cannot be USED in the same transaction that added it.
Split every new-enum-value change into two files: one that only adds values (run
**WITHOUT** `-1` so each `ADD VALUE` autocommits) and a separate backfill that
uses them (run **WITH** `-1`). The backfill file must run only after the enum
file has committed.

## Watermark-based sync = line detail isn't auto-backfilled

The QB sync is incremental on a per-connection `sync_watermark`. A plain
"Sync now" does NOT enrich `line_item_names`/`line_account_names` on the historical
back-catalog (those rows sit behind the watermark). Line-based backfills need a
**full historical re-pull**, forced by resetting the watermark to NULL
(`0014_quickbooks_reset_watermark.sql` pattern) then syncing. Verify
`count(*) FILTER (WHERE line_item_names IS NOT NULL)` before assuming enrichment.
