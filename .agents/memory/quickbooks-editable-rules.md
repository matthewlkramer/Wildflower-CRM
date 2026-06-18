---
name: QuickBooks editable handling rules
description: DB-backed admin-editable QB ingest rules engine that mirrors the code classifier; auto_create_approve rule type; GenOps semantics.
---

# QuickBooks editable handling rules

The ~11 hardcoded "exclude as noise" QB rules are now an admin-editable, DB-backed
ordered list (`quickbooks_handling_rules`). An engine (`evaluateRules`) drives the
**ingest path only** (`syncQuickbooks`); enabled rules are sorted by ascending
priority, first match wins.

## The two-source rule: engine vs. code classifier must stay in lockstep
- The code classifier (`quickbooksExclusionRules.ts`) is kept **INTACT** — it still
  backs the manual `reclassifyStagedPayments` maintenance path, which is out of
  scope for editing.
- `SEED_RULES` in `quickbooksRules.ts` is the TS source of truth that reproduces the
  classifier exactly. A fidelity test (`quickbooks-rules-fidelity.test.ts`) asserts
  `evaluateRules(SEED_RULES, input) === classifyStagedPayment(input)` over fixtures.
- **Why:** two independent representations of the same behavior will silently drift.
- **How to apply:** any change to exclusion behavior must update BOTH the classifier
  and the seed (and the idempotent migration that seeds prod) in lockstep, or the
  fidelity test fails. This mirrors the existing TS↔SQL classifier/backfill lockstep.

## Changing a rule's behavior needs a persisted-row migration, NOT just code
- The ingest path (`syncQuickbooks` → `loadHandlingRules` → `evaluateRules`) reads
  the DB `quickbooks_handling_rules` rows, **NOT** `SEED_RULES`. `SEED_RULES` is only
  (a) the seed source for the 0040 migration, (b) the fidelity-test reference, and
  (c) the classifier behind the manual reclassify path. So a code / `SEED_RULES`
  change alone does **NOT** change what NEW prod pulls do.
- **Why:** Publish/drizzle ships schema + code but never edits data rows, so the
  seeded rule row stays frozen at whatever the last migration wrote (0040 seeded
  `seed_earned_income` with only the 4020 condition — memo broadening was invisible
  in prod until a migration updated the row). The architect caught this; it's a trap.
- **How to apply:** broadening/narrowing an exclude rule = classifier + `SEED_RULES`
  + fidelity fixture + an idempotent migration that **(Part A)** UPDATEs the
  persisted `quickbooks_handling_rules` row so new pulls pick it up AND **(Part B)**
  backfills the existing queue. Guard the Part A UPDATE on the rule's FULL canonical
  seed shape (conditions jsonb-equality + action + exclusion_reason + donation_guard
  + match_logic) so an admin's edits are never clobbered and re-runs are no-ops.

## auto_create_approve action
- New rule action that mints a gift, **allocates it**, links it as the matched gift,
  and lands the staged row in the auto (approved + auto-applied) queue.
- The plain QB mint path creates a gift header only — auto_create MUST also create
  the allocation or the gift is invalid (allocation FK is RESTRICT, every gift needs
  >=1 allocation).
- Fail-safe: if the target org or project can't be resolved, leave the row in manual
  review rather than minting an invalid gift.
- First instance: AmazonSmile → Amazon / Amazon Foundation org, allocate GenOps.

## GenOps is intended_usage, not a project row
- "GenOps" = allocation `intendedUsage='gen_ops'`. There is **no** `fundable_projects`
  row for it. An auto_create rule stores `targetOrganizationId` + `targetIntendedUsage`
  + a **nullable** `targetFundableProjectId` (only set when usage='project').

## Engine ExclusionReason is the narrow classifier subset
- The engine's `ExclusionReason` type (from `quickbooksExclusionRules.ts`) is narrower
  than the full `StagedPaymentExclusionReason` (no `other` / `intercompany_transfer`).
  Seed/exclude-rule reasons must use only the classifier subset; the admin UI may
  offer the wider DB enum for manually-authored exclude rules.

## Other notes
- Edits apply to NEW incoming payments only — never re-run against already-queued rows.
- Admin-gated CRUD+reorder in `routes/quickbooksRules.ts` (requireAdmin via role check).
- `quickbooks_handling_rules.target_organization_id` is an org FK — it's registered in
  `mergeEntities.ts` ORGANIZATION_FK_REFS so entity merges reassign it.
