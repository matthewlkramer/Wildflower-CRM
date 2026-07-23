# Database Schema Map

**Status:** current-status (implementation map)
**Last verified:** 2026-07-22
**Verified against:** `c76b27df6aefb0a78e611f03c4edd740bbee1d59`

## Authority

This document explains what each table is for and the cross-table invariants
that are easy to break. For exact implemented facts:

1. `lib/db/src/schema/*.ts` — tables, columns, indexes, constraints
2. `lib/db/src/schema/_enums.ts` — database enums
3. `lib/api-spec/openapi.yaml` — public API contract
4. Canonical business-rule documents (see `docs/README.md`) — intended behavior

When this document disagrees with the schema code, the schema code describes
what currently exists. This file documents **implemented state only** —
proposed or approved-but-unshipped changes belong in design/status documents
and must never be presented here as existing schema.

## Data provenance

- Historical CRM data came from a one-time import of manually cleaned exports
  from Copper. That source is **closed** — never resynchronize with Copper or
  the cleaned Airtable files.
- Schools are mirrored one-way from the Schools Airtable base.
- QuickBooks, Stripe, Donorbox, Gmail/Calendar, Flodesk, and GDELT are ongoing
  sources.

Sync ownership and operational resync commands:
[`docs/integrations/data-sources.md`](../../docs/integrations/data-sources.md).

## Domain index

| Domain | Primary tables | Purpose |
|---|---|---|
| Donors & contacts | `organizations`, `people`, `households`, `people_entity_roles`, `payment_intermediaries`, `emails`/`phone_numbers`/`addresses` | External parties and contact info |
| Fundraising pipeline | `opportunities_and_pledges`, `pledge_allocations`, `pledge_expected_payments` | Planned asks, commitments, restrictions, collection plans |
| Received money | `gifts_and_payments`, `gift_allocations` | Actual donor credit and received-money scope |
| Payment evidence | `staged_payments`, `stripe_payouts`, `stripe_staged_charges`, `donorbox_donations`, `bank_transactions` | Imported evidence that money moved |
| Reconciliation relationships | `payment_applications`, `settlement_links`, `source_links` | Authoritative links among evidence and CRM records |
| Internal dimensions | `entities`, `fiscal_years`, `fiscal_year_entity_goals`, `fundable_projects`, `schools`, `charters`, `regions`, `fundraising_campaigns` | Allocation and reporting dimensions |
| Communications | `email_messages`, `calendar_events`, `interactions`, `notes`, `meeting_notes`, tracking/sync-state tables | Synced and manual touches |
| AI / workflow | `email_proposals`, `email_intel_prompts`, `grant_leads`, `tasks`, `task_proposals`, `cleanup_queue` | Proposals, tasks, review queues |
| App plumbing | `users`, `saved_views`, `bulk_operations`, `audit_log`, OAuth/sync-state tables | Auth, UI persistence, operations |

## Cross-table invariants

### Header + allocations (planned vs actual)

```
opportunities_and_pledges  ── header (identity, lifecycle)
└── pledge_allocations     ── PLANNED/committed scope (intentions)

gifts_and_payments         ── header (identity, lifecycle)
└── gift_allocations       ── ACTUAL received-money scope (authoritative)
```

Headers never carry scope: fund entity, fiscal year (`grant_year`), regions,
restriction axes, intended usage / fundable project, and per-line sub-amounts
all live on allocation rows. Every header should have at least one allocation
row. Pledge allocations are intentions; once money lands, the gift allocations
are the canonical record. `gift_allocations.source_pledge_allocation_id`
records provenance when a gift allocation was seeded from a pledge plan line
(gift allocations stay independently editable; `variance_reason` captures a
deliberate deviation).

### Donor XOR

