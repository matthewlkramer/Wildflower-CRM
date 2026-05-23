# Database Schema Reference

The schema in `lib/db/src/schema/` mirrors the Wildflower "crm files" Airtable base (`app8KUcmaHZ0AtcJZ`). Every entity table uses the Airtable record ID (`recXXXXXXXX`) directly as its `id` primary key so re-imports are idempotent and linked-record arrays from Airtable work as foreign keys without translation. The only exception is `regions`, whose PK is a human-readable slug (see below). Rows synthesized by the importer (`pi-email-<piId>`, `org-addr-<orgId>`, `synth-*`) are distinguishable from imported rows by the `id NOT LIKE 'rec%'` predicate.

## Core entities

- `regions` — geographic regions, self-referencing `parent_region_id`. Enum `region_type`: state, metro_area, city, neighborhood, region_within_state, multi_state_region, country, continent. **PK is a human-readable slug** (e.g. `united_states__minnesota__saint_paul`), not the Airtable record ID. The slug is built from the region's own name plus the names of its ancestors of the "included" types (`continent` / `country` / `state` / `city` / `neighborhood`); intermediate aggregation layers (`multi_state_region`, `region_within_state`, `metro_area`, untyped) appear only as the last segment of their own slug and are skipped when building descendants' slugs, so inserting or removing e.g. a "Great Lakes Region" wrapper between `united_states` and `minnesota` never disturbs the state or its cities. `display_path` is a denormalized comma-separated full path including every ancestor (e.g. `United States, New England, Massachusetts, Greater Boston, Boston`), populated by the importer for cheap UI display.

- `schools` — mirrored one-way from the dedicated Wildflower **Schools** Airtable base (`appJBT9a4f3b7hWQ2`), specifically the "Data for CRM in Replit" view. Re-sync with `AIRTABLE_TOKEN=... node lib/db/src/sync-schools-from-airtable.mjs` (the script wipes and reloads the table; uses Airtable record IDs as PKs). Columns mirrored: `name`, `long_name`, `short_name`, `status` (enum `school_status`: `emerging` / `open` / `paused` / `closing` / `permanently_closed` / `disaffiliating` / `disaffiliated` / `placeholder` / `abandoned`), `governance_model` (enum: `independent` / `district` / `charter` / `exploring_charter` / `community_partnership`), `ages_planes` (text[] of Airtable record IDs from the linked Ages-Planes table — not imported as its own table yet), `logo_main_square_url`, `stage_status` (Airtable formula; denormalized for convenience), `current_mailing_address` and `current_physical_address` (denormalized lookups from the Locations table, joined with `\n\n` when multi-valued). The schools base lives in a different Airtable base than the "crm files" base used by the other importer, so the dedicated-base record IDs replace the old crm-files-base IDs — no other tables currently FK to schools.

- `households` — name + `active` boolean (defaults true; set false when a household is dissolved by death or divorce). Households can be the direct donor on opps/gifts (see `household_id` on those tables).

- `funders` — institutional + family funders. Self-referencing `parent_funder_id`. Array columns for `interests_thematic`, `interests_ages`, `interests_gov_models`. Includes optional `org_email` and `historical_names text[]` (prior names a funder went by, for searchability after rebrands/merges). Enum columns: `funding_entity_subtype` (18 values like `family_foundation`, `corporate_foundation`, `government`, etc.), `number_of_employees` (size buckets `e_1` / `e_2_10` / `e_11_50` / `e_51_250` / `e_251_1000` / `e_1001_10000` / `e_10000_plus`), `capacity_rating` (`tier_10k_50k` … `tier_1m_plus`), `connection_status` (`connected` / `have_a_connector` / `no_connection`), `enthusiasm` (`advocate` / `supportive` / `warm` / `neutral` / `unsupportive`), `strategic_alignment` (`high` / `medium` / `low`), `active_status` (`active` / `defunct` / `spenddown`).

- `organizations` — non-funder orgs (advisors, intermediaries, etc.). Also carries `historical_names text[]`. All address fields live in the `addresses` table (FK `organization_id`); the importer creates a synthetic `org-addr-<orgId>` address row per org with any address data. `owner_user_id` is the FK to the team member who owns the org (replaces a legacy Copper free-text `owner` column that has since been dropped). `type` is an enum with 20 values (`advocacy_membership_lobbyist`, `authorizer`, `cmo`, `capital_provider`, `government`, `corporation`, `education_vendor`, `elected_official`, `higher_ed`, `investor`, `law_firm`, `media`, `nonprofit`, `philanthropic_advisor`, `real_estate`, `school`, `school_district`, `school_network`, `small_business_consulting`, `tribal`).

