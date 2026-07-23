---
name: Money sync & reconciliation
description: Current-state index of money-sync and reconciliation rules. QB/Stripe/Donorbox ingest, staged-payment approval, the three link tables, workbench UI, and imports. Pointer-era entries (matched/created/group_reconciled_gift_id QB cols — DROPPED migration 0126) are in legacy-reconciliation/index.md.
---

## Implementation guard

Before writing any reconciliation code, confirm:

- **Use the authoritative link table for the relationship involved.**
  `payment_applications` for money unit→gift; `settlement_links` for payout↔deposit;
  `source_links` for evidence↔evidence. Never route a relationship
  through the wrong table or add a sibling pointer column.
- **Do not add new pointer columns, stored queue status columns, copied status CASE
  expressions, or route-specific money-link logic.** All queue status derives at read
  time via `derivedStatus.ts` builders — never hand-roll a CASE twin.
- **Frozen pointer columns may be read only where the current migration phase already
  requires it.** Do not add new readers or writers of frozen/deprecated pointers.
  The QB gift-pointer columns (`staged_payments.matched/created/group_reconciled_gift_id`)
  are DROPPED (0126). The Stripe/Donorbox cross-processor pointers
  (`linked/proposed_qb_staged_payment_id`, `linked_fee_qb_staged_payment_id`,
  `linked_stripe_charge_id`) are DROPPED (0149) — `source_links` is the sole
  authority for those ties.
- **Current state ≠ target state.** Transitional dual-write fields document migration
  progress, not preferred architecture. New work should move the system toward the
  target. Any change that must use a frozen, deprecated, or dual-write-only field must
  either advance its retirement plan or document an explicit removal condition — get
  user approval before proceeding.
- **Stop and bring it to the user** when a fix requires updating more than one copy
  of equivalent logic, adds a parallel representation, or depends on a field the
  architecture docs mark as transitional. Propose consolidation first.

---

## Current link-table model

Three authoritative link tables — never conflate:

**Ledger 1: `payment_applications`** — Money unit → CRM gift (current authority). QB
reads fully flipped to the ledger; Stripe reads also fully flipped (migration 0130
backfill + read-cutover complete as of 2026-07); Donorbox pointer column still
dual-writes. `gifts_and_payments.final_amount_stripe_charge_id` is @deprecated
(never written, never returned by API, backfill SQL 0130, physical column retained
until reviewed DROP migration ships). `link_role='counted'` = money trail
(amount NOT NULL); `link_role='corroborating'` = audit annotation (see topic file
for the two distinct sub-cases). `gift_id` ON DELETE RESTRICT.

**Ledger 2: `settlement_links`** — Stripe payout ↔ QB deposit (Plane 1 batch↔batch,
current authority). Lifecycle: `proposed | confirmed | exempt`. Status derived on read.
Separate from `source_links` by design (different link types, different cardinality
rules); the two tables are siblings, not one absorbing the other.

**Ledger 3: `source_links`** — Evidence↔evidence claims: charge↔QB tie,
charge↔fee-row, Donorbox↔QB, Donorbox↔charge. **SHIPPED and sole authority**
(ADR in `docs/adr-source-link-ledger.md`, phases 1–6 complete). The five legacy
pointer columns it replaced were dropped in migration 0149; never add sibling
pointer columns.

**No stored lifecycle status** on `staged_payments` or `stripe_staged_charges`.
All reconciliation queue status is derived at read time via `derivedStatus.ts` alias-
parameterized builders. Donorbox has its own stored lifecycle mapped to the shared
vocabulary at the API edge only. QB deposits carry a stored `status` column (a
distinct QB-payment fact, not the queue-lifecycle enum).

**QB gift-pointer columns are DROPPED (migration 0126).** `staged_payments.matched/
created/group_reconciled_gift_id` no longer exist. Current QB linkage reads:
mint ownership = `payment_applications.created_the_gift`; match/multi-match =
PA counted rows. Unit groups are fully retired (ADR linear-money-model §7
step 3): nothing reads or writes `unit_groups`/`unit_group_members`; the
tables sit inert until step 4 drops them.

---

## QuickBooks ingest & sync

