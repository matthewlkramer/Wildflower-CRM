# Database Schema Reference

> **Canonical source:** the Drizzle definitions in `lib/db/src/schema/*.ts` and the
> enum list in `lib/db/src/schema/_enums.ts` are the source of truth. This file is a
> human-readable map of *what each table is for* and the cross-table invariants that
> are easy to break — when in doubt, trust the code.
>
> **Historical data:** most of the data in the system comes from experts of Copper that were cleaned up by the user manually in Airtable before
> importing them into the CRM. Other data comes from several live syncs - of quickbooks, stripe, donorbox, airtable schools database. There is no need for
> any resyncing with the Airtable files that were cleaned up from copper (sometimes referred to as 'CRM Files') or with copper - the one time sync of those
> source files is complete.

## ⚠️ funders + organizations are now ONE table

The historical split between a `funders` table (grant-makers) and an `organizations`
table (everything else) has been **consolidated into a single `organizations`
table**. A boolean `issues_grants` flag distinguishes grant-makers. Former
funder-only fields (capacity rating, enthusiasm, strategic alignment,
connection status, interests, historical names, self-referencing parent) now live on
`organizations`. The donor-type discriminator that used to be `"funder"` is now
`"organization"`. There is **no `funders.ts`** — any reference to a `funders` table
in older notes is stale.

## Core entities

- `regions` — geographic regions, self-referencing `parent_region_id`. Enum
  `region_type`: state, metro_area, city, neighborhood, region_within_state,
  multi_state_region, country, continent. **PK is a human-readable slug** (e.g.
  `united_states__minnesota__saint_paul`), built from the region's own name plus the
  names of its ancestors of the "included" types (continent / country / state / city
  / neighborhood); intermediate aggregation layers (multi_state_region,
  region_within_state, metro_area, untyped) appear only as the last segment of their
  own slug and are skipped when building descendants' slugs, so inserting/removing a
  wrapper between `united_states` and `minnesota` never disturbs the state or its
  cities. `display_path` is a denormalized comma-separated full path for cheap UI
  display.

- `organizations` — **all external entities** (grant-makers AND non-grant-making
  orgs: advisors, intermediaries, vendors, networks, etc.). `issues_grants`
  distinguishes grant-makers. Self-referencing `parent_organization_id`. `type` is
  the unified `entity_type` enum (~32 values — replaces the old
  `funding_entity_subtype` + `organization_type` pair; the old enums are retained in
  the DB only for migration safety). Array columns for `interests_thematic`,
  `interests_ages`, `interests_gov_models`, and `historical_names text[]` (prior
  names, for searchability after rebrands/merges). Grant-maker fields:
  `number_of_employees` (size buckets), `capacity_rating`
  (`tier_1k_10k` … `tier_1m_plus`), `connection_status`, `enthusiasm`
  (now **prefixed/ordered** values: `7-advocate`, `6-supportive`, `5-warm`,
  `4-neutral`, `3-cool`, `2-unsupportive`, `1-hostile`), `strategic_alignment`,
  `active_status` (`active` / `defunct` / `spenddown`). `owner_user_id` → the team
  member who owns the org. `anonymous` flag → UI-only name masking (see Anonymous
  records below).

- `schools` — mirrored one-way from the dedicated Wildflower **Schools** Airtable
  base (`appJBT9a4f3b7hWQ2`), "Data for CRM in Replit" view. Re-sync with
  `AIRTABLE_TOKEN=... node lib/db/src/sync-schools-from-airtable.mjs` (wipes and
  reloads; uses the Schools-base record IDs as PKs). `status` enum `school_status`,
  `governance_model` enum, `ages_planes text[]` (GIN-indexed for membership
  filtering; the linked Ages-Planes table is not imported on its own). No other table
  FKs to schools except `gift_allocations.school_recipient_id`.

- `households` — name + `active` boolean. Households can be the direct donor on
  opps/gifts (see `household_id`).

- `people` — individuals (donors, advisors, staff contacts). `anonymous` flag →
  UI-only name masking. Joined to entities via `people_entity_roles`. `newsletter` /
  `unsubscribed_to_newsletter` drive the Flodesk sync eligibility.