- `payment_intermediaries` — DAFs, giving platforms, private wealth managers. Enum `payment_intermediary_type`: `daf` / `giving_platform` / `private_wealth_manager`.

- `people` — individuals (donors, advisors, staff contacts). Joined to entities via `people_entity_roles`.

- `people_entity_roles` — polymorphic join: a person plays a role in exactly one of funder / organization / payment_intermediary / household (enum `entity_role_type`). `connection` enum (`employee` / `principal` / `board_member` / `partner` / `professor` / `donor_advisor` / `elected_official`) and `people_role_current` (`current` / `past`).

- `emails`, `phone_numbers`, `addresses` — contact info. Each row carries optional FKs `person_id`, `funder_id`, `organization_id`, `payment_intermediary_id`, `household_id` (exactly one is typically set). Each contact row has `validity` (`valid` / `invalid` / `unknown`) and `is_preferred` boolean. `emails.type` uses `email_type` enum (`work` / `personal` / `other`); `phone_numbers.type` uses `phone_type` (`work` / `mobile` / `home` / `other`). `addresses` also carries denormalized `city_name` and `state_code` populated by the importer from the linked region.

- `entities` — fund entities (Wildflower Foundation, Black Wildflowers Fund, Sunlight - debt, Sunlight - grants, Observation Support Technologies / Observant Education, Tierra Indigena, Embracing Equity, Rising Tide). Slug-style PK so new entities can be added through the UI without a migration. Referenced by `pledge_allocations.entity_id` and `gift_allocations.entity_id` (single FK each). "Sunlight - equity" was merged into "Sunlight - grants" — the equity entity was never funded in practice; the importer's alias map reroutes any stray Airtable references.

- `fundable_projects` — specific projects a contribution can fund (seeded: `mdd`, `ssj`, `charter_growth`, `tsl`, `observation_support_tech`). Slug PK. Referenced by `pledge_allocations.fundable_project_id` and `gift_allocations.fundable_project_id` whenever the row's `intended_usage` is `'project'`. `fundable_project_id` is **optional** even when `intended_usage='project'` — the team often knows a gift is project-scoped before they've decided which project, so the FK is filled in later. The inverse is enforced by convention: `fundable_project_id` should be NULL whenever `intended_usage` is not `'project'`.

- `fiscal_years` — reference table for Wildflower's July 1 – June 30 fiscal years. Slug PK (e.g. `fy2024`), seeded from `fy2014` through `fy2050`, plus a `future` sentinel. Used by `pledge_allocations.grant_year`, `gifts_and_payments.grant_year`, and `gift_allocations.grant_year` (single text FK each — one fiscal year per per-row money booking; multi-year commitments are split across multiple allocation rows).

- `opportunities_and_pledges` — both opportunities and pledges live in one table (the same row carries an idea from "we should talk to this funder" all the way through to "they committed $X"), and the row is **header-only**. `status` is the lifecycle discriminator. Column validity by status (convention, not DB-enforced — see the header comment in `opportunitiesAndPledges.ts` for the full breakdown): `open` rows use the opportunity-phase fields (`ask_amount`, `stage`, `win_probability`, `projected_close_date`, `application_deadline`); `won` rows use the pledge-phase fields (`awarded_amount`, `conditions_met`, `actual_completion_date`, `payment_details`); `lost` uses `loss_reason` + `actual_completion_date`; `dormant` is treated as a frozen snapshot of whatever opportunity-phase fields were last captured. Two partial indexes back the hot read paths: `opportunities_and_pledges_open_pipeline_idx` on `(funder_id, projected_close_date) WHERE status='open'` and `opportunities_and_pledges_won_completed_idx` on `(actual_completion_date) WHERE status='won'`. All scope (which fund entities, which fiscal years, which regions, which intended usages / fundable projects, and per-line sub-amounts) lives one level down on `pledge_allocations`. Every opportunity should have at least one allocation row even while the conversation is fuzzy — those carry `status='working'` and act as the scratch pad; once a funder commits they flip to `committed` / `committed_with_conditions`; once the money lands they flip to `superseded_by_gift` and the corresponding `gift_allocations` rows become the canonical record. `status` (`open` / `won` / `dormant` / `lost`), `type` (`solicitation` / `renewal` / `open_application`), `stage` (9 values: `cold_lead` … `cash_in`), and `conditional` (`unconditional` / `reimbursable` / `conditional_on_funder_determination` / `conditional_on_target`) are all enums. `match_id` is a self-referential FK on the matching-gift row pointing to the original opportunity it matches. `owner_user_id` is the FK to the team member who owns the opp (replaces a legacy Copper free-text `owner` column that has since been dropped). `copper_pledge_id` preserves the Copper-era external pledge ID for cross-reference.