- [QuickBooks payment sync](quickbooks-payment-sync.md) — pull-only QBO→CRM; idempotent (realmId,type,id) rows retained; dev keys⇒sandbox host, prod keys⇒live; redirect URI exact-match per key set; approve mints gift w/ Donor XOR.
- [QuickBooks exclusion rules](quickbooks-exclusion-rules.md) — TS classifier ↔ SQL backfill lockstep; donation-first guard; classifier is insert-time only, watermark sync won't re-enrich historical line detail ([auto-exclude](quickbooks-staged-exclude.md)).
- [QuickBooks editable handling rules](quickbooks-editable-rules.md) — QB ingest rules now DB-editable; engine SEED_RULES must mirror code classifier (fidelity test); auto_create_approve mints+allocates+approves; GenOps=intended_usage not a project row.
- [Entity attribution (replaced fiscally_sponsored exclusion)](quickbooks-entity-attribution.md) — that EXCLUSION retired; detectEntity/ENTITY_MARKERS set staged_payments.entity_id + keep row in queue; markers TS↔SQL lockstep.
- [QB sync worker never mints](quickbooks-worker-no-mint.md) — worker autoApply only reconciles to ONE existing gift; new-gift auto-create is rule-only (AmazonSmile auto_create_approve at ingest), else row stays pending for review.
- [QB LinkedTxn provenance](quickbooks-linkedtxn-provenance.md) — top-level LinkedTxn=deposit it was deposited into, line-level=invoices it applies to; deposit link derived read-only from qb_raw at query time, not a column.
- [QB back-catalog stays stale](quickbooks-clean-reingest.md) — watermark sync never re-pulls back-catalog & donor matching is ingest-only; wipe+reset watermark to re-pull (keep auto-created gifts=reconcile not re-mint); or admin rematchStagedPayments for donor-only ([donor rematch](quickbooks-donor-rematch-backfill.md)).
- [QB full re-pull (background, non-destructive)](quickbooks-nondestructive-repull.md) — ~4min job exceeds proxy timeout→fire-and-forget + GET resync-status poll (advisory lock is the real guard); backfill qb_* via fullResync+enrichAllStatuses NOT a wipe; set stays read-only QB facts, qb_raw excluded ([polled](quickbooks-resync-background.md)).
- [QB deposit-coding preserve-on-conflict](quickbooks-deposit-coding-preserve.md) — staged-payment upsert must keep stored line coding when incremental pull is empty (edited payment + out-of-window deposit); reseed must reset watermark.
- [QBO inactive-item income account](quickbooks-deleted-item-income-account.md) — QBO /query hides Active=false items; deleted service items keep IncomeAccountRef but need a 2nd Active=false pass or revenue coding stays blank; backfill via full re-pull only.
- [QBO/live data lives in PROD not dev](qbo-data-prod-only.md) — dev DB is stale/partial; QuickBooks staged_payments + recently changed schools are prod-only; query prod read-only for QBO facts, don't conclude "missing" from dev.

## Staged-payment approval & gift linkage

QB gift linkage via `payment_applications` (counted rows). Stripe/Donorbox gift
linkage via row-level pointer columns on their charge/donation tables. Pointer-era
entries for QB are archived in `legacy-reconciliation/index.md`.