`opportunities_and_pledges` and `gifts_and_payments` each carry three nullable
donor FKs — `organization_id`, `individual_giver_person_id`, `household_id` —
with a DB CHECK (`num_nonnulls(...) = 1`) so **exactly one** is set. Also
enforced at the API (`validateOppInvariants` / `validateGiftInvariants` in
`@workspace/api-zod`) and re-validated on the merged PATCH state. Per-type
donor pickers must send all three fields, nulling the unused two.

**Exception — staged queues.** `staged_payments` and `stripe_staged_charges`
carry the same three donor FKs with **no** XOR CHECK (a pending row can be
unmatched). Exactly-one is enforced only when a row is approved/reconciled
into a gift.

### Derived opportunity lifecycle

`opportunities_and_pledges.status` (`open` / `pledge` / `cash_in` / `dormant` /
`lost`) is **fully calculated server-side** (`deriveOppFields` /
`applyDerivedOppFields`) — never written directly. Derivation: if `loss_type`
is set → status mirrors it; else if complete → `cash_in` — where "complete" is
payment-driven (paid ≥ awarded > 0) for `disbursement_model =
'fixed_commitment'` and closure-driven (`award_closed_at` set) for
`'cost_reimbursement'`; else `written_pledge` → `pledge`; else `open`. The
only user-set lifecycle inputs are `loss_type` (`dormant` / `lost`) and — on
cost-reimbursement pledges only — the finance-permitted Close-award action
(`award_closed_at` + `award_close_reason`). Paid ≥ ceiling never
auto-completes a cost-reimbursement award. `paid` is a persisted derived
rollup of linked non-archived gift amounts, recomputed on every relevant
mutation.

### Evidence relationships (one authority each)

- `payment_applications` is the **sole** unit↔gift cash-application ledger
  (evidence unit → CRM gift). Header grain (`gift_id`, never an allocation;
  `gift_allocation_id` is a narrowing annotation only).
- `settlement_links` is the sole payout↔deposit relationship (Stripe payout →
  QuickBooks deposit lump); at most one link per payout.
- `source_links` is the sole unit↔unit evidence↔evidence claim ledger
  (charge↔QB tie, charge fee row, Donorbox↔QB, Donorbox↔charge). It replaced
  the retired source-specific pointer columns — **never reintroduce pointer
  columns** on evidence or gift tables.
- Statuses (QB tie, payout settlement, match status) **derive from these
  relationships at read time**; do not add stored status columns for them.
  A `source_links` claim is not itself status evidence (claim ≠ status).

### Archive by default

Soft-delete via `archived_at` (non-null = archived, hidden from non-admins) is
the app-wide default; hard deletion only in explicitly documented, tested
exceptions (e.g. QuickBooks revert). Archived gifts are excluded from
analytics and pledge paid-amount derivation.

## Donors & contacts

- `organizations` — **all external entities** (grant-makers AND everything
  else); `issues_grants` distinguishes grant-makers; `type` is the unified
  `entity_type` enum. Carries grant-maker cultivation fields (capacity rating,
  enthusiasm, connection status, strategic alignment, interests arrays,
  `historical_names`), self-referencing parent, `owner_user_id`, and an
  `anonymous` flag (UI-only name masking). There is no separate `funders`
  table — that split was consolidated here.
- `people` — individuals (donors, advisors, staff contacts); `anonymous`
  flag; `newsletter` / `unsubscribed_to_newsletter` drive Flodesk eligibility.
- `households` — joint-account donors (name + `active`).
- `people_entity_roles` — polymorphic join: a person plays a role in exactly
  one of organization / payment_intermediary / household, with `connection`,
  `people_role_current`, and a conventionally-singular `primary_contact`
  boolean (not DB-enforced).
- `payment_intermediaries` — DAFs, giving platforms, private wealth managers.
  `donor_payment_intermediaries` joins a donor (donor-XOR at the join level)
  to an intermediary it gives *through*.
- `emails`, `phone_numbers`, `addresses` — each row owned by exactly one of
  person / organization / payment_intermediary / household (CHECK
  `num_nonnulls(...) = 1`, CASCADE on owner delete). `emails` is globally
  unique on `lower(email)` (API returns 409 on collision).

