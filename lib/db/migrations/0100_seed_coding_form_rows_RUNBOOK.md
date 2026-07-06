# 0100 — Seed the donation coding-form rows into PRODUCTION (+ conflicts CSV)

One-time PRODUCTION load of the parsed Wildflower Donation Coding Form exports
(FY24 / FY25 / FY26 Google Form responses + the Girasol / Act-60 sheet) into the
`coding_form_rows` staging table, plus a read-only conflict-analysis report the
team reviews before applying anything in the app.

This is the prod counterpart of the dev-only seed done under migration 0084 (whose
`import:coding-forms` script parses the spreadsheets). The agent **cannot write
prod**, so instead of running that importer against prod we ship a **static,
reviewable SQL file** that performs the exact same write, applied by a human.

**Guiding rule — compare, don't clobber.** The seed only ever refreshes the raw /
normalized captured columns; it never touches reviewer decisions, match state, or
applied artifacts. So it is safe to re-run, even on top of a partially-reviewed
prod table.

## What ships how

| Piece | How it reaches prod |
| --- | --- |
| `coding_form_rows` table + `coding_form_row_status` / `intended_usage` enums + indexes | Normal **Publish** (drizzle schema diff), as in 0084. Must be present before this seed. |
| The 284 parsed rows | **Operator step** — apply `0100_seed_coding_form_rows.sql` with `psql` (below). SQL cannot parse the spreadsheets, so the rows are pre-rendered into the file. |
| A conflict-analysis CSV | **Operator step** — run the read-only `analyze:coding-form-conflicts` script against prod (below). Nothing is written; it only produces a CSV. |
| Donor / opportunity / gift matches, cross-check resolutions, applied values | **In-app**, by an admin, on the *Coding Form Import* review page (`/coding-form-import`). Unchanged from 0084. |

## Rollout order