- [QB matching gifts vs duplicates](quickbooks-matching-gifts.md) — never dedupe by donor+amount+date (matching gifts are identical); only QB LinkedTxn/same entity_id proves same money; second matching gift must be MINTED not linked.
- [QB fee-band auto-reconcile](quickbooks-feeband-reconcile.md) — single near-amount gift w/ no exact match = net of processor fee → reconcile not mint; backfill mirrors donorWhere+null-date+one-gift-per-row; when Stripe NET known return [net,gross] window directly, don't fall through to legacy gross*1.1+1 ([net-aware](reconciliation-net-aware-feeband.md)).
- [QuickBooks reconcile adopts gift donor](quickbooks-reconcile-donor-adoption.md) — explicit human Match links to a gift by adopting the GIFT donor (overrides auto-guess); donorsMatch/validateGiftLink no longer enforced on that path.
- [QuickBooks reconciler intermediary donor seed](quickbooks-intermediary-donor-seed.md) — when payer is Stripe/Donorbox/DAF, seed gift search with the donor pulled from the memo (after "from"/dash), conservatively.
- [DAF sponsor is never the donor](quickbooks-daf-sponsor-attribution.md) — DAF sponsor = payment intermediary, not donor; matcher guard drops sponsor-as-org donor; historical cleanup SQL repoints to advisor or flags daf-donor-review.
- [QB deposit memo wrong donor](quickbooks-deposit-memo-wrong-donor.md) — card payer label = QB memo, can name the WRONG donor; the payout's charges are authoritative; check screenshot image_<ms>.png epoch vs match_confirmed_at before claiming "didn't work".
- [QuickBooks payment grouping](quickbooks-deposit-grouping.md) — unit groups FULLY RETIRED (ADR linear-money-model step 3 done): all group endpoints 410; combine = multi-match (N counted PA rows, zero-amount rejected, confirmMultiDate cross-date); per-row revert is the only undo. File is historical.
- [Grouped create-gift → optional allocation split](grouped-create-gift-allocations.md) — HISTORICAL (unit groups retired): group-aware create-gift + splitGroupIntoAllocations are gone; context for legacy data only.
- [Staged-payment funding source + grouping](staged-payment-funding-source-grouping.md) — funding_source=origin (≠ instrument ≠ derived lane); auto|manual provenance guards re-pull clobber; grouping half HISTORICAL (unit groups retired).
- [Forward gift intake](forward-gift-intake.md) — reconciliation suggests collectible pledges first; copies pledge allocs onto minted gift PROPORTIONALLY (last-row remainder); manual-form dup guard via pending-for-donor.
- [Gift merge evidence combine](gift-merge-evidence-combine.md) — merge absorbs losers' reconciled evidence onto survivor (was 409-block) then archives them; still 409 on split/2+ Stripe/Donorbox; MUST reject archived participants or replay double-counts.
- [Gift QB tie status](gift-qb-tie-status.md) — LIVE-derived at read time (`deriveGiftQbTieLiveExpr`; stored column DROPPED, applier retired, zero recompute call sites); per-source counted precedence qb>stripe>donorbox (never SUM); off-books exempts; audit view excludes off-books.
- [Gift↔payment match band policy](gift-match-band-policy.md) — all gift-match amount/window logic flows through lib/giftMatch.ts; strict=ready/gate, widened=propose, known-net=Stripe net (guard net NOT NULL); ready ⊆ approve-gate invariant.

## Stripe

Stripe charges link to gifts via `stripe_staged_charges.matched_gift_id` /
`created_gift_id` (pointer columns; still live — PA ledger is the authoritative
Stripe gift read; `final_amount_stripe_charge_id` on the gift table is
@deprecated+never-written since 2026-07). Revert un-sources the pointer + removes
ledger rows.
Derived charge status (`pending | match_proposed | match_confirmed | excluded`) is
read via `derivedStatus.ts` builders — no stored status column. `match_confirmed`
requires a BOOKED charge (counted PA row); raw linkage alone is a CLAIM signal only.
Failed/disputed charges ingest with `exclusion_reason='failed_charge'`; that
`exclusion_reason` drives the derived `excluded` status (terminal — never receives a
gift link). Retired Stripe pointer-era entries in `legacy-reconciliation/index.md`.

