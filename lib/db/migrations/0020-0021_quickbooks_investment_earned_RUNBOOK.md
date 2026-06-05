# Runbook — 0020 / 0021: investment income (4040) + earned income (4020)

Extends the QuickBooks review-queue noise classifier with two refinements the
fundraiser approved:

- **4040 "Realized Gain/Loss on Investments"** → folded into the existing
  `interest` reason (relabeled "Interest / investment income" in the UI). No new
  enum value; these deposits carry an "Interest Earned" memo and are non-gift
  investment income. ~44 pending rows (~$451,874) were not being caught because
  the interest rule only knew the 4010 prefix.
- **4020 "Services - Earned Income"** → a NEW `earned_income` reason
  (fees-for-service / program revenue, never a gift). ~219 pending rows.

Both rules are **account-prefix, donation-guarded** (a row that also carries a
4000/4100 donation line or a "Donation" item stays in `pending`).

The TS classifier (`quickbooksExclusionRules.ts`), `_enums.ts`, the OpenAPI spec,
`routes/quickbooks.ts`, the frontend labels, and these SQL backfills are all in
lockstep. Unit tests cover both new cases + the donation guard.

---

## Apply order (production)

> Prereqs: the new app code is **deployed** first (so future pulls classify 4040
> as `interest` and 4020 as `earned_income` at insert time, and the UI knows the
> new label/bucket).

1. **Enum (no `-1`)** — adds the `earned_income` value. Must commit before 0021.

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0020_quickbooks_earned_income_enum.sql
   ```

2. **Backfill (`-1`)** — excludes the matching pending rows: 4040 → `interest`,
   4020 → `earned_income`. Pending-only + idempotent; safe to re-run.

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0021_quickbooks_investment_earned_backfill.sql
   ```

3. **Verify**

   ```sql
   SELECT status, exclusion_reason, count(*)
   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
   ```

   Expect ~44 new `excluded / interest` and ~219 new `excluded / earned_income`
   rows; the pending count drops accordingly. (Exact counts depend on how many of
   those rows carry line detail — see below.)

---

## The 845 "no line detail" rows — re-pull plan

Account-code rules are **blind to rows that have no `line_account_names`**. At
diagnosis, **845 of the pending rows had no captured line detail**, so 0016 / 0019
/ 0021 cannot classify them. They need a full historical re-pull to enrich, then
the backfills re-run.

> ⚠️ **A re-pull enriches line detail but does NOT reclassify existing rows.** The
> sync upsert (`onConflictDoUpdate` in `quickbooksSync.ts`) only refreshes the
> `line_*` columns + `updated_at` on rows that are still `pending`/`excluded`;
> `status` and `exclusion_reason` are deliberately left untouched so a manual
> re-include / approve / reject is never clobbered. Only **brand-new** pulls
> classify at insert time. Therefore enrichment alone changes nothing — you must
> re-run the line-based backfills afterward.

**Sequence (all admin / human-run):**

1. **Deploy** the latest code (already required above).
2. **Reset the watermark** to force a full historical re-pull (mirror the existing
   `0014_quickbooks_reset_watermark.sql` pattern — set `sync_watermark = NULL` for
   the connection):

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0014_quickbooks_reset_watermark.sql
   ```

3. **Trigger a sync** — Settings → QuickBooks → "Sync now" (admin), or wait for
   the 30-min scheduler. This upserts the back-catalog, refreshing
   `line_item_names` / `line_account_names` on the existing pending rows.

   - Confirm enrichment before backfilling:

     ```sql
     SELECT count(*) FILTER (WHERE line_account_names IS NOT NULL) AS with_detail,
            count(*) FILTER (WHERE line_account_names IS NULL)     AS no_detail
     FROM staged_payments WHERE status = 'pending';
     ```

4. **Re-run ALL line-based backfills** (idempotent, pending-only) so the freshly
   enriched rows get classified:

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0016_quickbooks_more_exclusions_backfill.sql
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0019_quickbooks_other_revenue_backfill.sql
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0021_quickbooks_investment_earned_backfill.sql
   ```

   (0015/0018/0020 enum files are already committed at this point; no need to
   re-run them.)

5. **Re-verify** the status/reason breakdown. Whatever still sits in `pending`
   after this is genuinely ambiguous (a real gift, a settlement, an unidentified
   deposit, or a still-missing-detail row) and is left for human review by design.

---

## Rollback / safety

- Every UPDATE is `WHERE status = 'pending'` — approved/rejected/already-excluded
  rows are never touched, so prior fundraiser decisions and re-includes survive.
- To re-include a wrongly-excluded row, use the normal "Re-include" action in the
  queue (flips `excluded` → `pending`, clears `exclusion_reason`).
- Enum values cannot be dropped without recreating the type; `earned_income` is
  permanent once 0020 commits (by design — taxonomy is sticky).