- `people_entity_roles` — polymorphic join: a person plays a role in exactly one of
  organization / payment_intermediary / household (enum `entity_role_type` =
  `organization` / `payment_intermediary` / `household` — note **no `funder`**).
  `connection` enum (`employee` / `principal` / `board_member` / `partner` /
  `professor` / `donor_advisor` / `elected_official`) and `people_role_current`
  (`current` / `past`). `primary_contact` boolean (conventionally singular per org;
  not DB-enforced — genuine dual-primary cases exist).

- `payment_intermediaries` — DAFs, giving platforms, private wealth managers. Enum
  `payment_intermediary_type`: `daf` / `giving_platform` / `private_wealth_manager`.

- `donor_payment_intermediaries` — join linking a donor (org / individual / household
  — donor-XOR at the join level too) to a payment intermediary it gives *through*.

- `emails`, `phone_numbers`, `addresses` — contact info. Each row is owned by
  **exactly one** of `person_id` / `organization_id` / `payment_intermediary_id` /
  `household_id` (CHECK `num_nonnulls(...) = 1`; CASCADE on owner delete).
  `validity` (`valid` / `invalid` / `unknown`) and `is_preferred`. `emails.type` =
  `email_type`; `phone_numbers.type` = `phone_type`. **`emails` is globally unique on
  `lower(email)`** (one address per row anywhere; API returns 409 on collision).
  `addresses` carries denormalized `city_name` / `state_code`.

- `entities` — internal **fund entities** money is booked against (Wildflower
  Foundation, Black Wildflowers Fund, Sunlight - debt, Sunlight - grants, etc.).
  Slug PK so new entities can be added through the UI without a migration. Referenced
  by `pledge_allocations.entity_id` and `gift_allocations.entity_id`.

- `fundable_projects` — specific projects a contribution can fund (e.g. `mdd`, `ssj`,
  `charter_growth`, `tsl`). Slug PK. Referenced by the allocation tables when
  `intended_usage = 'project'`. The FK is **optional** even for project usage (the
  team often knows a gift is project-scoped before deciding which project). Managed at
  `/fundable-projects`.

- `fiscal_years` — Wildflower's July 1 – June 30 fiscal years. Slug PK (e.g.
  `fy2024`), seeded `fy2014`–`fy2050` plus a `future` sentinel. Used by the
  allocation tables' `grant_year` (one fiscal year per per-row booking; multi-year
  commitments split across rows). The table's own `goal_amount` is legacy/unused —
  goals live in `fiscal_year_entity_goals`.

- `fiscal_year_entity_goals` — per-track fundraising goals. **PK is
  `(fiscal_year_id, entity_id, loan_or_grant)`** (migration 0120), so the grant
  (revenue) and loan-capital tracks each carry their own goal. Cascading FKs to
  both parents. Analytics sum across this table honoring the same entity/track
  filters as the money rollups.

- `users` — Clerk-provisioned app users (`role` includes `admin`; admin gates
  show-archived, restore, and admin-only screens).

## Opportunities, pledges, gifts (the money model)

