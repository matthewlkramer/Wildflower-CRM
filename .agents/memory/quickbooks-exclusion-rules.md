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

**Account-code prefixes are NOT enough — also match the human account NAME.**
QuickBooks emits the same income account both WITH and WITHOUT its leading code
(e.g. both "4040 Realized Gain/Loss on Investments" and bare "Realized Gain/Loss
on Investments"; same for "Interest Earned"). A code-PREFIX-only rule silently
misses the code-less variant, leaking those rows into the queue. For any
account-coded rule, match by code prefix OR case-insensitive account-NAME
substring (TS `anyIncludes` ⇄ SQL `lower(btrim(a)) LIKE '%name%'`). The interest
family carries both an `*_ACCOUNT_CODE_PREFIXES` and an `*_ACCOUNT_NAME_SUBSTRINGS`
list for this reason.

**Donation-first guard:** all *line-based* rules (guaranty/interest/tax_refund/
other_revenue) are suppressed when the row also carries a real donation line
(4000/4100-series account or a "Donation" item), so a bundled deposit is never
hidden. Payer-identity rules (e.g. exact "CSP" government reimbursement) are
intentionally NOT guarded.

**Memo (`raw_reference`) is a classifier input.** Some accounts carry no usable
item/account signal — the distinguishing detail is in the free-text memo. The
classifier therefore receives `rawReference`; if you add a memo-based rule, the
SQL backfill must mirror the regex (TS `\b…\b` ⇄ Postgres `~* '\y…\y'`).

**Taxonomy decisions (enum values are sticky — hard to drop later):**
- Guaranty fees reuse the existing `loan` reason (they are loan activity), no new value.
- `tax_refund` groups unemployment-tax and workers-comp refunds — those have NO
  QB item/account of their own; they post back to expense accounts
  (`7010.4` payroll taxes, `7020` taxes, `7006` insurance). Split only via a new migration.
- `interest` covers BOTH `4010` (Interest Earned) AND `4040` (Realized Gain/Loss
  on Investments) + the `INTEREST` item — investment income folded into one bucket
  (4040 deposits carry an "Interest Earned" memo); UI label is "Interest /
  investment income". `government_reimbursement` (exact payer `CSP`) is its own value.
- `earned_income` (`4020` Services - Earned Income): fees-for-service / program
  revenue, never a gift. Account-prefix rule, donation-guarded.
- `other_revenue` (`4030` Other Revenue): a grab-bag bucket — mostly non-gifts
  but real gifts are occasionally miscoded here, so the rule is deliberately
  NARROW. It excludes ONLY rows coded to 4030 whose memo reads like credit-card
  rewards (`\brewards?\b`) or bank-account activity (`\bbusiness checking\b`);
  everything else coded to 4030 (settlements, refunds, unidentified, miscoded
  gifts) stays in the queue for human review. **Why:** the user explicitly chose
  "exclude only the clear non-gifts, leave the rest to review" — do not broaden
  to a blanket 4030 exclusion.
- `insurance` (BASICCOBRA): COBRA/insurance-premium reimbursements administered by
  BASIC. A TEXT/identity rule (`basiccobra` substring on any field), so it is
  **UNGUARDED** and runs before the donation guard — categorically not a gift
  regardless of coding.
- `expense_refund` (the word "refund"): refunds of the org's OWN expenses (vendor
  overpayments, training/registration refunds, ERC tax refunds). **UNGUARDED** but
  runs AFTER the guarded account-based rules, so a refund coded to a tax/insurance
  account keeps the more-specific `tax_refund` label; `expense_refund` only catches
  refunds the guarded rules missed. **Why unguarded matters:** the two largest ERC
  refunds are MISCODED to a `4000.4` donation income account — a guarded rule would
  trap them in the queue forever. Memo regex TS `/\brefund/i` ⇄ SQL `~ '\mrefund'`
  (matches refund/refunds/refunded, NOT "prefund").

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

**Re-pull enriches but does NOT reclassify.** The sync `onConflictDoUpdate`
(quickbooksSync.ts) only refreshes `line_*` detail + `updated_at` on existing
pending/excluded rows; status & exclusion_reason are intentionally left untouched
so a manual re-include / approve / reject is never clobbered. Consequence: after a
watermark-reset re-pull adds line detail to the historical back-catalog, those rows
stay `pending` even if they now match a rule — you MUST re-run the line-based
backfills (0016 + 0019 + 0021, all idempotent + pending-only) AFTERWARD to actually
exclude the newly-enriched noise. Only *brand-new* pulls classify at insert time.