- [Stripe history backfill](stripe-history-csv-backfill.md) — prior account (id-infix) loads from CSV only (omit donor FKs=cross-env drift, amount=bank net, ON CONFLICT DO NOTHING); first sync seeds watermark to "now" so fullResync re-walks all but must NOT short-circuit the no-cursor seed-return guard ([full re-pull](stripe-full-repull-backfill.md)).
- [Stripe restricted live key vs connector](stripe-restricted-key.md) — STRIPE_RESTRICTED_KEY (rk_live) preferred over test-only connector; account id regexed from KYC-scope error; backfill never seeds sync_state.
- [Stripe→QB historical restitch trigger](stripe-historical-restitch-trigger.md) — incremental sync only proposes its own run's payouts; historical/prior-account stay unmatched so cards show no Stripe until the admin propose-all pass runs (proposals only, human-driven in prod).
- [Stripe refund/chargeback propagation](stripe-refund-propagation.md) — implemented: propose-then-confirm, forward-only, re-confirm 409s; confirm archives/reduces gift + re-derives pledge (QB-tie recompute obsolete — live-derived). RATIFIED DRIFT 2026-07-21: refunds are transaction facts, gift disposition is a separate human decision — do NOT extend.
- [Charge-grain Stripe↔QB ties](charge-grain-qb-ties.md) — missing-deposit payouts tie per CHARGE (proposed vs confirmed cols); lump settlement-link owns its payout; settled=every non-terminal charge confirmed-tied.
- [Charge-tie pair dismissals](charge-tie-dismissals.md) — dismiss persists the exact charge↔QB pair; propose pass skips it forever, other pairings unaffected; manual "Tie selected" deliberately overrides dismissals.
- [Sibling Stripe-fee row link](charge-fee-row-link.md) — charge ties match gross OR net exactly; confirm auto-claims the deposit's negative fee row as Plane-1 evidence ONLY (never payment_applications); TS pairing must stay lockstep with the SQL backfill; stamp under savepoint so a race never aborts confirm.
- [Charge-tie supersede + evidence vs claim](charge-tie-supersede.md) — tie confirm moves exact-cents QB counted money to the charge grain (one-builder rule; raw-SQL twins ELIMINATED); derived status evidence needs a BOOKED charge, claims use raw linkage; parity tests pin the distinction.
- [Payout net_total = true ledger net](stripe-payout-net-rollup.md) — net = gross−fee−refund+adjustment == bank when books balance; rollup skips the payout's own txn, unknown bt types flow through adjustment via bt.net; no SQL backfill — full re-pull recomputes.

## Donorbox

Donorbox gift linkage uses `donorbox_donations.matched_gift_id` / `created_gift_id`
pointer columns (PA ledger dual-writes but does not yet read). Donorbox has its own
stored lifecycle (`status` column); map to shared derived vocab via
`donorboxEmittedStatus()` at every emit point — never let the stored vocab leak.

- [Donorbox pull-sync money model](donorbox-sync-model.md) — Stripe-type donations enrich only (never mint; stripe_charge_id joins 1:1 to staged charges); PayPal = new money, human-reviewed; row FOR UPDATE guards double-mint ([API auth](donorbox-api-integration.md): login email + key).

## Reconciliation model & ledger