- `opportunities_and_pledges` — both opportunities and pledges in one **header-only**
  row (an idea → a committed grant). All scope (entities, fiscal years, regions,
  intended usage, sub-amounts) lives one level down on `pledge_allocations`.
  - **`status` is FULLY CALCULATED server-side — never written directly.** Enum
    `opportunity_status` = `open` / `pledge` / `cash_in` / `dormant` / `lost`.
    Derivation (see `pledgeStage.ts` / `deriveOppFields`): if `loss_type` is set →
    status = that; else complete → `cash_in` — where "complete" is
    payment-driven (paid ≥ awarded > 0) for `fixed_commitment` and
    closure-driven (`award_closed_at` set) for `cost_reimbursement`; else
    `written_pledge` → `pledge`; else `open`. Stage never drives status.
  - **`loss_type`** (enum `opportunity_loss_type` = `dormant` / `lost`, nullable) is
    a user-settable lifecycle input — it pulls a row out of the calculated funnel.
  - **`disbursement_model`** (enum `disbursement_model` =
    `fixed_commitment` / `cost_reimbursement`, NOT NULL default
    `fixed_commitment`, Task #788) — how the money is disbursed.
    `fixed_commitment`: known installments (see `pledge_expected_payments`);
    completes when paid ≥ awarded. `cost_reimbursement`: the award is a CEILING
    drawn down as costs are incurred; annual pledge allocations are the
    forecast, overdue nagging is suppressed, and the pledge completes **only**
    via the explicit finance-permitted Close-award action — never by
    paid ≥ ceiling. Replaces the retired `conditional='reimbursable'` input
    (legacy allocation rows keep the value for history; migration 0151
    reclassified their pledges).
  - **`award_closed_at`** (date, nullable) + **`award_close_reason`** (enum
    `award_close_reason` = `fully_collected` / `award_period_ended` /
    `unused_balance` / `terminated`) — set only by the finance-permitted
    close-award route (cleared by reopen-award); the second user-set lifecycle
    input alongside `loss_type`. Closing requires the remaining projected plan
    to be resolved (planned ≤ paid) first.
  - Enums: `type` (`solicitation` / `renewal` / `open_application`), `stage` (10:
    `cold_lead`, `warm_lead`, `in_conversation`, `convince`,
    `conditional_commitment`, `probable_renewal`, `verbal_confirmation`,
    `written_commitment`, `cash_in`, `complete`). Stage is a pure funnel,
    separate from the outcome — a WON row (status `pledge` / `cash_in`) reads
    `complete`; everything else keeps its real funnel stage. The three legacy
    commitment/outcome values (`conditional_commitment`, `written_commitment`,
    `cash_in`) are **retained in the pg type for history but no longer written**
    by the app and no longer latch `written_pledge`; migration 0121 remapped the
    last rows carrying them to `verbal_confirmation`, so zero rows use them.
    `conditional` (`unconditional` / `conditional_unspecified` / `reimbursable` /
    `conditional_on_funder_determination` / `conditional_on_target`),
    **`loan_or_grant`** (the authoritative loan-vs-grant flag — see below).
  - A sticky `written_pledge` flag (renamed from `was_pledge`) latches true only
    when a grant letter is uploaded while the money is not already fully in, or
    on an explicit user set — never auto-cleared. It drives the calculated
    `status` (→ `pledge`) and the Pledges-page filter.
    `match_id` self-references the original opp a matching-gift row matches. `owner_user_id`,
    `primary_contact_person_id` (frozen historical attribution), `copper_pledge_id`.
  - The old `closed_requires_completion_date` CHECK has been **dropped** (it blocked
    bulk historical cleanup — ~244 legacy closed rows have no date and must stay
    editable). The rule now lives at the **API layer as a close-transition check**
    (`validateOppCloseTransition` in `@workspace/api-zod`, wired into create /
    PATCH / bulk-update): a request that *newly* closes a row (`loss_type` set, or
    `stage` → `complete`) must leave it with an `actual_completion_date`; edits to
    already-closed rows are never blocked. Do not reinstate the DB CHECK.

- `pledge_allocations` — line items within an opportunity/pledge. All per-row scope
  (entity, fiscal year `grant_year`, `region_ids text[]`, `intended_usage`,
  `fundable_project_id`) lives here, plus the **same three restriction axes as
  `gift_allocations`** (`regional_restriction_type` / `other_restriction_type` /
  `time_restriction_type` — see Restriction taxonomy below) and revenue-coding
  capture (below). `status`
  enum `pledge_allocation_status`: `working` (internal draft), `committed` /
  `committed_with_conditions` (firm), `abandoned` (dropped unpaid). The
  **superseded family is retired** (Task #665): `superseded` /
  `superseded_by_pledge` / `superseded_by_gift` were removed from the API contract
  and the UI (users keep allocations accurate directly; a gift→pledge split now
  writes `committed`), the historical rows were remapped to `abandoned`
  (migration 0120), and the three values remain in the pg enum only because
  removing a pg enum value requires a type rebuild. `expected_payment_date` is
  **`@deprecated`** (Task #788) — installment dates live on
  `pledge_expected_payments`; migration 0151 seeded that table from it, and no
  new readers/writers may use the column.

- `pledge_expected_payments` — installment schedule for a **fixed-commitment**
  pledge (Task #788): `pledge_or_opportunity_id` → `opportunities_and_pledges`
  (RESTRICT), `expected_date` (NOT NULL), `amount` (nullable), `notes`. The
  explicit cash forecast + overdue source for fixed commitments;
  cost-reimbursement pledges need none (their forecast is the allocation plan).

- `gifts_and_payments` — gift records + payments against pledges, **header-only**.
  Scope lives on `gift_allocations`. `payment_on_pledge_id` →
  `opportunities_and_pledges`. Enums: `type` (`standard_gift` / `pledge_payment` /
  `directed_gift` / `loan_fund_investment` / `matching_gift`), **`loan_or_grant`**
  (the authoritative loan-vs-grant flag — see below — dual-written from `type`),
  `payment_method`
  (`ach` / `check` / `wire` / `stock` / `donor_box` / `daf_ach` / `daf_check` /
  `daf_bill_com`). `date_received` is the canonical "money arrived" date.
  `thank_you_sent_at` / `thank_you_email_message_id` stamped by the email-intel
  thank-you flow.

- `gift_allocations` — line items within a gift. `entity_id` → `entities`,
  `fundable_project_id` → `fundable_projects` (when project usage),
  `school_recipient_id` → `schools`, `grant_year`, `region_ids text[]`. Restriction
  is captured on **three independent axes** —
  `regional_restriction_type` / `other_restriction_type` / `time_restriction_type`,
  each a `restriction_axis` (`donor_restricted` / `wf_restricted` / `unrestricted`),
  NOT NULL default `unrestricted` (see below); `pledge_allocations` carries the
  same three axes. `display_usage` is a
  **trigger-maintained, read-only** human label
  (`compute_gift_allocation_display_usage` + triggers in `post-import-fixups.sql`);
  renames of a school / region / fundable project cascade into it — **never write
  `display_usage` directly**. The revenue-coding snapshot no longer lives here — it
  is derived on demand from scope and captured on `staged_payments` (below). The old
  coarse `formal_*` restriction booleans and the per-allocation coding columns
  (`object_code`(+`_override`), `revenue_location`(+`_override`),
  `revenue_class`(+`_override`), `coding_flags`, `restriction_type`,
  `restriction_evidence`, `deferred_revenue`(+`_reason`)) are **`@deprecated`** —
  still physically present for the deprecate-then-drop window, no longer written.
  **`source_pledge_allocation_id`** (→ `pledge_allocations`, SET NULL, Task #788)
  stamps which pledge-plan line a seeded gift allocation drew from —
  remaining-plan inheritance (`copyPledgeAllocationsToGift`) uses it to compute
  what is already drawn; `variance_reason` (text, nullable) captures why a draw
  deviated from plan.

### Donor XOR — three mutually-exclusive donor options

`opportunities_and_pledges` and `gifts_and_payments` each carry three nullable donor
FKs with a `CHECK (num_nonnulls(...) = 1)` ("donor_xor") so **exactly one** is set:
- `organization_id` → `organizations` (institutional donor)
- `individual_giver_person_id` → `people` (single-person donor)
- `household_id` → `households` (joint-account donor; lead via
  `primary_contact_person_id`)

This is enforced at the DB (CHECK), at the API (`validateOppInvariants` /
`validateGiftInvariants` in `@workspace/api-zod`, returning 400 not 500), and PATCH
re-validates the *merged* post-update state. Per-type donor pickers must send all
three FK fields (nulling the unused two).

**Exception — staged queues.** `staged_payments` and `stripe_staged_charges` carry
the same three donor FKs but **no donor_xor CHECK** (a pending row can be unmatched,
so all three may be null). Exactly-one is enforced only when a row is
approved/reconciled into a gift (via `validateGiftInvariants`), not by the table.

### Intended usage

`pledge_allocations` and `gift_allocations` each carry an `intended_usage` enum
(`gen_ops` / `growth` / `school_startup` / `teacher_training` / `project`) plus a
nullable `fundable_project_id` (populated only when usage = `project`). Parent rows
are header-only and do not carry these. NOTE: WE NEED TO CLEAN THIS UP VS. THE RESTRICTION MODEL

## Restriction taxonomy (three axes)

Each allocation row carries **three independent restriction axes** — regional, **other
restriction** (`other_restriction_type`, renamed from the widely-misread "usage" axis:
restrictions beyond region, time, school, and project, e.g. "grants to schools only"),
and time — each a `restriction_axis` enum: `donor_restricted` /
`wf_restricted` / `unrestricted`, NOT NULL default `unrestricted`. A line codes as
*restricted* (→ 4100.x object code) when **ANY** axis is `donor_restricted`;
`wf_restricted` (an internal Wildflower designation) and `unrestricted` both code as
unrestricted (4000.x). This replaces the coarse `formal_*` booleans and the old
`restriction_type` enum (`unrestricted` / `purpose` / `time` / `both` / `unclear` /
`na`). The `restriction_type` columns are `@deprecated` (dropped by migration 0095)
and the now-orphaned `restriction_type` pg **type** is retired by migration 0096.
Because the axes default `unrestricted`, there is no longer an `unclear` review-flag
path from restriction.

Two free-text fields accompany the axes on both allocation tables:
`restriction_description` (nullable; plain-language summary of the restriction, e.g.
"Salaries for RGL and Ops Guide only") and `purpose_verbatim` (nullable; **exact
source language only** — grant letter, Donorbox designation, check memo). Migration
0150 renamed the axis column, added `restriction_description`, and sorted polluted
`purpose_verbatim` content into description/verbatim/cleared.

## Revenue-accounting coding capture (CFO "Revenue Extractor")

Revenue-coding is **derived on demand** from allocation scope (donor kind + fundable
project + region + the three restriction axes) by `revenueCoding.ts` /
`@workspace/api-zod`'s `deriveRevenueCoding`, with per-fund-entity overrides in
`entity_coding_rules` (keyed on `entities.id` — fiscal-sponsee "SPO" defaults:
`force_restricted` / `location` / `revenue_class`). It is **no longer persisted on the
allocation rows**; the allocation editors show a live read-only preview and the
reviewer captures the resolved snapshot onto the matching `staged_payments` row.
- **`staged_payments` coding snapshot** — `object_code`(+`_override`),
  `revenue_location`(+`_override`), `revenue_class`(+`_override`), `coding_flags text[]`,
  `deferred_revenue` enum (`yes` / `no` / `na`), `deferred_revenue_reason`. Captured
  via the staged-payment coding write endpoint; describes the QuickBooks *payment*, not
  the donor's intent.
- `deferred_revenue` enum: `yes` / `no` / `na` (CRM captures the answer; it does NOT
  compute AR).
- `revenue_accounts` — the GL account list the coder maps onto.
- `entity_coding_rules` — per-fund-entity overrides (PK `entities.id`;
  fiscal-sponsee defaults) applied during derivation.

## Grant conditions (on pledge allocations)

Grant conditions live on `pledge_allocations` — `conditional` (enum, nullable) +
`conditions_met` (enum, default `no`). The opportunity header exposes a **derived,
read-only rollup** (`conditionalRollup` / `conditionsMetRollup`, via
`deriveConditionalRollup`): the opportunity is conditional when ANY pledge allocation
is a genuinely-uncertain conditional kind, and conditions are met only when every
conditional allocation has `conditions_met = yes`. This drives win-probability
weighting — a conditional written pledge weights `0.7500` instead of `0.9000`. The old
header `conditional` / `conditions` / `conditions_met` columns are kept physical but
**write-deprecated** (source for the one-time backfill only).

The `reimbursement_type` enum (`direct` / `indirect`, renamed from
`reimbursable_share`) on both allocation tables tags direct-vs-indirect cost share;
`direct`-tagged lines are recorded in full but **excluded** from goal analytics.

## loan_or_grant (the authoritative loan-vs-grant flag)

`loan_or_grant` enum (`loan` / `grant`, NOT NULL default `grant`) is the **single
source of truth** for whether money is loan-fund principal or ordinary
fundraising money — the two tracks report in parallel and are never mixed in
analytics. Lives on `gifts_and_payments`, `opportunities_and_pledges`, and
`fiscal_year_entity_goals` (where it is part of the PK). Opportunity and goal
writes take it directly; a gift's flag is still derived from its `type`
(`loan_fund_investment` → `loan`, everything else → `grant`) via
`giftTypeToLoanOrGrant` in `@workspace/api-zod` (`loan-or-grant.ts`).

**`grant` means ALL non-loan money** — individual donations, foundation grants,
earned revenue, etc. — **not literally only grants.**

The cutover is complete: analytics, goals, and revenue coding all read
`loan_or_grant`. The legacy `fundraising_category` enum and the columns it
backed (`opportunities_and_pledges.fundraising_category`,
`fiscal_year_entity_goals.category`) have been physically dropped (migration
0130). Backfills were migrations 0067/0068; the goals PK swap is 0120.

## Many-to-many via slug arrays

Multi-value links (an org's regional priorities, an allocation's regions, interests,
historical names) are stored as `text[]` columns of slug-PK references, **not**
junction tables. Slug PKs make rotted references visible on inspection, trading away
per-element FK enforcement. Each array column carries a **GIN index** — query with
array operators (`@>` "contains", `&&` "overlaps", `<@` "subset"), **never
`= ANY(...)`** (forces a seq scan) and never `ANY(${jsArray}::text[])` in a Drizzle
`sql` template (renders a row-constructor → runtime cast error — use `inArray()` or
Drizzle's `arrayContains` / `arrayOverlaps` / `arrayContained`).

## Integrations & operational tables

Column-level detail lives in each schema file; this is the orientation map.

**QuickBooks payment sync** (pull-only QBO → CRM)
- `quickbooks_connections` — per-realm OAuth tokens + realmId (encrypted at rest) +
  per-connection sync watermark.
- `staged_payments` — the review queue. Pulled "incoming money" units
  (`quickbooks_entity_type` = `sales_receipt` / `payment` / `deposit`), idempotent on
  `(realmId, qbEntityType, qbEntityId, qbLineId)` (deposits stage per line;
  non-deposit rows use `qbLineId = ''`). `staged_payment_status` (`pending` /
  `approved` / `rejected` / `excluded`); `staged_payment_exclusion_reason` (large
  enum — keep the TS classifier and any SQL backfills in lockstep);
  `staged_payment_match_status` / `_match_method`; classification + entity attribution
  each carry an `auto` vs `manual` source enum (a `manual` pin survives every
  re-classify/re-sync). Carries a *candidate* donor (all three FKs nullable;
  exactly-one enforced only at approve/reconcile) + an `entity_id` attribution.
- `payment_applications` — the authoritative **cash-application ledger** (M:N
  between `staged_payments` and `gifts_and_payments`). It is the **SOLE**
  QB↔gift link record. All four legacy gift-pointer columns were DROPPED:
  `staged_payments.matched_gift_id` / `created_gift_id` /
  `group_reconciled_gift_id` (migration 0126) and
  `gifts_and_payments.final_amount_qb_staged_payment_id` (migration 0130).
  Do not reintroduce gift-pointer columns on these tables. The retired
  `staged_payment_splits` table was dropped in 0115 — a split's resolution
  lives entirely in counted ledger rows. One row per payment↔gift
  booking (HEADER grain):
  `amount_applied` (> 0); `evidence_source` (`quickbooks` / `stripe` / `donorbox`,
  with the matching `stripe_charge_id` / `donorbox_donation_id` required by CHECK);
  `match_method` (`system` / `system_confirmed` / `human`); `created_the_gift`
  (preserves the mint-ownership signal); `link_role` (`counted` /
  `corroborating` — money reads filter `counted`). Both FKs are **RESTRICT**
  (the QB record and the gift are anchors). Book-once = `UNIQUE(payment_id, gift_id)`
  + the service helper's tx row-lock + SUM validation — **no** DB aggregate/fee-band
  constraint. Ledger SUM(amount_applied) per gift is the QB-settled figure the
  tie deriver reads.
- `quickbooks_handling_rules` — admin-editable ingest rules; action
  `quickbooks_rule_action` (`exclude` / `auto_create_approve`). The engine's seed
  rules must mirror the code classifier (a fidelity test guards drift).

**Stripe sync + Stripe↔QuickBooks reconciliation**
- `stripe_payouts` — Stripe NET payout lumps.
- `stripe_staged_charges` — per-charge gross records (the precise gift record).
- `stripe_sync_state` — per-account watermark.
- Reconciliation (`stripeReconcile.ts`) ties a QB deposit/payout lump to its
  individual Stripe charges; the coarse QB-derived gift is then archived and the QB
  staged row is `excluded` with reason `processor_payout` (set **only** on human
  confirm) so the same money isn't booked twice.

**Email / Gmail + calendar sync**
- `google_oauth_tokens` — per-user Google tokens.
- `email_messages` — synced Gmail (enum `email_direction` `sent` / `received`); same
  Gmail message is stored once per mailbox and de-duplicated in the list endpoint via
  `DISTINCT ON (gmail_message_id)`.
- `email_attachments`, `tracked_emails` (+ views) — open-tracking attribution merged
  onto synced messages.
- `email_sync_state` / `calendar_sync_state` — cursors; `no_progress_runs` counts
  consecutive errored runs to flag a stuck mailbox. `email_sync_skip`,
  `correspondent_ignore`, `person_suppression_windows`,
  `calendar_meeting_filters` — sync suppression / matching controls.
- `internal_email_domains` — staff-domain singleton (matcher loads it cached; was a
  hardcoded set).
- `calendar_events`, `interactions` (manual touches; enum `interaction_kind`),
  `meeting_notes` (paste-a-transcript flow), `notes`.

**Email intelligence (AI proposals)**
- `email_proposals` — one actionable signal per row (enum `email_proposal_kind`:
  `linkedin_job_change`, `auto_responder_move`, `bounce_invalid`, `bounce_soft`,
  `signature_update`, `grant_opportunity`, `thank_you_acknowledgment`). Status enum
  `pending` / `applied` / `rejected` / `ignored`.
- `email_intel_prompts` — versioned, admin-editable **review** prompts, one
  key per (`signal_type`, `review_phase`). `signal_type` enum
  `email_intel_signal_type` (`linkedin_job_change`, `auto_responder_move`,
  `bounce`, `signature_update`, `grant_opportunity`,
  `thank_you_acknowledgment` — the two bounce kinds collapse to `bounce`;
  `wildflower_update` is intentionally absent). `review_phase` enum
  `email_intel_review_phase` (`accuracy` / `suppression`). Status
  `active` / `draft` / `archived`, origin `hand_edited` / `ai_generated` /
  `reverted`. Partial unique indexes enforce at most one `active` and one
  `draft` per (`signal_type`, `review_phase`). Both columns are nullable for
  legacy rows (demoted to `archived`). The hidden "action-proposing core"
  prompt (how to act) is hard-coded in `emailIntelPrompts.ts` and never
  stored here or exposed by any API; these rows hold only the accuracy /
  suppression review criteria appended to that core.
- `grant_leads` — team-shared, cross-inbox grant-opportunity queue extracted from
  email (status `new` / `claimed` / `converted` / `archived`).

**Tasks**
- `tasks` (kind `general` / `reporting_deadline` / `thank_you_followup`; status
  `open` / `waiting` / `done` / `cancelled`), `task_proposals` (AI next-step
  suggestions: `pending` / `accepted` / `dismissed`), `task_suggestion_state`.

**Media mentions**
- `media_mentions` (GDELT press coverage), `media_ingest_state`.

**Other**
- `saved_views` (per-page filter/column chooser persistence), `bulk_operations`
  (multi-select edit toolbar), `connection_enthusiasm_history`, `flodesk_sync_state`.

## Anonymous records

`anonymous` flag on `organizations` + `people` masks the name to "Anonymous" in the
UI for everyone except the record owner and admins. **UI-only** — names are still in
API responses. Keep `canSeeIdentity` (display) separate from `canManageIdentity`
(toggle). Join-projection name references aren't masked yet.