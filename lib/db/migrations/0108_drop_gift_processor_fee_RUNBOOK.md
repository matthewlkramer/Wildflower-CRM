# Runbook — 0108 Drop `gifts_and_payments.processor_fee`

## What this does

Physically drops one long-deprecated, fully-inert column:

| Dropped | Superseded by |
| --- | --- |
| `gifts_and_payments.processor_fee` | the DERIVED read-model field `derivedProcessorFee` (`giftPaymentSummary.ts`) — `NULLIF(SUM of the fees of the gift's LINKED payments, 0)`: Stripe charges' `fee_amount` + non-stripe Donorbox donations' `processing_fee`. The donor is credited the GROSS `amount`; the fee/net is derived at read time, never stored. |

It is a plain scalar `numeric` — no index, FK, enum, CHECK, or default depends on it — so nothing else is auto-dropped.

## Scope — ONLY `processor_fee`

The sibling deprecated money-provenance columns are **deliberately left in place** and ship in a later migration:

- **`original_human_crm_amount`** — still holds real legacy snapshots (**704 of 793** prod gifts are non-null, verified read-only) that `unstampGiftFinalAmount` reads to restore the pre-stamp human amount when a QB/Stripe reconcile is reverted. Dropping it now would lose that restore data, so it stays until a parity/backfill pass clears it.
- **`final_amount_source` / `final_amount_stripe_charge_id` / `final_amount_qb_staged_payment_id`** — still WRITTEN by QuickBooks matching/actions and still READ by the gifts-list "still funding" filter + `financialCorrections.ts`. They also carry a source⇔pointer CHECK and two partial-unique indexes that must come down with them, so they need their own migration once those readers/writers are retired.

## Why it is safe (verified read-only against the schema-removal build)

- **No readers.** Every consumer of the fee switched to `derivedProcessorFee` (derived
  from linked payments); the frontend never referenced `processorFee` at all.
- **No writers.** All writers were removed in this task — the Stripe mint object
  (`stripeGift.ts`), the reconciliation + bundle commit paths, and the
  `StampFinalAmountArgs.processorFee` interface field plus the unstamp null-clear in
  `giftFinalAmount.ts`. No deployed code names the column.
- **Stored values are already ignored.** Prod holds only **8** non-null `processor_fee`
  rows; the fee that the app shows comes from each gift's linked Stripe/Donorbox
  payments, not from this column, so the drop changes no read result.

The full `pnpm run typecheck` (which compiles `src/__tests__` too) is green with the
column removed from the Drizzle schema and the OpenAPI response field — the
authoritative "no residual reference" gate for a column drop.

## Optional pre-drop capture (the 8 non-null rows)

The app never reads `processor_fee`, so nothing is lost functionally. But the 8 prod
rows that still hold a non-null value have NOT been verified to have a fee-bearing
linked Stripe charge, so those specific stored numbers become irrecoverable once the
column is gone. If you want a paper trail, capture them **before** applying the drop:

```bash
psql "$PROD_DATABASE_URL" -c "SELECT id, processor_fee FROM gifts_and_payments WHERE processor_fee IS NOT NULL ORDER BY id;"
```

(Read-only; save the output somewhere durable if you care about the historical
values.) This is optional — proceed straight to the drop if you do not.

## Deploy ordering (prod) — **Publish FIRST, then this SQL** (same as 0104/0105/0107)

`processor_fee` is ALREADY unselected by the deployed build, so a drop would not 500
reads either way. The binding constraint is the **Publish diff**: Publish compares the
**dev-DB against the prod-DB** (not the schema source).

1. **Publish this task's code first.** The new build removes `processor_fee` from the
   schema and from the OpenAPI gift response. At this point **both DBs still hold the
   column**, so the diff is clean — Publish proposes no drop and deploys successfully.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0108_drop_gift_processor_fee.sql
   ```
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0108_drop_gift_processor_fee.sql
   ```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the window
where prod has dropped the column but dev still holds it, a Publish would see a
**dev-only column** and propose an ADDITIVE re-create of the dead column.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the column while prod still has it, the next Publish sees a **prod-only
column** and proposes a **destructive prod DROP**, which aborts the whole diff
(additive changes skipped → 500 healthcheck → rollback). Keep dev and prod in lockstep
**through** Publish; only after Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push` against the
**dev** DB. Because the schema dropped `processor_fee` but the dev DB still holds it,
push detects a data-loss DROP and **aborts** — expected and harmless for this merge (it
introduces **no additive** schema changes, so nothing is lost; the dev app keeps
serving with the column as a dead orphan). Once you have run step 3, dev matches the
schema again and post-merge push returns to a clean no-op. Do this promptly so a later
merge's additive changes aren't blocked by the same abort.

## Idempotency

`DROP COLUMN IF EXISTS` → safe to re-run; a second run is a no-op.

## Verify (read-only, after applying)

```sql
-- Column gone (expect ZERO rows):
SELECT table_name, column_name FROM information_schema.columns
WHERE table_name = 'gifts_and_payments' AND column_name = 'processor_fee';

-- Derived fee still resolves from linked Stripe charges (expect a fee for gifts
-- that have a fee-bearing linked charge):
SELECT g.id,
       NULLIF(COALESCE((SELECT SUM(ssc.fee_amount) FROM stripe_staged_charges ssc
                        WHERE ssc.matched_gift_id = g.id
                           OR ssc.created_gift_id = g.id), 0), 0) AS derived_fee
FROM gifts_and_payments g
WHERE EXISTS (SELECT 1 FROM stripe_staged_charges ssc
              WHERE (ssc.matched_gift_id = g.id OR ssc.created_gift_id = g.id)
                AND ssc.fee_amount IS NOT NULL)
LIMIT 5;

-- Deliberately-retained sibling still present (expect a non-zero count):
SELECT count(*) FROM gifts_and_payments WHERE original_human_crm_amount IS NOT NULL;
```

## Rollback

Structure-only if ever needed: re-add the column from the pre-drop DDL
(`processor_fee numeric(14,2)`). There is nothing to restore into it — the processor
fee is derived from each gift's linked Stripe/Donorbox payments
(`derivedProcessorFee`), not from this column.