- [Reconciliation single-source-of-truth (D4)](reconciliation-single-source-of-truth.md) — CRM gifts are the only gifts; Stripe/QB rows are permanent evidence; Stripe GROSS wins; confirm stamps facts not archives; processor_payout/confirmed_excluded kept only for revert.
- [Two-lane reconciliation model](reconciliation-two-lane-model.md) — every unit of money derives two independent lanes (funding + crmRecord), never stored; gift link ≠ donor confirmed; emit on ALL evidence endpoints.
- [Reconciliation target-state design](reconciliation-target-design.md) — ratified three-link-table model (payment_applications + settlement_links + source_links) in docs/reconciliation-design.md; two planes, all statuses derived; phases 2-5 shipped; "one-ledger" in older doc sections refers to payment_applications as the sole unit→gift ledger (pre-source_links vocabulary).
- [Reconciliation status is derived](reconciliation-derived-status.md) — staged/charge status derived from facts via ONE set of alias-parameterized builders in derivedStatus.ts; never hand-roll a CASE twin (parity tests pin it); Donorbox maps stored→vocab at the API edge.
- **Evidence↔evidence claim pointers are DROPPED (migration 0149, 2026-07)** — `source_links` is the sole authority; never add sibling pointer columns. ADR in docs/adr-source-link-ledger.md.
- [Reconciliation phase status source](reconciliation-phase-status-source.md) — trust migration ledger + schema header comments for phase status; all link-table phases shipped; cluster view (reconciliation-clusters.tsx) is the current UI design, superseding the six-queue workbench.
- [payment_applications ledger](payment-applications-ledger.md) — unit→gift ledger (polymorphic evidence_source: quickbooks|stripe|donorbox); QB reads flipped; Stripe/Donorbox dual-write only; book-once in service layer; gift_id RESTRICT; provenance promotion on confirm (system→system_confirmed).
- [Ledger read-cutover prod gate](ledger-read-cutover-prod-gate.md) — additive dual-write→backfill→flip-reads is only safe once parity runs on PROD (dev parity ≠ prod); after a flip, fixtures seeding legacy-only links must dual-write the ledger row.
- [settlement_links model](settlement-links-model.md) — sole payout↔deposit store (Plane 1); lifecycle proposed|confirmed|exempt; conflict_approved = proposed+conflict_gift_id; deposit hard-delete errors on required-deposit CHECK. Sibling of source_links, not absorbed by it.
- [PA counted vs corroborating link_role](reconciliation-corroborating-link-role.md) — every money/settled/tie read MUST filter link_role='counted'; two distinct corroborating sub-cases: (A) amount NULL = corrections audit annotation; (B) amount NON-NULL = demoted supersede row (kept for reversible promotion — still excluded from every money total).
- [Counted-uniqueness per anchor](counted-uniqueness-invariant.md) — ONE counted PA row per evidence anchor (guard in applier + partial unique indexes); test seeds with 2 counted rows on one anchor now fail at insert; corroborating rows exempt; gift-side split is a 410 tombstone.
- [Reconciliation conflict_approved = awaiting](reconciliation-conflict-approved-per-track.md) — Stripe payout conflict_approved is NOT a discrepancy; show recon status per-track (QB vs Stripe), never one sweeping badge.
- [Conflict-keep double-book gate](reconciliation-conflict-keep-gate.md) — a conflict_approved "keep" is safe only if kept gift == deposit's gift link; enforce at BOTH the pure derive blocker and the tx write boundary.
- [Settlement needs_review derivation](reconciliation-needs-review-derivation.md) — needs_review gates on having an OPEN charge, not on derived queue status alone; fully-settled unmatched payouts must drop out.
- [Double-book guard is anchor-kind-aware](reconciliation-parallel-evidence-doublebook.md) — "already linked" guard counts only SAME-kind evidence; fix all 4 layers or the false positive moves downstream.
- [Terminal charges count as settled](reconciliation-terminal-charge-queue-pin.md) — charges with exclusion_reason (derived status = excluded) or a pre-deprecation dismissed state are terminal and count as settled in queue predicates — "no gift link" alone is not open work; terminal set must be consistent across graph endpoint, bundle anchors, and lateral filters.
- [Settlement-confirm decouples planes](reconciliation-settlement-only-confirm.md) — confirming a settlement link advances the deposit's derived status to match_confirmed (Plane 1 only); per-charge gift crediting is Plane 2 / gift-report queue only; after confirm the gift-report queue must still show deposits with unbooked charges (exists branch) or they go invisible.
- [Reconciliation re-target conflict composition](reconciliation-retarget-conflict-compose.md) — gate collects ALL issues so stripe re-source + QB-link displacement resolve in ONE confirm; displace only DIRECT-match incumbents.

## Workbench UI & queues