## Internal dimensions

- `entities` — internal fund entities money is booked against (slug PK; new
  entities addable through the UI). `expects_payment = false` entities mark
  off-books money (see gifts below).
- `fiscal_years` — July 1 – June 30 fiscal years, slug PK (e.g. `fy2024`)
  plus a `future` sentinel. Allocation `grant_year` FKs point here; the
  table's own `goal_amount` is legacy/unused.
- `fiscal_year_entity_goals` — per-track fundraising goals; **PK is
  `(fiscal_year_id, entity_id, loan_or_grant)`** so the grant and loan tracks
  carry separate goals.
- `fundable_projects` — slug-PK projects referenced by allocations when
  `intended_usage = 'project'`; the FK is optional even for project usage.
- `schools` — mirrored one-way from the Schools Airtable base (Airtable
  record IDs are the PKs); `ages_planes text[]` is GIN-indexed. FKs to
  schools: `gift_allocations.school_recipient_id` **and**
  `pledge_allocations.school_recipient_id` (both RESTRICT).
- `charters` — charter legal recipients, referenced by
  `gift_allocations.charter_recipient_id`.
- `regions` — geographic regions with a self-referencing parent and a
  human-readable slug PK built from the ancestor chain; `display_path` is a
  denormalized full path for display.
- `fundraising_campaigns` — slug-PK campaign records;
  `gifts_and_payments.campaign_slug` FKs here (ON UPDATE CASCADE).
- `users` — Clerk-provisioned app users; `role` includes `admin` (gates
  show-archived, restore, admin screens).

## Fundraising pipeline

- `opportunities_and_pledges` — one header row spans the opportunity → pledge
  lifecycle. Lifecycle facts: derived `status` (see invariants above),
  user-set `loss_type`, sticky `written_pledge` (latched true on grant-letter
  upload or explicit user set; never auto-cleared), `stage` (pure cultivation
  funnel — a WON row reads `complete`; three legacy commitment values remain
  in the pg enum but are no longer written), `disbursement_model`
  (`fixed_commitment` default / `cost_reimbursement`), `award_closed_at` +
  `award_close_reason` (finance-permitted close of a cost-reimbursement
  award), `loan_or_grant`, `conditional`/`conditions_met` header columns
  (write-deprecated — the live rollup derives from pledge allocations),
  write-off self-links (`is_write_off`, `write_off_of_pledge_id`), and
  `match_id` (matching-gift self-reference). The close-transition rule
  (newly-closed rows must carry `actual_completion_date`) is enforced at the
  API layer (`validateOppCloseTransition`), not by a DB CHECK — do not
  reinstate the blind CHECK; legacy closed rows without dates must stay
  editable.
- `pledge_allocations` — planned/committed line items: entity, `grant_year`,
  `region_ids text[]`, intended usage, optional school/fundable-project FKs,
  the three restriction axes, per-allocation grant conditions (`conditional`,
  `conditions_met` — the header exposes a derived read-only rollup that
  drives win-probability weighting), `reimbursement_type`
  (`direct`-tagged lines are excluded from goal analytics), and `status`
  (`working` / `committed` / `committed_with_conditions` / `abandoned`; the
  superseded values remain in the pg enum but are rejected by the API).
  `expected_payment_date` is **`@deprecated`** — do not add readers or
  writers; installment scheduling lives on `pledge_expected_payments`.
- `pledge_expected_payments` — installment schedule for fixed-commitment
  pledges: `expected_date` (NOT NULL), nullable `amount`, notes. The sole
  authority for overdue detection and cash forecasting on fixed commitments.
  Cash-timing only — no scope; scope stays on `pledge_allocations`.
  Cost-reimbursement pledges normally have no rows here (their allocation
  plan is the forecast).

## Received money

