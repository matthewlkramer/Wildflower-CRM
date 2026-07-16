# Memory-file audit and recommendations

## Audit scope

This report treats the supplied memory set as a **single current snapshot**, not as a comparison with an earlier audit:

- 193 unchanged Markdown files from `memory.zip`
- five replacement copies of files from that archive:
  - `MEMORY.md`
  - `money-sync-reconciliation.md`
  - `reconciliation-terminal-charge-queue-pin.md`
  - `reconciliation-corroborating-link-role.md`
  - `reconciliation-settlement-only-confirm.md`
- one additional project-level file: `replit.md`

That produces **199 effective files**. The superseded copies of the five replaced files are excluded from the recommendations below.

This is a memory-architecture audit, not a line-by-line verification of every factual claim against the current repository or production database. I made semantic recommendations where I have enough context—especially reconciliation, finance, gifts and pledges, and the repository’s migration and tooling patterns—and marked files as skipped where I have not explored the subsystem deeply enough.

## Executive findings

1. **The root authority structure is workable but should be made more explicit.** `replit.md` is the natural project canon, `MEMORY.md` should remain a compact router, grouped domain indexes should describe current behavior, ADRs should define target architecture, and incident or migration files should never be treated as current implementation guidance.
2. **The reconciliation memory has a coherent target but still mixes current and future authority.** The intended model has `payment_applications`, `settlement_links`, and future `source_links`; the documentation must state precisely which relationships are authoritative today and which become authoritative only after cutover.
3. **The active reconciliation index should not normalize transitional debt.** Stripe and Donorbox pointer fields, note-prefix supersession provenance, and cached `quickbooks_tie_status` may still exist, but they should be clearly marked transitional, frozen against new consumers, and tied to concrete retirement plans.
4. **Derived work-state logic should be centralized and tested as an invariant.** Status, open-charge work, queue eligibility, and blocking reasons should come from shared builders or services with SQL-executing parity tests, rather than being repeated in workbench, graph, picker, and bundle queries.
5. **Several files are valuable regression contracts rather than architecture documents.** Terminal-charge queue behavior, settlement-only confirmation, donor crossing, and SQL/Drizzle failures should live under a clear regression or incident authority level and point to the test that enforces the lesson.
6. **Tooling memories should be consolidated.** Deployment and schema drift, Drizzle SQL pitfalls, validation and test hygiene, generated API/Orval behavior, and Replit operations each have enough files to justify one canonical guide plus small linked incidents.
7. **Memory metadata would reduce accidental reversions.** Active files should identify their status and authority—such as `current`, `transitional`, `legacy`, `canonical`, `runbook`, or `incident`—and include `last_verified`, `supersedes`, and `superseded_by` where relevant.

## Proposed memory structure

```text
replit.md                           # project entry point: invariants, stack, commands, feature map
memory/
  MEMORY.md                         # compact router to grouped indexes
  current/
    architecture.md
    money-reconciliation.md
    gifts-pledges.md
    organizations-people.md
    email-calendar.md
    ui-conventions.md
  decisions/                        # product/architecture ADR summaries
  runbooks/                         # deployment, backfills, source sync, testing
  incidents/                        # named failures + regression-test links
  legacy/                           # retired models and completed phase docs
```

Every active file should include: `status: current|transitional|legacy`, `authority: canonical|supporting|runbook`, `last_verified`, `supersedes`, and `superseded_by`.

## Action counts