- `pledge_allocations` — line items within a pledge / opportunity. All per-row scope (entity, fiscal year, region, intended usage, fundable project) lives here. `status` enum: `working` (draft an internal user is iterating on), `committed` / `committed_with_conditions` (firm commitments from the funder), `superseded_by_pledge` (replaced by a later allocation — re-scoped or split differently), `superseded_by_gift` (an actual `gift_allocations` row took its place), `abandoned` (dropped without being paid). The legacy plain `superseded` value is retained in the DB enum but unused — new writes pick one of the two specific variants.

- `gifts_and_payments` — gift records + payments against pledges, **header-only** like opportunities. All scope (entity, fiscal year, region, intended usage, fundable project, school recipient, spending window) lives one level down on `gift_allocations`. A simple one-line gift carries a single `gift_allocations` row whose `sub_amount` equals the gift's `amount`. `payment_on_pledge_id` → opportunities_and_pledges. Enums: `type` (`standard_gift` / `pledge_payment` / `directed_gift` / `loan_fund_investment` / `matching_gift`), `payment_method` (`ach` / `check` / `wire` / `stock` / `donor_box` / `daf_ach` / `daf_check` / `daf_bill_com`). `date_received` is the canonical "money arrived" date for every gift — gifts are by definition received money, so this column should always be populated (2 legacy rows currently lack any date and are deferred for human review before a future `NOT NULL` constraint). The importer falls back through the legacy Copper `completed_date` → `close_date` fields when Airtable doesn't ship `date_received`; the legacy columns themselves have been dropped from the schema.

- `gift_allocations` — line items within a gift. `entity_id` FK → `entities` (formerly a free-text `recipient` column; now stored as the slug for the receiving fund entity). `fundable_project_id` FK → `fundable_projects` when intended_usage = 'project'. `formal_regional_restriction` and `formal_fund_use_restriction` booleans are orthogonal (where vs what the funder limited the money to).

- `users` — Clerk-provisioned app users (kept for auth middleware).

## Donor on opps + gifts — three mutually-exclusive options

Both `opportunities_and_pledges` and `gifts_and_payments` carry three nullable donor FKs. **At most one is set per row**, enforced by a `donor_xor` CHECK constraint (`num_nonnulls(...) <= 1`). Currently lenient (`<= 1`, not `= 1`) because ~12 legacy rows with no donor linked are awaiting triage; tighten to `= 1` once those are resolved.
- `funder_id` → `funders` — organizational donor (foundation, corp, govt, etc.)
- `individual_giver_person_id` → `people` — single-person donor (their own account)
- `household_id` → `households` — joint-account donor (couples on joint checking / joint card / joint DAF). Lead person for the gift is captured via `primary_contact_person_id`.

Manual data corrections that aren't recreated by the Airtable importer live in [`lib/db/src/post-import-fixups.sql`](src/post-import-fixups.sql) — idempotent SQL to run after a fresh reimport.

## Primary contact rules

**Primary contact uniqueness**: `people_entity_roles.primary_contact = true` is *conventionally* singular per funder (one operational lead) but the schema does not enforce it, because real-world cases exist where a funder genuinely has two equally-primary contacts. Two such cases are currently in the data: **U.S. Bank / U.S. Bank Foundation** — Sean Birney and Reba Dominski lead different parts of the bank (this may warrant splitting the funder record into "U.S. Bank" + "U.S. Bank Foundation" later); and **George W. Brackenridge Foundation** — Victoria Rico and Randy Boatright (both board members; needs human review to identify the operational contact). All other previously-dual-primary funders have been demoted to single-primary.

**Primary contact — historical attribution rule**: `opportunities_and_pledges.primary_contact_person_id` and `gifts_and_payments.primary_contact_person_id` are the system of record for "who did we actually work with on this specific opp/gift." Funder-level primaries (`people_entity_roles.primary_contact = true`) change over time as funder staff turn over; the opp/gift's own column stays frozen so historical attribution survives. **Precedence when reading**: opp/gift's own `primary_contact_person_id` if set; otherwise fall back to the funder's `primary_contact=true` role only for present-tense "who do I email about funder X right now" questions, never for historical attribution. **When writing**: always populate the opp/gift column. The importer applies a cascade (individual_giver → funder unique primary → parent pledge for gifts) to backfill legacy rows; 91 rows from the initial import (59 opps + 32 gifts) couldn't be filled automatically and are deferred for human review before a future `NOT NULL` constraint is added.

## Intended usage