- `gifts_and_payments` — header-only gift/payment records. `opportunity_id`
  links a payment to the opportunity/pledge it pays (generic — its presence
  is what distinguishes a pledge payment from a one-off gift). **There is no
  stored `type` column**: gift type is fully derived at read time
  (`deriveGiftTypeExpr`: loan_fund_investment > matching_gift > directed_gift
  > reimbursement > pledge_payment > standard_gift). `loan_or_grant` is
  stored directly and is the sole loan authority. The human-entered `amount`
  is the authoritative donor credit; settled amounts, QB-tie status, and
  off-books-ness are all **derived at read time** (`giftPaymentSummary.ts` /
  `derivedStatus.ts`) from the counted `payment_applications` ledger and the
  allocation entities — a gift is off-books when every allocation sits on a
  no-payment entity. **Never reintroduce gift-pointer or stored-status
  columns here.** Other facts: `date_received` (canonical "money arrived"
  date), `payment_method`, donor XOR FKs, `payment_intermediary_id`,
  matching-gift self-link (`gift_being_matched_id`), audit-close overpay
  self-link (`overpay_of_gift_id`, at most one active per original),
  `awaiting_settlement` (suppresses premature missing-QB flags), thank-you
  and grant-letter/acknowledgement file fields.
- `gift_allocations` — actual received-money line items: entity,
  `grant_year`, regions, intended usage, school/charter recipient FKs, the
  three restriction axes, `counts_toward_goal` (the sole home of the
  goal-counting signal), `reimbursement_type`, `seed_fund`,
  `school_support_type`, per-axis designation-type columns (provenance of who
  chose each scope dimension; the legacy restriction axes stay authoritative
  for revenue coding until a planned consolidation), and plan-vs-actual
  provenance (`source_pledge_allocation_id`, `variance_reason`).
  `display_usage` is a **trigger-maintained, read-only** label — never write
  it directly.

### Restriction taxonomy (three axes)

Both allocation tables carry three independent axes —
`regional_restriction_type`, `other_restriction_type` (restrictions beyond
region/time/school/project), `time_restriction_type` — each a
`restriction_axis` enum (`donor_restricted` / `wf_restricted` /
`unrestricted`), NOT NULL default `unrestricted`. A line codes as *restricted*
(4100.x) when **any** axis is `donor_restricted`; `wf_restricted` and
`unrestricted` both code unrestricted (4000.x). Two free-text companions:
`restriction_description` (plain-language summary) and `purpose_verbatim`
(**exact source language only** — grant letter, Donorbox designation, check
memo).

### loan_or_grant

`loan_or_grant` (`loan` / `grant`, NOT NULL default `grant`) is the **single
source of truth** for loan-fund principal vs ordinary fundraising money; the
two tracks report in parallel and never mix in analytics. Stored directly on
`gifts_and_payments`, `opportunities_and_pledges`, and
`fiscal_year_entity_goals` (part of its PK). **`grant` means all non-loan
money** — individual donations, foundation grants, earned revenue — not
literally only grants. The legacy `fundraising_category` model is retired and
must not be revived.

### Revenue-accounting coding capture

Revenue coding is **derived on demand** from allocation scope
(`deriveRevenueCoding` in `@workspace/api-zod`, with per-fund-entity overrides
in `entity_coding_rules`), never persisted on allocation rows. The reviewer
captures the resolved snapshot onto the matching `staged_payments` row
(object code / revenue location / revenue class + overrides, `coding_flags`,
`deferred_revenue` + reason — describing the QuickBooks *payment*, not donor
intent). `revenue_accounts` holds the GL account list.

### Many-to-many via slug arrays

Multi-value links (regions on allocations, org interests, historical names)
are `text[]` columns of slug-PK references, not junction tables; each carries
a GIN index. Query with array operators (`@>`, `&&`, `<@`), **never**
`= ANY(...)` (seq scan) and never `ANY(${jsArray}::text[])` in a Drizzle
`sql` template (runtime cast error — use `inArray()` or Drizzle's
`arrayContains` / `arrayOverlaps` / `arrayContained`).

