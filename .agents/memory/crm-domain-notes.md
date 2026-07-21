---
name: CRM domain notes index
description: Routing index for CRM feature/domain lessons — gifts, pledges, opportunities, donors, orgs/people, lists, tasks, merges. Read only the entries matching the feature being changed.
---

# CRM domain notes

One-line routing entries for CRM app-domain lessons. Read only the topic files
relevant to the task.

## Gifts, pledges, and money records

- [Split gift into pledge](split-gift-into-pledge.md) — transform-in-place (keep original as 1st payment); matching-gift split intentionally allowed; lock allocation rows too; pledge stage derived (cash_in when fully paid).
- [Pledge paid_amount derivation](pledge-status-rederivation.md) — paid_amount SUM EXCLUDES archived payments; out-of-band/raw-SQL changes don't re-run derivation — re-derive by mirroring deriveOppFields stage advance.
- [Pledge write-off model](pledge-write-off-model.md) — many write-offs over time, ONE editable at once (FOR UPDATE app lock, unique index dropped); capacity = committed+writtenOff−paid must stay lockstep in 3 places.
- [Pledge expected_payment_date](pledge-expected-payment-date.md) — per-ROW date on PLEDGE allocations only (not gifts, not per-grant-year); shared date = one expected payment; nullable, additive, no trigger.
- [Reimbursable grant = pledge](reimbursable-grant-payment-model.md) — reimbursable grants (conditional='reimbursable') are pledges; book each real QB/Stripe check as a 1:1 gift payment, never as placeholder award-amount gifts.
- [Reimbursable direct/indirect share exclusion](reimbursable-share-exclusion.md) — direct-tagged alloc lines recorded full but excluded from goal analytics via IS DISTINCT FROM 'direct'; never leak into opp-status or paid-amount derivation.
- [Audit-close gift freeze](gift-booking-lifecycle-audit-close.md) — records freeze by governing FY when its audit closes; fix in an open FY (under→new offsetting pledge, over→new gift), never mutate originals.
- [Deleting a gift requires removing allocations first](gift-delete-allocations-restrict.md) — gift_allocations FK is RESTRICT (every gift has >=1); delete route must clear allocations in-txn first; other gift FKs are set-null.
- [Allocation school link (pledge vs gift)](allocation-school-link.md) — both carry schoolRecipientId FK; gift name via server display_usage trigger, pledge resolves client-side (no trigger by design); "School recipient" is a raw Input not a picker.
- [Donor-intent restriction policy](donor-restriction-policy.md) — owner rules beat form text: Yield/Arthur Rock never restricted; BWF always; hubs geo-restrict; Donorbox authoritative.

## Donors, organizations, people, households

- [funders→organizations consolidation](funders-organizations-consolidation.md) — funders+organizations merged; issuesGrants flag distinguishes grant-makers; DonorType "funder"→"organization"; the stale one-time Airtable importer was retired/deleted (2026-07).
- [Gives-through donor→PI links](gives-through-donor-pi.md) — donor (org/indiv/household) ↔ payment-intermediary join; donor-XOR at 3 layers; idempotent onConflictDoNothing; giftDerived suggestions; old org PI col deprecated not dropped.
- [Individual org soft-credit](individual-org-soft-credit.md) — person lifetime/last-gift folds in org gifts (primary-contact|advisor|current-principal); disjoint via donor XOR; all paths filter archived; org/hh totals unchanged.
- [anonymous funders/people visibility](wildflower-anonymous-visibility.md) — UI-only name hiding; canSeeIdentity (display) vs canManageIdentity (toggle) must stay separate; join-projection name refs aren't masked.
- [Entity-merge cascade-delete lock](merge-entity-cascade-lock.md) — merge txn must SELECT...FOR UPDATE the funder/person rows before reassign+delete; cascade FKs otherwise lose concurrent child inserts.
- [merge-config FK inventory test](merge-config-inventory-drift.md) — any new table FK→organizations/people must be added to mergeEntities *_FK_REFS (or EXPECTED_FK_OMISSIONS); a test derives the expected set from schema & fails on drift.
- [Bulk owner-reassignment column coverage](owner-reassignment-column-coverage.md) — offboarding must move every owner/assignee FK to users (incl. grant_leads.assignee) but preserve provenance FKs (createdBy/author/etc); no inventory test guards the set.
- [Potential-duplicates queue](potential-duplicates-queue.md) — admin dup detection (name pg_trgm + shared phone); phone bonus must apply ONCE per pair (dedupe self-join), dismiss persists canonicalized ids.
- [Canonical person display-name SQL](person-name-display-sql.md) — chain is preferred(nickname)+last → full → first+last, one shared helper; UI label "Preferred name", field stays nickname; ILIKE exempt.
- [Wildflower Foundation org vs entity](wildflower-foundation-org-vs-entity.md) — Foundation is both an organizations row (where staff hold roles) and an entities slug (fund attribution); don't cross them.

## Lists, pages, dashboards

- [wildflower-crm detail routes](wildflower-crm-routes.md) — organizations live at /organizations (was /funding-entities); pledge detail inherits opportunity.
- [List-page default sort order](list-page-default-order.md) — server default order must mirror the displayed personDisplayName + end with an id tiebreaker (stable offset pagination).
- [Weighted projection tile](wildflower-weighted-projection.md) — dashboard projection = received + committed + weighted open asks; committed is per-pledge UNPAID remainder (nets payments out of pledge allocation, clamped); don't revert to full pledge.
- [FY Report page](fy-report-page.md) — lists records behind the dashboard goal bar; report route must mirror fyMetricsFor bucket semantics in lockstep or totals stop reconciling; entity scope from global header filter.
- [Fundable projects page](fundable-projects-page.md) — management moved off Admin to /fundable-projects; timeframes+goal columns nullable; progress = sum gift_allocations.sub_amount per project.
- [wildflower-crm activity feed scoping](wildflower-activity-feed-scoping.md) — keep notes/tasks scope separate from donor-relationship scope; API list filters AND together.
- [Bulk-action by-id load gate](bulk-action-load-gate.md) — dialogs resolving selection by id must block submit until loaded==expectedCount (selection size), else partial subset silently runs.

## Tasks, intelligence, ingestion, admin

- [task intelligence](task-intelligence.md) — AI next-step suggestions in Tasks card; auto-generate ONLY on true first view (hasAnyProposal=false), never regenerate after accept/dismiss; refresh is explicit.
- [Reporting-deadline donor filter](reporting-deadline-donor-filter.md) — reporting_deadline tasks carry only opportunityIds; donor filter must EXISTS through the linked opportunity, not the task entity arrays.
- [media-mention GDELT dedupe](media-ingest-dedupe.md) — dedupe must stay DB-atomic ON CONFLICT upsert; manual script goes through the lock; never AI-summarize auto headlines.
- [Airtable→schools sync & school-recipient FK](school-sync-recipient-fk.md) — school recipient is allocation-level ONLY; sync upserts before stale-check so an error status can hide already-synced data; token prefers AIRTABLE_API_TOKEN.
- [Cleanup queue flag-for-research](cleanup-queue-flag-for-research.md) — SOLE research-flag path; polymorphic targetType (new type needs targetHref case); idempotent cleanup_nr_<targetId>; retired free-text notes need a DISTINCT reason_code or ON CONFLICT drops them ([issues_to_address](issues-to-address-cleanup-queue.md)).
- [Audit log recording model](audit-log-recording-model.md) — atomic recordAudit(tx) for in-tx writes (archive/bulk/merge); non-throwing safeRecordAudit after standalone create/PATCH so audit never breaks a save; admin-gated.