- [QB reconciler left-card UI model](quickbooks-reconciler-ui-model.md) — donor matching is right-pane only (no left donor picker); intercompany_transfer/other are manual-only exclusion reasons (no classifier/backfill).
- [Reconciliation gate vs client blockers](reconciliation-gate-vs-blockers.md) — approve button mirrors only SOME server gate codes; surface ApiError.data.details.issues via extractGateIssues, don't duplicate the gate logic.
- [Bundle queue axis mapping](reconciliation-bundle-queue.md) — settlement bundles are payout-anchored; qg/qd axes intentionally empty, qs/ds/all show all; confirm-ties is additive enrich-only (NULL-fill, mints nothing).
- [Reconciler card readiness pool](reconciler-card-readiness-pool.md) — n()/unlinkedDonorGiftWhere is the shared count/pick/ready gift pool (cards.ts only); STRICT ±90d date clause (not null-tolerant); separate from matcher's 60d.
- [Reconciliation card queue enum](reconciliation-card-queue-enum.md) — cards query-param uses ReconciliationCardQueue, NOT QuickbooksStagedPaymentQueue; research=needsResearch filter never a bucket; card-only values in the shared enum = silent drift.
- [Reconciliation gift search modes](reconciliation-gift-search-modes.md) — one endpoint, two windows via split flag: 1:1 match = near-equal to full amount; split = fractions (drop lower floor, relax date, no confidence); never fold them.
- [Bundle confirm cache invalidation](reconciliation-bundle-confirm-invalidation.md) — confirming a settlement bundle reconciles the SAME staged/charge/gift rows the workbench's other queues render; invalidate cards + staged-payments + gifts + gifts-missing-qb, not just the anchor list.
- [Matched column is read-only](reconciliation-matched-column-readonly.md) — the done/Matched report renders cards view-only (no confirm/group/checkbox); gate by COLUMN not derived status or settled grouped cards 409 on re-confirm.
- [Multi-charge payout per-charge link-gift](reconciliation-multicharge-link-gift.md) — a per-charge card in a >1-charge payout can't approve via the deposit path (graph chargeId null→409 stripe_charge_required); use POST link-gift to tie the charge to its existing gift.
- [Per-charge routing must cover EVERY approve entry path](reconciliation-percharge-routing-all-paths.md) — single-card, search AND bulk must branch on deposit-confirmed (not just chargeCount>1); the approve link path has NO charge-anchored hatch (guided 409 backstop), so a missed frontend branch = permanent "already resolved" loop.
- [cards resolved-gift FY wrong-table 500](cards-resolved-gift-fy-wrong-table.md) — grant_year is gift_allocations-only (gifts_and_payments has none); chargeSub hand-dupes shared resolved-gift subqueries and can drift; diagnose raw-sql column errs via drizzle .toSQL()+EXPLAIN (no exec).
- [CRM-only worklist allocation rows](crm-only-allocation-rows.md) — worklist is allocation-granular but reconcile + revert are gift-level; no allocation-level payment link exists.
- [Stripe charge donor crossing](stripe-charge-donor-crossing.md) — gift proposals are donor-scoped; a wrong confirmed donor deterministically links the wrong donor's gift; repairs must mirror the FULL link write-set (PA row + charge stamps + final-amount stamp + tie re-derivation).
- [Recon search bands & confirm gating](reconciliation-search-and-confirm-gating.md) — text overrides the amount band; never pre-gate ahead of the locking confirm primitive; overridable blockers = exclusion + amount-mismatch; claimed-money blockers stay hard 409.
- [Recon three-facet model](recon-three-facet-model.md) — owner-ratified vocabulary who/why|transaction|accounting (CRM gift ≠ who/why); linkage vs adequacy are separate signals.

## Imports/backfills & prod verification

- [Coding-form import staging](coding-form-import-staging.md) — one-time xlsx→coding_form_rows staging + compare-don't-clobber reconciliation; cross-check derived live on read, apply writes only reviewer-approved attrs, idempotent via stored applied_* ids.
- [Coding-form import](coding-form-import.md) — effective reads are AI??parsed??raw via one accessor module; AI only normalizes/suppresses (never maps circles); record-first gift match inherits donor; grant letters opp-else-gift.
- [Coding-form gift matching](coding-form-gift-matching.md) — bulk rematch must stay pending+unconfirmed (rematch clears human decisions); exact ±1¢ band ≠ ingest fee band; auto-propose only on exactly-one candidate.
- [Reconciliation cross-check prod verification](reconciliation-crosscheck-prod-verification.md) — prod read-only pass: Stripe 39/39 solid, QBO trustworthy except 45d window too tight (false-negative), amount-only path unreliable (zero/neg/wrong-donor), sheet self-dupes double-count.
- [Grant-agreement Drive backfill](grant-agreement-drive-backfill.md) — pull coding_form_rows.drive_link PDFs onto matched OPPS (never gifts) via grant-letter flow; per-row idempotent, conflict never auto-overwrites, status derived; Drive client = connector-token proxy (no googleapis pkg).

## Settlement claims and exclusion independence (2026-07)

- Exclusion and settlement eligibility are INDEPENDENT facts: a stored
  `exclusion_reason` removes a QB deposit from the donation queue but does NOT
  disqualify it as a payout-settlement candidate. Never re-add an
  excluded-filter to settlement candidate queries.
- A QB deposit claimed by a confirmed settlement link or confirmed charge tie
  DERIVES `excluded` (settlement-claim arm in `derivedStatus.ts`, no stored
  exclusion_reason). The QB status CASE therefore consults the tie twice:
  booked form → match_confirmed; raw claim form → excluded.
- Negative/failed payouts resolve as Stripe withdrawals via an `exempt`
  settlement link (NULL deposit pointer, finance-gated, undoable). Exempt =
  "no deposit expected", never a synonym for confirmed_excluded.
- Test gotcha: `reclassifyStagedPayments` runs under the QB sync lock; when
  another vitest file holds that lock concurrently the pass silently skips and
  entity re-attribution assertions fail — a lock-contention flake, rerun before
  debugging.
