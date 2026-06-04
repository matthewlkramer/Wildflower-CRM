# Production sync runbook — this morning's batch (no overwrite)

Prod now holds **live data** edited by real users since the last full-overwrite
publish, so a wholesale overwrite is **off the table**. This morning's work
reaches prod by two safe paths working together:

1. **Code / UI / schema-in-code** ships through the normal **Publish** flow.
2. **Data + schema changes** ship as the **idempotent, additive** SQL files
   below, applied by a human with `psql`. The agent cannot write to prod or
   click Publish.

The user confirmed there were **no record-by-record hand edits** in dev this
morning — every dev data change was a structural/bulk transformation captured by
these files — so no record-level dev→prod diff is needed.

Each file is **additive and idempotent**: a second run is a safe no-op. All were
verified twice on the task's dev DB (first run did real work, second run changed
zero rows).

## What ships in this batch

| File | What it does | Kind |
| ---- | ---- | ---- |
| `0002b_add_loss_type.sql` | Creates `opportunity_loss_type` enum + `opportunities_and_pledges.loss_type`; backfills it from each row's own current `status` (dormant/lost). Supersedes Task #158's obsolete overwrite cutover. | additive DDL + backfill |
| `0003_rename_verbal_confirmation.sql` | Renames opportunity stage `verbal_commitment` → `verbal_confirmation`. | enum rename |
| `0004_reclassify_verbal_confirmation.sql` | Pulls verbal_confirmation rows off the Pledges page (clears sticky `was_pledge`, re-derives status). Reads `loss_type`. | data |
| `0005_saved_views_verbal_confirmation.sql` | Rewrites the old enum literal inside saved-view filter JSON. | data |
| `0006_fundable_project_planning_fields.sql` | Adds 5 nullable planning columns to `fundable_projects`. | additive DDL |
| `0007_normalize_interests_thematic.sql` | Collapses legacy `interests_thematic` tag variants onto canonical labels (organizations + people). | data |
| `0008_donor_payment_intermediaries.sql` | Creates the `donor_payment_intermediaries` ("gives through") table + indexes; backfills legacy `organizations.payment_intermediary_id` links. Does **not** drop the legacy column. | additive DDL + backfill |

## Apply order & where Publish fits

Apply the SQL **in this exact order**, each in its own transaction, stopping on
the first error:

```
0002b → 0003 → 0004 → 0005 → 0006 → 0007 → 0008
```

Ordering rationale:

- **`0002b` must run first.** `0004` reads `o.loss_type`, so the column must
  exist before it runs. `0002b` is purely additive, so it is safe to land before
  the deploy.
- **`0003` must land before/at deploy.** The new code references the
  `verbal_confirmation` enum value; if the code ships first, any read/write
  touching that stage fails until the rename lands.
- `0004` runs after `0003` (needs the renamed value) and after `0002b` (needs
  `loss_type`). `0005` runs alongside `0003` (before or after `0004`).
- `0006` (fundable-project columns) and `0008` (dpi table) are additive DDL and
  the new code SELECTs/INSERTs them, so they should land **before/at** deploy or
  those reads fail with "column/relation does not exist".
- `0007` is pure data cleanup with no code dependency; order is not critical, run
  it with the rest.

**Recommended sequence:** apply the additive DDL (`0002b`, `0006`, `0008`)
**before** clicking Publish so the deployed code never reads a column/table that
does not exist yet. Apply the enum rename + the data files (`0003`, `0004`,
`0005`, `0007`) **at/around** the Publish so the renamed stage and the running
code agree. Because every file is idempotent, applying the whole batch in one
window immediately before Publish is also safe.

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0002b_add_loss_type.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0003_rename_verbal_confirmation.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0004_reclassify_verbal_confirmation.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0005_saved_views_verbal_confirmation.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0006_fundable_project_planning_fields.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0007_normalize_interests_thematic.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0008_donor_payment_intermediaries.sql
# then click Publish
```

> `0007` and `0008` carry their own `BEGIN/COMMIT`; running them with `-1` is
> still safe (it just logs a harmless "there is already a transaction in
> progress" warning). The remaining files rely on `-1` for atomicity.

## Read-only pre-flight checks

Run these **before** applying, to see exactly what each file will touch on prod:

```sql
-- 0002b: dormant/lost rows that will get loss_type backfilled (do NOT expect a
-- specific count — read prod's own state; dev had 452):
SELECT count(*) FROM opportunities_and_pledges
WHERE status::text IN ('dormant','lost') AND loss_type IS NULL;

-- 0003: confirm the old enum value is still present:
SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
WHERE t.typname='opportunity_stage' AND e.enumlabel='verbal_commitment';

-- 0004: rows that will be reclassified off the Pledges page (pre-rename, the
-- stage is still 'verbal_commitment'):
SELECT id, status, was_pledge, grant_letter_url
FROM opportunities_and_pledges
WHERE stage::text IN ('verbal_commitment','verbal_confirmation')
  AND was_pledge = true
  AND grant_letter_url IS NULL
  AND NOT EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.payment_on_pledge_id = id);

