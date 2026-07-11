---
name: Failed Stripe charges are mirrored but auto-excluded
description: How failed charges (bounced ACH) are kept in stripe_staged_charges without ever surfacing as real money; plus the hand-copied exclusion-reason union that drifts.
---

**Rule:** charges whose raw Stripe status is `failed` (bounced ACH debits — Stripe retries create a NEW charge id) must stay in `stripe_staged_charges` (mirror is 1:1 with Stripe) but are classified `excluded` / `failed_charge` so they never look like money. Three enforcement points, all needed:

1. Ingest: staged directly as excluded; auto-apply (gift linking) skipped.
2. Upsert on-conflict CASE: a still-`pending`, `classification_source='auto'` row flips to excluded when a later sync sees raw status failed (ACH can bounce days after staging). A manual re-include pin (`classification_source='manual'`) is respected.
3. Revert route: unlinking a failed charge lands it in `excluded`, not back in `pending`.

**Why:** a failed $513.08 ACH was staged as pending and human-confirmed onto a gift while its successful retry sat in the queue — double-count risk baked into a bulk confirm pass.

**Drift trap:** `StagedPaymentExclusionReason` exists in FOUR places that must move together: the pg enum (`_enums.ts`), the OpenAPI spec enum, the UI label map (`EXCLUSION_REASON_LABELS`, Record type forces it), and a HAND-COPIED string union near the top of `reconciliationBundleProposal.ts` — typecheck catches the copy only when a value actually flows through it. Auto-only reasons (failed_charge, processor_payout, legacy) are deliberately NOT in `MANUAL_EXCLUSION_FAMILIES`.

**How to apply:** adding any exclusion reason → touch all four sites; anything Stripe-money-shaped must check raw charge status before treating a staged charge as bookable.
