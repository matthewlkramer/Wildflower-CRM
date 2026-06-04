# Runbook — 0012/0013 Auto-exclude noise QuickBooks payments

## What this delivers

The QuickBooks → CRM payment sync used to stage **every** incoming-money record
into the Review queue (~3,000 rows in prod), most of which a fundraiser will
never turn into a gift. This feature auto-**marks** (never deletes) three kinds
of noise so the default (pending) queue stays clean, while keeping every row
synced, viewable, and reversible:

1. **zero_amount** — amount is null or ≤ 0.
2. **loan** — school loan activity (loan account, "Repayment", "Guaranty Fee"),
   detected by payer-name patterns.
3. **membership** — school membership dues, detected by the **real QuickBooks
   marker** (Product/Service item and/or income account on the line — for
   invoice-applied Payments, the line on the linked Invoice), not a school-name
   heuristic.

Excluded rows are hidden from the default queue, shown under an **Excluded** tab
with their reason, and can be **re-included** (→ pending) if wrongly excluded.
Excluded rows cannot be approved/rejected/resolved while excluded.

- Schema: `lib/db/src/schema/_enums.ts`, `lib/db/src/schema/stagedPayments.ts`
- Rules (code-owned, no admin UI): `quickbooksExclusionRules.ts`
- Pull line detail: `quickbooksClient.ts` · Staging: `quickbooksSync.ts`
- API: `routes/quickbooks.ts` (list `?status=excluded`, summary reason counts,
  `POST /staged-payments/:id/re-include`)
- UI: `pages/staged-payments.tsx` (Excluded tab + reason + re-include)

## Files

- `0012_quickbooks_exclusions_schema.sql` — additive: `excluded` status value,
  `staged_payment_exclusion_reason` enum, `exclusion_reason` +
  `line_item_names` / `line_account_names` / `line_classes` columns.
- `0013_quickbooks_exclusions_backfill.sql` — reclassifies existing **pending**
  rows (Part A zero, Part B loan now; Part C membership after enrichment).

## Order of operations (production)

The agent cannot write to prod; a human applies each step.

1. **Apply 0012 (schema).** Must commit before 0013 (Postgres forbids using a
   freshly-added enum value in the same transaction).
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0012_quickbooks_exclusions_schema.sql
   ```
2. **Deploy the new app code** (sync/classifier + review-queue endpoints/UI).
3. **Apply 0013 Parts A+B** (zero + loan). Safe immediately — they run off
   fields that already exist on every row. (Part C is a no-op until its marker
   arrays are filled, so running the whole file now only does A+B.)
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0013_quickbooks_exclusions_backfill.sql
   ```
4. **Enrich line detail.** Run a sync (Settings → QuickBooks → "Sync now", or
   wait for the 30-min scheduler). The pull now captures line-item detail and
   the ON CONFLICT upsert backfills `line_item_names` / `line_account_names`
   onto existing pending/excluded rows (approved/rejected untouched).
5. **Discovery — confirm the membership marker** (see below).
6. **Fill the confirmed marker(s)** into BOTH:
   - `MEMBERSHIP_ITEM_NAMES` / `MEMBERSHIP_ACCOUNT_NAMES` in
     `quickbooksExclusionRules.ts` (so future syncs auto-exclude), and
   - the `ARRAY[...]` literals in Part C of
     `0013_quickbooks_exclusions_backfill.sql`.
   Redeploy, then re-run 0013 (idempotent — only touches still-pending rows).

## Discovery query (run in production, read-only)

After step 4 has enriched rows, inspect the distinct items/income-accounts that
appear on payments from schools (the only school incoming money is loans or
membership, so non-loan school rows are the membership candidates):

```sql
-- Distinct line items / accounts on rows NOT already caught by zero/loan,
-- ranked by frequency, to spot the membership marker.
SELECT 'item' AS kind, unnest(line_item_names) AS name, count(*) AS n
  FROM staged_payments
 WHERE status = 'pending' AND line_item_names IS NOT NULL
 GROUP BY 2
UNION ALL
SELECT 'account' AS kind, unnest(line_account_names) AS name, count(*) AS n
  FROM staged_payments
 WHERE status = 'pending' AND line_account_names IS NOT NULL
 GROUP BY 2
 ORDER BY n DESC;
```

Record the confirmed name(s) here once known:

> **Confirmed membership marker(s):** _TODO — fill in after running discovery._
> (e.g. item `Membership Fee`, income account `Membership Income`.)

## Verify

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
```

## Dev note

Dev has no QuickBooks connection, so there are no staged rows to reclassify and
the membership marker cannot be discovered here. 0012 was applied to dev with the
same idempotent SQL above (drizzle `push` was avoided per the cross-env schema
drift convention). 0013 Parts A+B were applied to dev (no-ops on an empty queue).