-- 0005: saved views still referencing the old literal:
SELECT id, list_key, name FROM saved_views WHERE state::text LIKE '%verbal_commitment%';

-- 0006: confirm the planning columns are not present yet:
SELECT column_name FROM information_schema.columns
WHERE table_name='fundable_projects'
  AND column_name IN ('fundraising_start','fundraising_end','spending_start','spending_end','fundraising_goal');

-- 0007: raw interest variants still present (organizations + people):
SELECT v, count(*) FROM (
  SELECT unnest(interests_thematic) v FROM organizations
  UNION ALL SELECT unnest(interests_thematic) v FROM people
) x
WHERE v = ANY(ARRAY['montessori','ed_tech','microschools_teacher_leadership',
  'intentional_diversity','ece_policy','racial_equity','Racial Justice',
  'social_emotional','data_accountability','family_engagement',
  'workforce','youth','women']::text[])
GROUP BY v;

-- 0008: legacy org→intermediary FK links that will be backfilled:
SELECT count(*) FROM organizations WHERE payment_intermediary_id IS NOT NULL;
```

## Post-apply verification

```sql
-- 0002b: every dormant/lost row now carries a matching override (0 rows):
SELECT id, status, loss_type FROM opportunities_and_pledges
WHERE status::text IN ('dormant','lost')
  AND (loss_type IS NULL OR loss_type::text <> status::text);

-- 0003: old enum label is gone (0 rows):
SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
WHERE t.typname='opportunity_stage' AND e.enumlabel='verbal_commitment';

-- 0004: no verbal_confirmation row is still flagged a pledge for a
-- non-independent reason (0 rows):
SELECT id FROM opportunities_and_pledges
WHERE stage='verbal_confirmation' AND was_pledge=true
  AND grant_letter_url IS NULL
  AND NOT EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.payment_on_pledge_id = id);

-- 0005: no saved view references the old value (0 rows):
SELECT id FROM saved_views WHERE state::text LIKE '%verbal_commitment%';

-- 0006: all five columns now exist (5 rows):
SELECT column_name FROM information_schema.columns
WHERE table_name='fundable_projects'
  AND column_name IN ('fundraising_start','fundraising_end','spending_start','spending_end','fundraising_goal');

-- 0007: no raw interest variants remain (0 rows):
SELECT v, count(*) FROM (
  SELECT unnest(interests_thematic) v FROM organizations
  UNION ALL SELECT unnest(interests_thematic) v FROM people
) x
WHERE v = ANY(ARRAY['montessori','ed_tech','microschools_teacher_leadership',
  'intentional_diversity','ece_policy','racial_equity','Racial Justice',
  'social_emotional','data_accountability','family_engagement',
  'workforce','youth','women']::text[])
GROUP BY v;

-- 0008: org links equal the count of orgs still holding the legacy FK:
SELECT count(*) FILTER (WHERE organization_id IS NOT NULL) AS org_links,
       (SELECT count(*) FROM organizations WHERE payment_intermediary_id IS NOT NULL) AS orgs_with_fk
FROM donor_payment_intermediaries;
```

## Hand-off — actions only the user can perform

The agent cannot write to prod or publish. The user must:

1. **Apply each SQL file to prod**, in the order above:
   `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <file>.sql`
   (run the pre-flight queries first if you want to preview the impact).
2. **Click Publish** to deploy this morning's code/UI (the "gives through" links,
   the Fundable Projects page, org/individual detail edits, the
   funders→organizations relabel, the opportunity status/loss-type split, the
   verbal-confirmation rename, the free-mail domain matcher hardening, the
   priorities-page refresh, and the AI rate-limit fix) — landing the additive DDL
   first as noted above.
3. **Run the post-apply verification** queries to confirm each step.

## Out of scope (intentionally not done here)

- Any full-database overwrite of prod (forbidden now).
- Record-by-record dev→prod mirroring (user confirmed no hand edits).
- Dropping the deprecated `organizations.payment_intermediary_id` column (left for
  a later, separately reviewed migration once the new table is confirmed in prod).
- Updating the stale Airtable importer / `lib/db/SCHEMA.md`.