## Payment evidence & reconciliation

- `quickbooks_connections` — per-realm OAuth tokens (encrypted at rest) +
  sync watermark. Pull-only: the CRM never writes to QuickBooks.
- `staged_payments` — the QB review queue. Incoming-money units idempotent on
  `(realmId, qbEntityType, qbEntityId, qbLineId)` (deposits stage per line).
  `qb_entity_type = 'deposit_header'` is the whole-deposit exception: a bank
  Deposit whose every line re-records an already-ingested Payment/SalesReceipt
  stages ONE header row (`qbLineId = ''`, null payer fields, aggregated
  `qb_linked_txn` provenance) so the deposit is visible to settlement matching
  without double-counting money already on the Payment rows. A header derives
  status `excluded` by entity type alone (confirmed settlement evidence still
  wins → `match_confirmed`); it can never anchor a ledger row, mint a gift, or
  be split. The sync keeps the representation exclusive both ways: staging
  direct lines deletes a now-superfluous header, and staging a header deletes
  now-stale direct-line rows — in both directions only unreferenced (no
  settlement link / source link / ledger row) and, for line rows, still-open
  (`pending`/`excluded`) rows are removed.
  Status / exclusion-reason / match-status enums; classification and entity
  attribution each carry an `auto` vs `manual` source (a manual pin survives
  re-sync). Candidate donor FKs are all nullable (XOR enforced only at
  approve/reconcile). Also carries the captured revenue-coding snapshot.
- `quickbooks_handling_rules` — admin-editable ingest rules
  (`exclude` / `auto_create_approve`); seed rules must mirror the code
  classifier.
- `stripe_payouts` / `stripe_staged_charges` / `stripe_sync_state` — payout
  lumps, per-charge gross records, and the sync watermark. Stripe↔QB
  reconciliation ties a QB deposit lump to its charges; the coarse QB-derived
  gift is archived and the QB row excluded (`processor_payout`, set only on
  human confirm) so money isn't booked twice.
- `donorbox_donations` / `donorbox_sync_state` — Donorbox donor/purpose
  evidence (not transaction evidence).
- `bank_transactions` — raw bank-register evidence, one row per register line,
  tagged by `source` (`qbo_register_export` today; `plaid` reserved). Loaded by
  the scripts importer (`import:bank-register`) from the overlapping historical
  QBO register XLS exports, merged + deduplicated (`dedup_key` = raw register
  field values; `occurrence` disambiguates legitimate intra-file repeats — the
  max count seen in any single file; unique on source+key+occurrence makes
  re-imports idempotent). Read-only after import; never mints gifts, never
  anchors `payment_applications` rows, and carries NO foreign keys — any
  cross-evidence tie goes through the `source_links` ledger (implemented).
- `bank_deposits` — **the SPINE of the bank-anchored money model**
  (docs/adr-bank-spine-money-model.md). One row per real bank credit. Today a
  curated PROJECTION of a deposit-type `bank_transactions` row
  (`source='qbo_register_export'`, `deposit > 0`) — QBO's mirror of the bank
  feed — recorded by `source_bank_transaction_id` (UNIQUE, so the projection is
  1:1/idempotent). Repopulated from a bank-native feed (`plaid`) or `manual`
  entry later WITHOUT schema change. A Stripe payout settles as one bank deposit
  (`stripe_payouts.bank_deposit_id`, Phase 4); a check deposit is composed of
  check `payment_units` via `bank_deposit_components` (Phase 3). Composition
  state (unresolved/partial/complete/overallocated) is DERIVED, never stored.