- **ARCHIVE / CLARIFY:** 1
- **ARCHIVE / EXTRACT CURRENT STATE:** 1
- **ARCHIVE / MERGE:** 1
- **ARCHIVE / REPLACE:** 2
- **ARCHIVE / REWRITE:** 1
- **ARCHIVE AS INCIDENT/BACKFILL:** 1
- **ARCHIVE AS LEGACY:** 3
- **ARCHIVE AS MIGRATION HISTORY:** 2
- **ARCHIVE AS SUPERSEDED:** 1
- **ARCHIVE MIGRATION HISTORY:** 2
- **ARCHIVE ROLLOUT HISTORY:** 1
- **KEEP:** 18
- **KEEP / ADD INVENTORY TEST:** 1
- **KEEP / CENTRALIZE:** 9
- **KEEP / CLARIFY:** 3
- **KEEP / COMPONENTIZE:** 2
- **KEEP / CURRENT-STATE ONLY:** 2
- **KEEP / ENFORCE DB+API:** 1
- **KEEP / FIX SYSTEMICALLY:** 1
- **KEEP / HARDEN:** 2
- **KEEP / LINK:** 1
- **KEEP / MARK TRANSITIONAL PROVENANCE:** 1
- **KEEP / MERGE:** 4
- **KEEP / MOVE TO APP MAP:** 1
- **KEEP / REDUCE:** 1
- **KEEP / RENAME:** 3
- **KEEP / REVIEW PERIODICALLY:** 1
- **KEEP / SIMPLIFY:** 1
- **KEEP / SPLIT:** 5
- **KEEP / STRENGTHEN:** 1
- **KEEP / TEMPLATE:** 1
- **KEEP / TEST:** 2
- **KEEP / TEST CONTRACT:** 2
- **KEEP / TRIM:** 1
- **KEEP / UI FOLLOW-UP:** 1
- **KEEP / UPDATE:** 2
- **KEEP / VERIFY:** 3
- **KEEP AS CANONICAL:** 1
- **KEEP AS CANONICAL / CLARIFY CURRENT VS TARGET:** 1
- **KEEP AS CANONICAL / MERGE:** 1
- **KEEP AS DEPLOY CANON:** 1
- **KEEP AS EMERGENCY RUNBOOK:** 1
- **KEEP AS HIGH-RISK RUNBOOK:** 1
- **KEEP AS INGEST RUNBOOK:** 1
- **KEEP AS INTEGRATION RUNBOOK:** 1
- **KEEP AS MOCKUP RUNBOOK:** 1
- **KEEP AS OPERATIONS:** 2
- **KEEP AS PRODUCT RULE:** 1
- **KEEP AS PROJECT CANON / UPDATE:** 1
- **KEEP AS REGRESSION CONTRACT:** 2
- **KEEP AS REGRESSION CONTRACT / CENTRALIZE PREDICATE:** 1
- **KEEP AS REGRESSION CONTRACT / RENAME:** 1
- **KEEP AS ROUTER / REDUCE:** 1
- **KEEP AS RUNBOOK:** 1
- **KEEP AS TEST RUNBOOK:** 1
- **KEEP AS UI PATTERN:** 2
- **KEEP AS VALIDATION CANON:** 1
- **KEEP USER-SPECIFIC:** 1
- **MERGE:** 5
- **MERGE / COMPONENTIZE:** 1
- **MERGE / KEEP DETAIL:** 1
- **MERGE / RUNBOOK:** 1
- **MERGE / TEST CONTRACT:** 1
- **MERGE / TRANSITIONAL:** 1
- **MERGE INTO API ROUTE PITFALLS:** 2
- **MERGE INTO CANON:** 1
- **MERGE INTO DEPLOY CANON:** 1
- **MERGE INTO DEPLOY RUNBOOK:** 1
- **MERGE INTO DRIZZLE PITFALLS:** 5
- **MERGE INTO DRIZZLE/DEPLOY PITFALLS:** 1
- **MERGE INTO MIGRATION RUNBOOK:** 3
- **MERGE INTO ORVAL GUIDE:** 3
- **MERGE INTO TEST-DATA HYGIENE:** 3
- **MERGE INTO TOOLING RUNBOOK:** 4
- **MOVE TO INCIDENTS:** 2
- **MOVE TO INCIDENTS / REGRESSION:** 2
- **MOVE TO INCIDENTS / RUNBOOK:** 1
- **MOVE TO OPERATIONS:** 2
- **MOVE TO RUNBOOK:** 5
- **MOVE TO RUNBOOK / ARCHIVE:** 1
- **MOVE TO RUNBOOK / ARCHIVE AFTER RUN:** 1
- **RENAME / KEEP:** 1
- **REWRITE:** 5
- **REWRITE / MERGE:** 1
- **REWRITE / SECURITY REVIEW:** 1
- **REWRITE / VERIFY:** 1
- **REWRITE NOW:** 9
- **SKIP — NOT ENOUGH DOMAIN CONTEXT:** 18
- **SPLIT / REWRITE:** 1
- **TRANSITIONAL / REWRITE:** 4

## Per-file recommendations

### Core indexes & architecture