1. **Publish first.** The `coding_form_rows` table + enums land in prod via the
   normal schema Publish (see 0084's runbook). This data seed will fail with
   `relation "coding_form_rows" does not exist` if the table is not yet present
   (see `.agents/memory/data-migration-publish-ordering.md`).

2. **Seed the rows** (idempotent — safe to re-run):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0100_seed_coding_form_rows.sql
   ```

   Expected: `INSERT 0 284`, then a NOTICE:
   `coding_form_rows after seed 0100: total=284 (fy24=51, fy25=111, fy26=110, girasol=12).`

3. **Generate the conflict-analysis CSV** (READ-ONLY — issues only SELECTs; never
   calls the writing `rematchRow` / `applyRow`). Point `DATABASE_URL` at prod for
   this one invocation:

   ```bash
   DATABASE_URL="$PROD_DATABASE_URL" \
     pnpm --filter @workspace/api-server run analyze:coding-form-conflicts
   ```

   Writes `coding-form-conflicts.csv` at the repo root (override with a path arg).
   The script prints a summary (per-`match_status` counts + conflict tallies).

4. **Review + apply in the app.** An admin opens **Coding Form Import** (admin
   nav) and, per row, confirms/overrides the donor match, reviews the
   per-attribute cross-check (new / same / conflict), ticks the attributes to
   apply (apply fills only *missing* CRM values / reviewer-approved conflict
   overwrites — it never clobbers), and clicks *Apply selected*. The CSV from
   step 3 is the team's pre-flight worksheet for that review — it is not itself an
   apply step.

5. **Pull the grant-agreement documents** (separate, in-app). Once matches are
   confirmed, the same page's **"Import all ready"** button pulls each row's
   Google Drive grant agreement onto its matched **opportunity** (never a gift),
   idempotently. This is a client-side sequential loop; re-runs are no-ops on
   already-imported rows.

   > **Known caveat — chase the failures by hand.** A Drive fetch that 404s /
   > can't be downloaded is recorded on the row as a `failed` outcome (not a
   > crash). At last check ~23 of the ~264 linked files were unreachable
   > (`http_404`) plus a handful of unparseable placeholder links; those rows will
   > show `failed` and must be tracked down individually. A different existing
   > grant letter is left as a `conflict` and only replaced on an explicit
   > reviewer *replace*.

## What the seed does / doesn't touch

The `ON CONFLICT (id) DO UPDATE` refreshes **only** the 27 raw / normalized
captured columns + `updated_at`. It never writes `source` / `source_row_index`
(identity) and, critically, never touches:

- reviewer `decisions`
- lifecycle `status` (+ `applied_at`, `applied_by_user_id`)
- the proposed / confirmed match (`organization_id`, `individual_giver_person_id`,
  `household_id`, `matched_opportunity_id`, `matched_gift_id`, `match_score`,
  `match_method`, `match_tier`, `match_confirmed_at`, `match_confirmed_by_user_id`)
- applied artifact ids (`applied_task_id`, `applied_address_id`,
  `applied_allocation_id`)
- grant-letter import state (`grant_letter_imported_url` / `_filename` / `_at`,
  `grant_letter_import_error`)

So re-applying after review (or applying a corrected spreadsheet) picks up new raw
values without discarding any human decision.

## The conflict-analysis CSV

One row per coding-form row, so **`no_match` rows stay visible** (they are not
dropped). It computes a **fresh** match against live CRM state using the exact
same code path as the app (`computeProposedMatch` → `scoreStagedPayment` + the
same-donor opportunity pick), then runs the app's live `crossChecksFor` plus a
money / QuickBooks comparison against the matched gift (and the QuickBooks staged
payment behind it). Every money attribute is emitted as an explicit
**sheet / system / conflict** triple so a reviewer can remediate straight from the
CSV without opening the app. Columns:

| Column | Meaning |
| --- | --- |
| `id`, `source`, `source_row_index` | Coding-form row identity |
| `donor_name_raw` | Donor name as it appears on the sheet |
| `match_status` | `no_match` / `donor_only` / `opportunity` / `gift` (strongest resolution) |
| `match_tier`, `match_score`, `match_method` | From the shared scored matcher |
| `donor_kind`, `donor_id`, `donor_name` | Resolved CRM donor (org / person / household) + its name |
| `matched_opportunity_id`, `matched_gift_id` | Proposed CRM links |
| `amount_sheet`, `amount_system`, `amount_conflict` | Sheet amount vs matched gift amount; `Δ<delta>` when they differ by > $0.01 |
| `donation_date_sheet`, `donation_date_system`, `donation_date_conflict` | Sheet donation date vs gift `date_received`; `<n>d apart` when > 45 days |
| `deposit_date_sheet`, `deposit_date_system`, `deposit_date_conflict` | Sheet deposit date vs the linked QB staged-payment date; `<n>d apart` when > 45 days |
| `payment_method_sheet`, `payment_method_system`, `payment_method_conflict` | Sheet method (free text) vs gift `payment_method` / QB instrument, compared by normalized family; `<sheet>≠<system>` when the families clearly differ (unknown families left uncompared) |
| `qb_tie_status`, `qb_tie_conflict` | Matched gift's QuickBooks tie; conflict when `amount_mismatch` / `missing` |
| `attribute_conflicts` | Qualitative cross-checks in `conflict` (sheet vs CRM values) |
| `attribute_new` | Cross-checks that would newly fill an empty CRM field |
| `blocked` | Cross-checks that can't run yet (+ reason) |
| `has_conflict` | `yes` if any money or attribute conflict |

> **Note (dev vs prod).** Live QuickBooks / Stripe money and recently-changed CRM
> rows live in **prod**, not dev — running the analysis against dev shows sparse
> matches and few money conflicts. The meaningful pass is against prod (step 3).

## Idempotency & safety

- The seed is a single `INSERT ... ON CONFLICT (id) DO UPDATE` — no `BEGIN` /
  `COMMIT` in the file (`psql -1` wraps the whole file in one transaction). Re-run
  count stays 284, no duplicates.
- The analysis script only reads (verified: `coding_form_rows.updated_at` is
  unchanged across a run). It can be re-run any number of times.

## Regenerating the artifacts (if the source spreadsheets change)

Both files are generated from the source workbooks in `attached_assets/`:

```bash
# regenerate the static prod seed SQL (this file's companion .sql)
pnpm --filter @workspace/scripts run gen:coding-forms-seed
```

The conflict-analysis script (`analyze:coding-form-conflicts`) reads whatever is
already seeded in the target DB, so it does not need regeneration.

## Placement note (architecture)

Task #580 asked for both deliverables under `@workspace/scripts`. Only the **seed
generator** lives there (`scripts/src/generate-coding-forms-seed-sql.ts`), because
it reuses the pure spreadsheet parser already in `@workspace/scripts`. The
**conflict-analysis script** lives in the API server
(`artifacts/api-server/src/scripts/analyze-coding-form-conflicts.ts`) instead: it
must reuse the real matcher (`scoreStagedPayment`) and `crossChecksFor`, which
live in `artifacts/api-server` and cannot be cross-imported from a leaf workspace
package (`scripts` has `rootDir: "src"`, so the import trips TS6059). Putting it
next to the code it reuses keeps the analysis in exact lockstep with the live app
match — the alternative (copying the matcher into `scripts`) would drift.