- `payment_applications` — the unit↔gift cash-application ledger. Each row
  anchors on exactly one evidence unit per `evidence_source` (`quickbooks` →
  `payment_id`, `stripe` → `stripe_charge_id`, `donorbox` →
  `donorbox_donation_id`; enforced by per-source CHECKs). `link_role`
  (`counted` / `corroborating`) — money reads SUM only `counted` rows;
  `amount_applied` must be > 0 on counted rows. Book-once is enforced by
  **partial unique indexes per evidence anchor** — one counted unique and one
  corroborating unique per anchor kind (payment / stripe charge / donorbox
  donation × gift) — plus the service helper's transactional row-lock and
  per-anchor SUM validation. Both the unit and gift FKs are RESTRICT.
  `created_the_gift` preserves the mint-ownership signal.
- `settlement_links` — one row ties a Stripe payout to its QB deposit lump
  (no donor, no amount split); exclusive per payout (deterministic
  `sl_<payout_id>` PK + UNIQUE). The payout's settlement status is a pure
  derivation over this table.
- `source_links` — unit↔unit evidence claims (`charge_qb_tie`,
  `charge_fee_row`, `donorbox_qb`, `donorbox_charge`) with deterministic ids
  and lifecycle. Sole authority for evidence↔evidence ties; a claim blocks
  re-picking but is never itself status evidence.
- `reconciliation_bundle_drafts`, `unit_groups` — workbench working state. (`unit_groups` is deprecated: new group creation is retired — multi-match writes N counted `payment_applications` rows instead — and the table is slated for retirement per `docs/adr-linear-money-model.md` §7 step 3; it persists only for legacy groups.)

## Communications & workflow

- `google_oauth_tokens`, `email_messages` (one row per mailbox per Gmail
  message, de-duplicated in the list endpoint), `email_attachments`,
  `tracked_emails` — Gmail sync + open tracking.
- `email_sync_state` / `calendar_sync_state` — cursors; `no_progress_runs`
  flags a stuck mailbox. `email_sync_skip`, `correspondent_ignore`,
  `person_suppression_windows`, `calendar_meeting_filters` — suppression and
  matching controls. `internal_email_domains` — staff-domain singleton.
- `calendar_events`, `interactions` (manual touches), `meeting_notes`,
  `notes`.
- `email_proposals` — one actionable AI signal per row (job change, bounce,
  signature update, grant opportunity, thank-you acknowledgment, …).
- `email_intel_prompts` — versioned, admin-editable review prompts per
  (`signal_type`, `review_phase`); partial uniques enforce at most one
  `active` and one `draft` per pair. The action-proposing core prompt is
  hard-coded in the API server and never stored or exposed here.
- `grant_leads` — team-shared grant-opportunity queue extracted from email.
- `tasks`, `task_proposals`, `task_suggestion_state` — tasks and AI
  next-step suggestions.
- `media_mentions`, `media_ingest_state` — GDELT press coverage.
- `saved_views`, `bulk_operations`, `connection_enthusiasm_history`,
  `flodesk_sync_state`, `audit_log`, `cleanup_queue`, `duplicate_dismissals`,
  `coding_form_rows`, `wildflower_updates` — app plumbing and operational
  state.

## Anonymous records

The `anonymous` flag on `organizations` and `people` masks the name to
"Anonymous" in the UI for everyone except the record owner and admins.
**UI-only** — names are still present in API responses. Keep `canSeeIdentity`
(display) separate from `canManageIdentity` (toggle).

## Deeper references

- Reconciliation business rules: [`docs/workbench-business-rules.md`](../../docs/workbench-business-rules.md)
- Reconciliation target design: [`docs/reconciliation-design.md`](../../docs/reconciliation-design.md)
- Reconciliation implementation status: [`docs/reconciliation-status.md`](../../docs/reconciliation-status.md)
- Evidence↔evidence ledger ADR: [`docs/adr-source-link-ledger.md`](../../docs/adr-source-link-ledger.md)
- Data provenance and sync procedures: [`docs/integrations/data-sources.md`](../../docs/integrations/data-sources.md)
- Routine schema changes: [`docs/change-recipes.md`](../../docs/change-recipes.md)