| File | Recommendation | Suggested change |
|---|---|---|
| `MEMORY.md` | **KEEP AS ROUTER / REDUCE** | This is a useful pointer index and clearly separates legacy reconciliation. Reduce it further by routing Drizzle, Orval, deployment, test-data, and money leaf topics through grouped indexes rather than listing every implementation lesson at root. |
| `replit.md` | **KEEP AS PROJECT CANON / UPDATE** | Strong project-level entry point. Align the Stripe/reconciliation feature summary with the three-link-table target; qualify `pnpm --filter @workspace/db run push` with the dev-drift safety rules; keep detailed charge-tie and builder mechanics in the money index; add authority and last-verified metadata. |
| `architecture-canon.md` | **KEEP / STRENGTHEN** | Keep as the authority ladder. Add explicit precedence: schema/migrations > ADRs > current-state memory > runbooks > incidents, plus a last-verified date and links to the source-link ADR. |
| `email-calendar-sync.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `money-sync-reconciliation.md` | **KEEP AS CANONICAL / CLARIFY CURRENT VS TARGET** | This file appropriately separates QB pointer-era material and states the three-link-table design. Split the opening into “authority today” and “target after source_links cutover”: `source_links` is not yet shipped, while Stripe and Donorbox gift pointers remain live despite PA dual-write. |
| `recon-three-facet-model.md` | **KEEP / SPLIT** | Keep the ratified product vocabulary and Grain C workbench direction. Split implemented behavior from aspirational design, and remove backend claims such as “maps onto the shipped ledger” unless verified. |
| `reconciliation-single-source-of-truth.md` | **REWRITE NOW** | Preserve “CRM gifts are the only gifts,” but replace one-ledger terminology. Explicitly distinguish source equivalence, gift application, proposal, donor attribution, and derived work state. |
| `reconciliation-target-design.md` | **REWRITE NOW** | Update the target from “two-plane/one-ledger” to two authoritative relationship stores: source_links for evidence↔evidence and payment_applications for money→gift. State whether settlement_links is folded into source_links or remains its typed specialization. |
| `reconciliation-two-lane-model.md` | **KEEP / CLARIFY** | Keep the independent funding and CRM-record lanes. Clarify that these are UI/work-state projections, not additional authorities, and name the exact canonical facts used to derive each lane. |

### Reconciliation, QuickBooks, Stripe & Donorbox

| File | Recommendation | Suggested change |
|---|---|---|
| `cards-resolved-gift-fy-wrong-table.md` | **MOVE TO INCIDENTS** | Keep the diagnosis and regression-test lesson, but remove obsolete matched/created pointer examples. It should not appear as active architecture. |
| `charge-fee-row-link.md` | **TRANSITIONAL / REWRITE** | Model fee-row linkage as a typed source_link rather than a Stripe-column pointer. Keep the gross/net matching and race constraints as relationship-type rules. |
| `charge-grain-qb-ties.md` | **TRANSITIONAL / REWRITE** | Document this as the current pointer-backed implementation plus an explicit sunset. Proposed and confirmed charge↔QB ties should migrate to source_links lifecycle rows. |
| `charge-tie-dismissals.md` | **TRANSITIONAL / REWRITE** | Pair-level dismissal is sound, but text[] on the charge is another source-specific proposal store. Move dismissals into normalized source-link proposals or a proposal-decision table. |
| `charge-tie-supersede.md` | **REWRITE NOW** | Replace note-prefix ownership with structured provenance tied to a source-link ID. Keep the evidence-vs-claim distinction and parity tests; mark pointer-triggered behavior as transitional. |
| `donorbox-api-integration.md` | **KEEP AS INTEGRATION RUNBOOK** | Keep API/auth/source identifiers. Separate credentials and operational notes from money-model authority. |
| `donorbox-sync-model.md` | **REWRITE / VERIFY** | Keep Stripe-enrich-only versus PayPal-new-money distinction. Replace stored status and per-source QB pointers with source_links/proposals and payment_applications. |
| `lifecycle-rename-reconciliation.md` | **MOVE TO RUNBOOK / ARCHIVE** | Useful rename-recovery procedure, but specific past migration ordering should be archived after extracting the generic guarded-rename pattern. |
| `payment-applications-ledger.md` | **REWRITE NOW** | Remove phased-rollout and legacy-pointer history from the active version. Define the final ledger contract, cardinality, lifecycle, counted semantics, splitability, mutation service, and how supersession provenance will reference source_links. |
| `quickbooks-clean-reingest.md` | **ARCHIVE / MERGE** | Prefer the non-destructive full re-pull as the current operational path. Keep destructive wipe/reset only as an emergency runbook with stronger warnings. |
| `quickbooks-daf-sponsor-attribution.md` | **KEEP** | The soft-warning/no-auto-rewrite decision is appropriately conservative. Link it to payment-intermediary attribution rules. |
| `quickbooks-deleted-item-income-account.md` | **KEEP AS INGEST RUNBOOK** | Useful source-system edge case; keep out of reconciliation architecture. |
| `quickbooks-deposit-coding-preserve.md` | **KEEP** | A strong ingest invariant: source refreshes must not erase reviewed coding with missing incremental data. Add a field-level provenance policy if not already explicit. |
| `quickbooks-deposit-grouping.md` | **REWRITE NOW** | Replace matched/group-reconciled pointers and source_group_id with unit_groups/unit_group_members plus payment_applications. Preserve deposit/date grouping rules separately. |
| `quickbooks-deposit-memo-wrong-donor.md` | **MOVE TO INCIDENTS / REGRESSION** | Preserve as a regression scenario and product warning, not active matching authority. The payer label should clearly distinguish QBO memo from processor identity. |
| `quickbooks-donor-rematch-backfill.md` | **MOVE TO RUNBOOK** | Keep the safe donor-only rematch procedure as an admin runbook, not a core architecture rule. |
| `quickbooks-editable-rules.md` | **KEEP / HARDEN** | Keep the DB-editable rule model and seed fidelity test. Make rule actions call canonical gift/application services rather than implementing reconciliation themselves. |
| `quickbooks-exclusion-rules.md` | **KEEP / MERGE** | Keep the classifier taxonomy and fidelity invariant. Merge queue behavior from quickbooks-staged-exclude.md and centralize enums/backfill generation. |
| `quickbooks-feeband-reconcile.md` | **KEEP / MERGE** | Keep the known-net and fee-band rules, but make giftMatch.ts the only implementation. Merge with reconciliation-net-aware-feeband.md. |
| `quickbooks-fiscally-sponsored-exclusion.md` | **RENAME / KEEP** | Rename to quickbooks-entity-attribution.md so the retired exclusion is not the headline. Keep only the current attribution behavior; move historical rationale to a note. |
| `quickbooks-intermediary-donor-seed.md` | **KEEP / VERIFY** | Keep as candidate-generation guidance only; confirmation must remain human/ledger authoritative. |
| `quickbooks-linkedtxn-provenance.md` | **KEEP** | Keep the source-fact interpretation and read-only derivation. Clarify how LinkedTxn becomes evidence for a source_link proposal rather than a stored pointer. |
| `quickbooks-matching-gifts.md` | **KEEP** | The warning against donor+amount+date dedupe is durable. Link it to source_links as the future same-money authority. |
| `quickbooks-nondestructive-repull.md` | **KEEP / MERGE** | Make this the canonical full-resync doc and merge quickbooks-resync-background.md into it. |
| `quickbooks-payment-sync.md` | **KEEP / TRIM** | Keep source direction, idempotency, OAuth environment rules, and worker boundaries. Remove obsolete approve/link implementation details and link to canonical mutation docs. |
| `quickbooks-reconcile-donor-adoption.md` | **KEEP / CLARIFY** | Keep explicit human adoption of the gift donor. Ensure it cannot silently overwrite a confirmed source donor without audit history. |
| `quickbooks-reconciler-ui-model.md` | **KEEP / UPDATE** | Keep the donor-selection placement and manual-only exclusion reasons if still desired. Reframe around the new Grain C workbench and derived-status vocabulary. |
| `quickbooks-resync-background.md` | **MERGE** | Merge into quickbooks-nondestructive-repull.md; background execution is an implementation detail of the same workflow. |
| `quickbooks-staged-exclude.md` | **MERGE** | Merge into quickbooks-exclusion-rules.md; it is the UI/queue consequence of the same exclusion model. |
| `quickbooks-staged-link.md` | **ARCHIVE / REWRITE** | Distinct matched/created columns are retired. Replace with one concise ledger-only staged-payment→gift invariant; archive the pointer-era file. |
| `quickbooks-staged-resolution-races.md` | **REWRITE** | Keep transactional compare-and-set race safety, but guard on current facts/version rather than stored status=pending. Route all transitions through shared mutation services. |
| `quickbooks-worker-no-mint.md` | **KEEP** | This is a useful durable boundary. Update any legacy linkage terminology and make the rule enforceable by service/API separation. |
| `raw-sql-pa-insert-guards.md` | **REWRITE NOW** | Remove matched_gift_id guards. Data migrations should guard on canonical source-link/application facts and abort on ambiguous ownership. |
| `reconciler-approvable-statuses.md` | **ARCHIVE AS LEGACY** | The three gift-link columns and stored-status framing are obsolete. Replace with a fact-based approvability rule in the derived-status/gate docs. |
| `reconciler-card-readiness-pool.md` | **KEEP / CENTRALIZE** | Keep the readiness concept, but derive it from the same canonical candidate/gate functions used by search and confirm. Avoid a cards-only pool becoming a fourth matcher. |
| `reconciliation-already-linked-picker.md` | **REWRITE NOW** | Replace COALESCE over dropped gift pointers with ledger/source-link ownership. Keep the UX rule that blocked candidates are visible with reasons. |
| `reconciliation-approve-outcomes.md` | **REWRITE NOW** | Remove QB/Stripe pointer asymmetry and define outcomes in terms of source links, payment applications, gift creation, and provenance. One service should own the full write-set. |
| `reconciliation-bundle-confirm-invalidation.md` | **KEEP / REDUCE** | Keep as a cache-invalidation contract, but list query-key families rather than specific UI queues where possible; test invalidation from a shared helper. |
| `reconciliation-bundle-queue.md` | **TRANSITIONAL / REWRITE** | The queue may stay, but remove pointer-specific axes and express scope using source links and derived cluster state. Confirm whether this survives the Grain C workbench. |
| `reconciliation-card-queue-enum.md` | **KEEP / MERGE** | Merge with the workbench queue contract. Prefer one OpenAPI queue/lens vocabulary and avoid separate almost-identical enums. |
| `reconciliation-confirmed-relink.md` | **REWRITE NOW** | Remove legacy fallback and stored-status language. Define relink eligibility from application provenance and immutable mint/group constraints. |
| `reconciliation-conflict-approved-per-track.md` | **REWRITE / MERGE** | Fold into the source-link lifecycle and workbench cluster-state spec. The legacy conflict_approved label should not survive as a quasi-status. |
| `reconciliation-conflict-keep-gate.md` | **REWRITE** | Keep the double-book safety rule, but express ownership through confirmed source links and counted applications rather than legacy gift pointers. |
| `reconciliation-corroborating-link-role.md` | **KEEP / MARK TRANSITIONAL PROVENANCE** | This file accurately documents NULL audit annotations and non-NULL supersede-demoted rows. Add an explicit technical-debt box: the `charge_tie_supersede:<qbId>` note prefix is executable state and must be replaced by structured provenance linked to the future source relationship. |
| `reconciliation-crosscheck-prod-verification.md` | **MOVE TO RUNBOOK** | Useful operational knowledge, but keep it in a categorized runbook/incident index rather than the active architecture memory. |
| `reconciliation-derived-status.md` | **KEEP / HARDEN** | Keep as canonical. Document the alias-safe builders, SQL/TypeScript parity tests, and the rule that source ties alone never create match_confirmed; only booked evidence does. |
| `reconciliation-gate-vs-blockers.md` | **KEEP** | Good boundary: the server gate is authoritative and the client renders returned issues. Add a typed issue contract and forbid independent client blocker logic. |
| `reconciliation-gift-search-modes.md` | **KEEP** | The separate 1:1 and split windows are a useful durable rule. Link to the single giftMatch implementation and parity tests. |
| `reconciliation-matched-column-readonly.md` | **KEEP / RENAME** | Rename around the Completed lens rather than a legacy Matched column. Read-only completed records is sound; gate by lens/context plus server authority. |
| `reconciliation-move-own-application.md` | **REWRITE** | Keep the move-own-application primitive, but eliminate matchedGiftId comparisons and ensure it also refreshes derived source-link/workbench state centrally. |
| `reconciliation-multicharge-link-gift.md` | **KEEP / SIMPLIFY** | Keep the per-charge decision grain, but route it through the same confirmMoneyApplication primitive as every other entry point; the dedicated endpoint should not own unique semantics. |
| `reconciliation-needs-review-derivation.md` | **REWRITE** | Remove reliance on legacy payout status. Derive actionable work from open charge/application/source-link facts using the canonical builders. |
| `reconciliation-net-aware-feeband.md` | **MERGE** | Merge into gift-match-band-policy.md or quickbooks-feeband-reconcile.md so there is one amount-window specification. |
| `reconciliation-parallel-evidence-doublebook.md` | **KEEP / CENTRALIZE** | The anchor-kind distinction is fundamental. Move the rule into one canonical ownership/capacity service and test all search/derive/confirm paths against it. |
| `reconciliation-percharge-routing-all-paths.md` | **KEEP AS REGRESSION CONTRACT** | This is a useful invariant. Convert it into an integration-test matrix and shorten the memory to the invariant plus test location. |
| `reconciliation-phase-status-source.md` | **ARCHIVE / REPLACE** | Phase tracking should no longer be active memory. Replace with a concise current migration-state file if needed. |
| `reconciliation-phase3-group-read-flip.md` | **ARCHIVE AS MIGRATION HISTORY** | The flip is complete. Preserve only in migration history; current grouping authority belongs in unit-groups-dualwrite.md under a non-dualwrite name. |
| `reconciliation-phase6-status-read-flip.md` | **ARCHIVE AS MIGRATION HISTORY** | The status read flip is complete. Extract any still-valid constraints into reconciliation-derived-status.md. |
| `reconciliation-resolved-predicate-four-forms.md` | **ARCHIVE AS LEGACY** | This documents the retired three-pointer model. Replace active references with “a counted application or confirmed settlement/source relationship,” then archive this file. |
| `reconciliation-retarget-conflict-compose.md` | **KEEP / CENTRALIZE** | Keep multi-conflict composition, but make it a mutation-service capability rather than route-specific orchestration. Remove pointer terminology. |
| `reconciliation-search-and-confirm-gating.md` | **KEEP** | Keep the text-search and locking-confirm lessons. Replace any status wording with canonical fact predicates and route all confirms through one mutation primitive. |
| `reconciliation-settlement-only-confirm.md` | **KEEP AS REGRESSION CONTRACT / CENTRALIZE PREDICATE** | This file correctly treats settlement confirmation as Plane 1 and deposit status as derived. Replace the remaining “stamps reconciled” phrase; define unbooked charges through the shared charge-open predicate, including terminal exclusions, and link the exact integration test. |
| `reconciliation-terminal-charge-queue-pin.md` | **KEEP AS REGRESSION CONTRACT / RENAME** | This file correctly uses `exclusion_reason` and the derived `excluded` state. Rename it around “terminal charges are not open work” to avoid calling failed charges financially settled; expose one canonical open-charge predicate and test graph, bundle, lateral, and re-admit consumers against it. |
| `settlement-links-parity.md` | **KEEP / RENAME** | Rename to settlement-links-model.md. Keep its durable constraints, drop “parity” from the filename, and resolve its future relationship to source_links in the ADR. |
| `staged-payment-funding-source-grouping.md` | **SPLIT / REWRITE** | Keep funding_source as an origin/provenance rule. Move grouping to the canonical unit_groups doc and remove source_group_id and gift-pointer ownership. |
| `stripe-charge-donor-crossing.md` | **MOVE TO INCIDENTS / REGRESSION** | Keep the exact-ID/twin-amount regression, but rewrite the repair write-set for the ledger-only schema and remove real donor names/IDs from active memory. |
| `stripe-charge-evidence-linkage.md` | **ARCHIVE AS LEGACY** | It is explicitly about dropped matchedGiftId and stored reconciled status. Replace active references with counted payment_applications. |
| `stripe-failed-charge-exclusion.md` | **KEEP / CENTRALIZE** | Keep failed-charge mirroring and exclusion behavior. Move the four-site enum warning into a shared schema/inventory test so the memory can be shorter. |
| `stripe-full-repull-backfill.md` | **MERGE / RUNBOOK** | Merge with stripe-historical-restitch-trigger.md and stripe-history-csv-backfill.md into one historical Stripe recovery runbook with clearly separated API and CSV paths. |
| `stripe-historical-restitch-trigger.md` | **MERGE / TRANSITIONAL** | Merge into the historical Stripe recovery runbook; update legacy payout statuses/pointers to source-link proposals. |
| `stripe-history-csv-backfill.md` | **MOVE TO RUNBOOK** | Keep cross-environment safety and idempotency, but remove from active architecture. |
| `stripe-refund-propagation.md` | **KEEP / CENTRALIZE** | Keep propose-then-confirm and forward-only semantics. Ensure refund proposals use the normalized proposal model and all gift effects go through one mutation service. |
| `stripe-restricted-key.md` | **KEEP AS OPERATIONS** | Keep credential precedence and account-ID discovery as an operations runbook. |
| `unit-groups-dualwrite.md` | **KEEP / RENAME** | Rename to unit-groups-model.md and remove rollout history. It should be the sole current grouping authority. |
| `workbench-historical-group-backfill.md` | **ARCHIVE AS INCIDENT/BACKFILL** | Historical source_group_id repair is completed and references retired pointers. Keep the verification SQL/runbook outside active memory. |

### Gifts, pledges, opportunities & allocations

| File | Recommendation | Suggested change |
|---|---|---|
| `allocation-school-link.md` | **KEEP / UI FOLLOW-UP** | Keep the allocation-level rule. Replace raw ID entry with a real picker and unify display resolution if possible. |
| `crm-only-allocation-rows.md` | **KEEP / CLARIFY** | Keep the allocation-grain display versus gift-grain action distinction. Add an explicit UI warning that payment linkage remains gift-level and define the row roll-up behavior. |
| `forward-gift-intake.md` | **KEEP / VERIFY** | The suggest-and-confirm model is sound. Update all linkage descriptions to payment_applications only and ensure duplicate guards use canonical ledger/source-link services. |
| `fundable-projects-page.md` | **KEEP** | Current page and calculation rules are clear; add a shared rollup helper/test. |
| `funders-organizations-consolidation.md` | **ARCHIVE / REPLACE** | Extract current organization semantics and archive rollout history. |
| `fy-report-page.md` | **KEEP / TEST CONTRACT** | Keep the requirement that report rows reconcile to dashboard metrics; add a shared query/helper or parity test so it is not maintained by prose. |
| `gift-allocation-seed-invariant.md` | **KEEP** | A clear durable invariant. Consider adding a DB deferred constraint/repair audit if app-only enforcement remains intentional. |
| `gift-booking-lifecycle-audit-close.md` | **KEEP / SPLIT** | Use as the canonical accounting lifecycle, but split audit-close freeze, pledge write-offs/overpayments, and derived reconciliation state into linked focused docs. Explicitly mark which parts are implemented. |
| `gift-delete-allocations-restrict.md` | **ARCHIVE / CLARIFY** | Soft-delete is now the normal app behavior. Retain this only for exceptional hard-delete/cleanup paths and reconcile it with archive-soft-delete-boundaries.md. |
| `gift-match-band-policy.md` | **KEEP AS CANONICAL** | Use this as the sole amount/date-band authority; other files should link here without restating formulas. |
| `gift-merge-evidence-combine.md` | **REWRITE** | Keep transactional evidence transfer and collision rules, but remove dropped pointer assumptions and use canonical application/source-link movement. |
| `gift-qb-tie-status.md` | **ARCHIVE AS SUPERSEDED** | gift-booking-lifecycle-audit-close.md says the newer derived reconciliation state replaces quickbooks_tie_status. Remove this from active indexes and retain only migration/history context. |
| `gift-scope-allocation-migration.md` | **ARCHIVE / EXTRACT CURRENT STATE** | This is rollout history. Move the final allocation/header ownership rules into allocation model docs and archive migration details. |
| `gives-through-donor-pi.md` | **KEEP / CURRENT-STATE ONLY** | Keep donor XOR and intermediary relationship semantics; remove rollout/deprecated-column history from the active version. |
| `grouped-create-gift-allocations.md` | **KEEP / UPDATE** | Keep optional allocation seeding, but describe group membership through unit_groups and gift linkage through payment_applications. |
| `individual-org-soft-credit.md` | **KEEP** | Clear attribution rule; ensure analytics use one shared query implementation. |
| `loan-capital-fundraising-category.md` | **KEEP** | Use as current analytics classification authority; remove links that imply the dual-write rollout is still active. |
| `loan-or-grant-dualwrite.md` | **ARCHIVE ROLLOUT HISTORY** | The cutover is described as complete. Keep the final authoritative flag in loan-capital-fundraising-category.md and archive dual-write/parity history. |
| `opp-derivation-idempotency.md` | **MERGE / TEST CONTRACT** | Keep the fixed-point invariant as a test contract within the opportunity lifecycle canon rather than a separate active memory. |
| `opp-lifecycle-redesign.md` | **MERGE INTO CANON** | Consolidate with wildflower-opp-status-calculated.md and opp-derivation-idempotency.md into one current lifecycle specification; archive original task-plan history. |
| `pledge-expected-payment-date.md` | **KEEP** | The per-allocation date model is clear and durable. Add roll-up semantics and API/UI null behavior if not already covered. |
| `pledge-status-rederivation.md` | **MERGE** | Merge paid-amount derivation into the opportunity/pledge lifecycle canon; avoid a separate recomputation recipe that can drift. |
| `pledge-write-off-model.md` | **MERGE / KEEP DETAIL** | Link from the audit-close lifecycle doc, but keep its concurrency and capacity details in a focused accounting-policy file. |
| `reimbursable-grant-payment-model.md` | **KEEP** | The award-as-pledge and each-check-as-gift distinction is clear and consistent with reconciliation. |
| `reimbursable-share-exclusion.md` | **KEEP / LINK** | Keep as analytics policy and link it to the allocation/goal calculation canon. |
| `school-sync-recipient-fk.md` | **KEEP / SPLIT** | Keep allocation-level school ownership; move sync ordering/token details to an Airtable operations runbook. |
| `split-gift-into-pledge.md` | **KEEP / VERIFY** | Keep as a domain action specification. Ensure it uses the audit-close freeze and canonical application transfer services. |
| `wildflower-allocation-restriction-ux.md` | **KEEP / SPLIT** | Keep domain invariants separate from UI transport details. Move POST/PATCH payload quirks into an implementation note and retain one canonical restriction model. |
| `wildflower-opp-status-calculated.md` | **KEEP AS CANONICAL / MERGE** | Make this the concise current status contract and link to the detailed lifecycle/deriver tests. |
| `wildflower-weighted-projection.md` | **KEEP / TEST CONTRACT** | Keep the formula, but centralize it with the dashboard/report query and add fixture parity for partial payments. |

### Database, deployment, testing & tooling

| File | Recommendation | Suggested change |
|---|---|---|
| `api-server-http-integration-tests.md` | **KEEP / TEMPLATE** | Good testing pattern. Link to a reusable helper and require at least one real-Postgres path for raw SQL/Drizzle alias changes. |
| `api-zod-cross-env.md` | **KEEP** | Clear library boundary. Add a package-level lint/test if possible. |
| `background-process-killed.md` | **MERGE INTO TOOLING RUNBOOK** | Combine with build-verify-cpu-throttling.md and scoped-validation-checks.md. |
| `build-verify-cpu-throttling.md` | **MERGE INTO TOOLING RUNBOOK** | Keep the verified command patterns, but separate environment-specific limits from repository validation policy. |
| `clerk-admin-e2e-testing.md` | **KEEP AS TEST RUNBOOK** | Useful environment-specific test setup; keep out of product architecture. |
| `copper-notes-migration.md` | **ARCHIVE MIGRATION HISTORY** | Preserve as a migration record/template, not active memory. |
| `cross-env-db-schema-drift.md` | **KEEP AS OPERATIONS** | Keep as a deployment safety runbook. Add a standard schema-version check and prohibit ad hoc push commands. |
| `data-migration-publish-ordering.md` | **MERGE INTO MIGRATION RUNBOOK** | Keep the schema-before-data and transaction rules in one migration operations document. |
| `deploy-image-limit-zero-gib.md` | **MOVE TO INCIDENTS** | Likely transient vendor behavior; keep a short diagnostic in an operations FAQ rather than active memory. |
| `deprecated-column-drop-audit.md` | **KEEP AS RUNBOOK** | Useful physical-drop checklist; move under schema-migration runbooks and include raw SQL, aliases, generated API, fixtures, and production parity. |
| `deprecated-column-response-leak.md` | **KEEP / FIX SYSTEMICALLY** | The lesson is valuable, but the durable fix should be explicit response projections/serializers or outbound validation, not permanent memory of every leak. |
| `dev-half-of-paired-migration.md` | **MERGE INTO MIGRATION RUNBOOK** | Operational checklist item; no need for a separate active memory file. |
| `drizzle-any-array-cast.md` | **MERGE INTO DRIZZLE PITFALLS** | Keep the failing/rendered SQL example and preferred inArray alternative. |
| `drizzle-desc-index-publish-churn.md` | **MERGE INTO DRIZZLE/DEPLOY PITFALLS** | Keep the Publish behavior as a schema-generation limitation, not a standalone active memory. |
| `drizzle-orderby-literal-ordinal.md` | **MERGE INTO DRIZZLE PITFALLS** | Keep as a tested footgun with a lint/test recommendation. |
| `drizzle-sql-template-bare-column.md` | **MERGE INTO DRIZZLE PITFALLS** | Keep the nuanced qualification behavior and toSQL/EXPLAIN workflow; remove incident-specific stale pointer examples. |
| `drizzle-sql-template-outer-paren.md` | **MERGE INTO DRIZZLE PITFALLS** | Keep as a real execution-test lesson; favor helper composition over hand-parenthesized text. |
| `drizzle-subquery-alias-ordering.md` | **MERGE INTO DRIZZLE PITFALLS** | Keep alias collision/order rules and add small reusable helpers/tests. |
| `dupspec-test-data-pollution.md` | **MERGE INTO TEST-DATA HYGIENE** | Consolidate killed-run cleanup patterns and add teardown/unique namespace improvements so cleanup is not manual. |
| `ledger-read-cutover-prod-gate.md` | **MOVE TO RUNBOOK** | The dual-write/backfill/read-flip sequence is valuable as a generic migration runbook, but it is not current architecture after cutover. Remove it from the active money index. |
| `mockup-preview-url.md` | **MERGE** | Merge with mockup-sandbox-verification.md. |
| `mockup-sandbox-verification.md` | **KEEP AS MOCKUP RUNBOOK** | Canonicalize preview URL and screenshot verification in one file. |
| `orval-custom-query-options-querykey.md` | **MERGE INTO ORVAL GUIDE** | Keep with generated-query usage examples. |
| `orval-query-key-invalidation.md` | **MERGE INTO ORVAL GUIDE** | Keep the /api prefix rule, preferably behind exported invalidation helpers. |
| `orval-zod-coerce-boolean.md` | **MERGE INTO ORVAL GUIDE** | Keep the warning; prefer explicit enum/presence schemas over boolean coercion. |
| `parse-or-bad-request-arg.md` | **MERGE INTO API ROUTE PITFALLS** | Keep the helper contract and add a narrower type signature so the misuse stops compiling. |
| `prod-data-seed-slug-mismatch.md` | **MOVE TO INCIDENTS / RUNBOOK** | Retain affected-row/state verification as a generic migration checklist item; archive the specific incident. |
| `prod-dev-data-sync.md` | **KEEP AS HIGH-RISK RUNBOOK** | Keep isolated from product memory, require dry-run/count verification, and clearly mark which tables/columns are safe to copy. |
| `prod-executesql-enum-cast.md` | **MOVE TO OPERATIONS** | Keep as a connector/tool-specific diagnostic, not product architecture. |
| `publish-diffs-dev-database.md` | **KEEP AS DEPLOY CANON** | This appears central to the environment. Merge related publish/schema files beneath it and add a repeatable pre-publish checklist. |
| `publish-flow-extensions.md` | **MERGE INTO DEPLOY CANON** | Keep the extension exception but fold it into the publish/deployment guide. |
| `qbo-data-prod-only.md` | **MOVE TO OPERATIONS** | Keep as environment/data-availability guidance, not domain architecture. |
| `raw-date-cast-validation.md` | **MERGE INTO API ROUTE PITFALLS** | Keep the round-trip validation rule and centralize it in a shared date schema/helper. |
| `replit-db-deletion-recovery.md` | **KEEP AS EMERGENCY RUNBOOK** | Prominent but outside architecture. Add “never delete” guardrails and recovery ownership. |
| `schema-column-migration-required.md` | **MERGE INTO MIGRATION RUNBOOK** | Keep the reviewable idempotent migration requirement as a canonical policy. |
| `scoped-validation-checks.md` | **KEEP AS VALIDATION CANON** | Use as the canonical command matrix; merge CPU/process caveats into an appendix. |
| `test-seed-2099-pollution.md` | **MERGE INTO TEST-DATA HYGIENE** | Consolidate and prefer transaction rollback or per-run namespaces over date-band cleanup. |
| `vite-build-env-gating.md` | **KEEP / TEST** | Good deploy invariant; enforce with a build test without serve-only env vars. |
| `wildflower-api-server-build.md` | **MERGE INTO TOOLING RUNBOOK** | Keep stale-build diagnosis with server startup/build instructions. |
| `wildflower-test-user-pollution.md` | **MERGE INTO TEST-DATA HYGIENE** | Consolidate and add explicit cleanup/hidden-test-user conventions. |
| `workspace-symlink-ts2307.md` | **MERGE INTO TOOLING RUNBOOK** | Useful diagnosis, but belongs in the consolidated build/troubleshooting guide. |

### CRM/product invariants & UI patterns

| File | Recommendation | Suggested change |
|---|---|---|
| `archive-soft-delete-boundaries.md` | **KEEP / CENTRALIZE** | Good cross-cutting invariant. Add a table of exceptions and enforce list/detail/analytics behavior with schema-derived or route inventory tests. |
| `audit-log-recording-model.md` | **KEEP / CENTRALIZE** | Keep the atomic versus non-blocking paths, but expose one shared service API and inventory mutation routes that bypass it. |
| `bulk-action-load-gate.md` | **KEEP / COMPONENTIZE** | Keep the invariant and enforce it in the shared bulk-dialog component rather than every caller. |
| `cleanup-queue-flag-for-research.md` | **KEEP / CURRENT-STATE ONLY** | Keep the sole-path and idempotency rules; move retired needsResearch history to the migration file. |
| `interactive-prompts-dont-render.md` | **KEEP USER-SPECIFIC** | Keep at the root because it affects every interaction, but make it one line and avoid tool-specific assumptions if the platform changes. |
| `issues-to-address-cleanup-queue.md` | **ARCHIVE MIGRATION HISTORY** | The migration is complete. Keep only any current cleanup_queue taxonomy rule elsewhere. |
| `list-page-default-order.md` | **KEEP / CENTRALIZE** | Use a shared display-name/order helper and stable tiebreaker test. |
| `list-page-pagination.md` | **MERGE / COMPONENTIZE** | The fact that markup is duplicated is a prompt to extract a shared pagination component, then shorten the memory. |
| `merge-config-inventory-drift.md` | **KEEP** | Strong schema-derived inventory-test pattern; consider extending the same approach to owner reassignment and audit logging. |
| `merge-entity-cascade-lock.md` | **KEEP** | Durable concurrency invariant; ensure every merge path uses the same service. |
| `owner-reassignment-column-coverage.md` | **KEEP / ADD INVENTORY TEST** | The file itself identifies the gap. Add a schema-derived test similar to merge-config and then shorten the memory. |
| `person-name-display-sql.md` | **KEEP / CENTRALIZE** | Good shared helper rule; add snapshot/parity tests across list/search surfaces. |
| `post-merge-push-abort.md` | **MERGE INTO DEPLOY RUNBOOK** | Fold into one Replit/Drizzle schema-deployment guide; this is an operational failure mode, not domain memory. |
| `potential-duplicates-queue.md` | **KEEP / SPLIT** | Keep scoring/merge invariants; move historical tuning and cleanup incidents into tests/runbooks. |
| `record-card-empty-collapse.md` | **KEEP AS UI PATTERN** | Clear convention; place in a short design-system behavior guide. |
| `reporting-deadline-donor-filter.md` | **KEEP AS REGRESSION CONTRACT** | Concise and specific; add/retain an endpoint test and avoid broader active-memory prominence. |
| `select-in-dialog-scroll-trap.md` | **KEEP AS UI PATTERN** | Useful and concrete. Consolidate with other component UX patterns if the set grows. |
| `shared-outcome-flag-gating.md` | **KEEP / TEST** | Good general invariant. Add discriminated-union request bodies so outcome misuse fails typechecking. |
| `unpickable-rows-label-not-hide.md` | **KEEP AS PRODUCT RULE** | This is a clear cross-product UX principle. Link all picker implementations to a shared blocked-row model. |
| `wildflower-anonymous-visibility.md` | **REWRITE / SECURITY REVIEW** | UI-only hiding is not confidentiality. Clearly state the threat model, enumerate leaks, and decide whether API-level masking/authorization is required. |
| `wildflower-crm-routes.md` | **KEEP / MOVE TO APP MAP** | Put route naming in a canonical application map rather than standalone memory. |
| `wildflower-donor-xor-pickers.md` | **KEEP / ENFORCE DB+API** | Good invariant; pair UI behavior with request schema and DB constraint tests. |
| `wildflower-foundation-org-vs-entity.md` | **KEEP** | Important domain distinction; concise and durable. |

### Other / skipped

| File | Recommendation | Suggested change |
|---|---|---|
| `coding-form-import-staging.md` | **MOVE TO RUNBOOK** | Good one-time import pattern, but keep it as an import runbook with idempotency and compare-don’t-clobber principles. |
| `email-intel-failure-recovery.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `email-intel-propose-alternative.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `email-intel-stuck-analyzing.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `email-messages-cross-mailbox-dedup.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `emails-global-unique.md` | **KEEP / REVIEW PERIODICALLY** | No clear contradiction found from my reviewed context. Add last-verified/current-state metadata and keep it out of the root index unless it is frequently needed. |
| `flodesk-subscriber-sync.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `gmail-sync-stuck-detection.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `grant-agreement-drive-backfill.md` | **MOVE TO RUNBOOK / ARCHIVE AFTER RUN** | One-time backfill. Keep source/document conflict rules in the normal attachment model after completion. |
| `inline-edit-trigger-sites.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `internal-email-domains-config.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `media-ingest-dedupe.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `staff-default-sync-suppression.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `task-intelligence.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `thank-you-detector-donor-coverage.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `wildflower-activity-feed-scoping.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `wildflower-activity-feed-tracking-enrich.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `wildflower-ai-proposal-resilience.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `wildflower-html-entities.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |
| `wildflower-list-chooser-pattern.md` | **KEEP / COMPONENTIZE** | Keep saved-view compatibility rules and move implementation to shared components/tests. |
| `wildflower-per-recipient-tracking.md` | **SKIP — NOT ENOUGH DOMAIN CONTEXT** | Read, but I have not explored this subsystem enough to recommend semantic changes. Apply the same current-state/runbook/incident separation. |

## Highest-priority sequence

1. Correct the remaining **current-versus-target ambiguity** in `money-sync-reconciliation.md`: `source_links` is planned, not current authority, and Stripe/Donorbox pointers remain live until their read cutovers.
2. Finalize `docs/adr-source-link-ledger.md`, including relationship types, proposal lifecycle, cardinality, migration order, and the exact continued role of `settlement_links` as a sibling table.
3. Replace charge-tie supersession ownership in PA `note` text with structured provenance tied to a source-link relationship; until then, mark the note marker as transitional executable state everywhere it is documented.
4. Centralize the canonical “open charge work” predicate and use it in settlement-only re-admit, terminal-charge filtering, graph, bundle, and lateral-expansion queries, with SQL-executing parity tests.
5. Prune `MEMORY.md` into grouped routers and keep `replit.md` aligned with the same reconciliation vocabulary and dev-schema safety guidance.
6. Consolidate tooling memories into four guides: deployment/schema, validation/testing, Drizzle SQL, and generated API/Orval.