`pledge_allocations` and `gift_allocations` each carry an `intended_usage` enum (`gen_ops` / `growth` / `school_startup` / `teacher_training` / `project`) plus a nullable `fundable_project_id` FK to `fundable_projects`. The FK is populated only when `intended_usage = 'project'`. The parent `opportunities_and_pledges` / `gifts_and_payments` rows are header-only and do not carry these fields. The importer's `INTENDED_USAGE_MAP` translates legacy Airtable strings (e.g. `project_ssj` → `intended_usage='project'`, `fundable_project_id='ssj'`; `General Operations` → `gen_ops`; `Seed Fund` → `school_startup`).

## Many-to-many via slug arrays

Many-to-many links (a funder having multiple regional priorities, an allocation tied to multiple regions, etc.) are stored as `text[]` columns of slug-PK references rather than in dedicated junction tables. The choice is deliberate: slug PKs (e.g. `united_states__minnesota`, `wildflower_foundation`, `fy2024`) make orphaned or rotted references visually identifiable on inspection, in exchange for giving up DB-level FK enforcement on the individual array elements. Each such array column carries a **GIN index** so membership queries stay fast — **but only when written with array operators (`@>` / `&&` / `<@`), not with `= ANY(...)`** (which forces a sequential scan). Use `WHERE region_ids @> ARRAY['minnesota']::text[]` ("contains all of"), `WHERE region_ids && ARRAY['minnesota','wisconsin']::text[]` ("overlaps with any of"), or `WHERE region_ids <@ ARRAY[...]` ("subset of"). Drizzle's `arrayContains`, `arrayContained`, and `arrayOverlaps` helpers emit these operators directly. Note: the parent `opportunities_and_pledges` and `gifts_and_payments` rows are header-only and no longer carry their own multi-value scope arrays — every entity / year / region tag lives on the child allocation rows.

## Imported record counts (current dev DB)

| Table | Rows |
|---|---|
| regions | 569 |
| schools | 131 (synced from dedicated Schools base) |
| funders | 728 |
| organizations | 792 |
| payment_intermediaries | 35 |
| households | 75 |
| people | 3,201 |
| people_entity_roles | 2,456 (2,331 imported + 125 synth-per-* recovered from dropped FKs) |
| emails | 3,094 |
| phone_numbers | 1,203 |
| addresses | 1,676 |
| opportunities_and_pledges | 601 (16 since reclassified to household-as-donor) |
| pledge_allocations | 430 (68 imported + 362 synthesized as `working`) |
| gifts_and_payments | 691 (46 since reclassified to household-as-donor) |
| gift_allocations | 793 (141 imported + 652 synthesized from header-only gifts) |

## Re-importing from Airtable

1. Use the Replit Airtable connector to fetch every record from the 15 tables of base `app8KUcmaHZ0AtcJZ` and write them as JSON to `/tmp/airtable-dump/<table>.json` (one file per table).
2. Run `node lib/db/src/import-airtable.mjs`. The importer:
   - Uses each Airtable record ID (`recXXXXXXXX`) as the Postgres primary key for every table except `regions`, so linked-record arrays in Airtable just work as foreign keys.
   - For `regions`, computes the human-readable slug PK and `display_path` per the rules above, builds a rec→slug map at region-insert time, and translates every region reference in the rest of the import (addresses.city_region_id, addresses.state_region_id, people.current_home_region_id, and the six `region_ids text[]` columns) through that map.
   - Inserts in dependency order; self-references (regions.parent, funders.parent) are filled in a second UPDATE pass.
   - Validates every FK against an in-memory set of inserted IDs and drops orphans rather than failing.
   - Uses `ON CONFLICT (id) DO NOTHING` so it's idempotent — running twice is safe.
   - Populates the `region_ids text[]` columns on the allocation tables last.
   - **Synthesizes allocation rows last**: the Airtable source treats per-opportunity and per-gift scope as parent-row fields (entity, year, intended usage, region) and ships explicit child allocations only for the firmed-up cases. To enforce the rule that **all scope lives on allocations**, the importer fans the parent's scope out into the child table:
     - For every open opp that didn't ship its own `pledge_allocations`, one synth row per (entity × grant_year) combination is inserted with `status='working'` and `sub_amount = ask_amount / n_rows` (deterministic IDs `synth-pa-<opp>-<entity|nil>-<year|nil>` make re-runs idempotent).
     - For every gift that didn't ship its own `gift_allocations`, one synth row is inserted with `sub_amount = amount` (deterministic ID `synth-ga-<gift_id>`).
   Synthesized rows are distinguishable from imported ones by the `id LIKE 'synth-%'` predicate.

The legacy `pnpm --filter @workspace/db run seed` is a no-op stub; importing happens through the script above.

**Note**: Airtable is slated for archival once the new CRM is in steady use; ongoing import drift (e.g. household-as-donor reclassifications, manual funder merges, historical_names backfills) is not being written back to Airtable.
