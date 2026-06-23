# Runbook — 0071/0072 QuickBooks exclusion-reason reorganization

## What this does

Brings production into line with the exclusion-reason reorg (`quickbooksExclusionRules.ts`
classifier + `quickbooksRules.ts` SEED_RULES). Two files, applied in order:

- **0071** (enum, no transaction) — adds the new `staged_payment_exclusion_reason`
  values: `loan_repayment`, `loan_proceeds`, `note_payable`, `miscoded_withdrawal`.
- **0072** (backfill, transactional) — retires the overloaded `loan` and
  `government_reimbursement` handling rules, adds the precise replacement rules,
  re-codes historical excluded rows into the new families, re-surfaces money that
  should no longer be excluded, and flags government reimbursements as non-goal.

### The substantive changes

1. **`loan` is split.** Historical auto-excluded `loan` rows are re-coded to
   `loan_repayment` (loans-to-schools / "… Repayment" / loan or repayment payer),
   `loan_proceeds` ("PPP Loan Received" / "loan received" / "loan proceeds"), or
   `note_payable` ("Note Payable" line). Guaranty fees fold into the existing
   `earned_income`.
2. **Loan-fund capital is rescued.** The broad `\bloans?\b` line/account match is
   retired. Any auto `loan` row that matches none of the precise markers above was
   swept ONLY by that broad rule — it is **re-surfaced to the queue** (status →
   pending). This is the tracked loan-FUND CAPITAL (a real gift posted to a
   contributions account) that must never be hidden.
3. **Government reimbursement stops being excluded.** Auto-excluded
   `government_reimbursement` rows return to the queue; every CSP-payer row is
   flagged `counts_toward_goal = false` so the gift a fundraiser records mints
   non-goal (real money that doesn't advance the fundraising goal).
4. **Fiscally sponsored** — already retired by migration 0049 (entity attribution
   + re-surface). Nothing to do here.

The legacy enum values (`loan`, `government_reimbursement`, `fiscally_sponsored`)
are **kept** — the classifier no longer emits them and the manual picker hides
them, but they stay valid so historical rows remain readable.

## Prerequisites

1. Deploy the new app code (Publish) so the contract + classifier are live.
2. Ensure a full QuickBooks re-pull has populated line detail
   (`line_item_names` / `line_account_names`) — the line-based re-code needs it.

## Apply

Run 0071 first and let it commit, then 0072:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0071_quickbooks_exclusion_reorg_enum.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0072_quickbooks_exclusion_reorg_backfill.sql
```

(0071 must NOT be wrapped in a single transaction — PostgreSQL forbids using a
new enum value in the same transaction that adds it, which is why 0072 is a
separate invocation.)

0072 prints a `NOTICE` summary: auto `loan` still excluded (expect **0**), the new
`loan_repayment` / `loan_proceeds` / `note_payable` counts, and the CSP non-goal
count.

## Idempotency

Safe to re-run. 0071 uses `ADD VALUE IF NOT EXISTS`. 0072's re-code steps only
touch rows still `status='excluded'` with the source reason and
`classification_source='auto'`, rewriting the reason away from `loan` so a row is
moved once; new rule INSERTs use `ON CONFLICT (id) DO NOTHING`; the CSP flag and
re-surface steps are state-guarded. Nothing is deleted.

## Verify

```sql
-- No auto loan rows should remain excluded.
SELECT status, exclusion_reason, count(*)
  FROM staged_payments
 WHERE exclusion_reason IN
       ('loan','loan_repayment','loan_proceeds','note_payable','government_reimbursement','earned_income')
 GROUP BY 1, 2 ORDER BY 1, 2;

-- Government reimbursements: back in the queue, flagged non-goal.
SELECT status, counts_toward_goal, count(*)
  FROM staged_payments
 WHERE lower(btrim(payer_name)) = 'csp'
 GROUP BY 1, 2 ORDER BY 1, 2;

-- Replacement handling rules are enabled; obsolete ones disabled.
SELECT id, enabled, priority, exclusion_reason
  FROM quickbooks_handling_rules
 WHERE id IN ('seed_loan_payer','seed_loan_line','seed_government_reimbursement',
              'seed_guaranty','seed_guaranty_payer','seed_loan_repayment_payer',
              'seed_note_payable_line','seed_loan_proceeds_line','seed_loan_repayment_line')
 ORDER BY priority, id;
```

## Optional — physically dropping the legacy enum values

Not part of this rollout. See the fenced final section of
`0072_quickbooks_exclusion_reorg_backfill.sql` for the pre-flight checks and the
type-recreation sketch. Only worth doing once every row referencing a legacy
value has been re-coded or archived.
