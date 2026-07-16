---
name: Legacy reconciliation — pointer-era archive
description: Retired topic files from the QB/Stripe pointer era (matched_gift_id / created_gift_id / group_reconciled_gift_id columns on staged_payments, etc.). These columns were DROPPED (migration 0126). Files here describe behaviour that no longer exists; read for regression context only, never as current instructions.
---

# Legacy reconciliation — pointer-era archive

**Why these are archived:** `staged_payments.matched_gift_id`, `created_gift_id`,
and `group_reconciled_gift_id` were dropped in migration 0126. The Stripe and
Donorbox equivalents (`stripe_staged_charges.matched/created_gift_id`,
`donorbox_donations.matched/created_gift_id`) are still physical but the QB
pointer model these files describe is retired. The active authority for
money-unit → CRM-gift linkage is the `payment_applications` ledger (counted
rows). See the active index (`money-sync-reconciliation.md`) for current rules.

## Retired files

| File | What it described |
|---|---|
| `quickbooks-staged-link.md` | Distinct matched/created gift columns on staged_payments; resolution-race guards using status='pending' UPDATE; partial-unique+NOT EXISTS/23505 patterns. |
| `reconciler-approvable-statuses.md` | "approvable = pending+approved"; mint double-count guard checking all 3 staged gift links: matched/created/groupReconciled. |
| `reconciliation-approve-outcomes.md` | QB staged row "owns" the gift via createdGiftId+autoApplied=false; Stripe charge always matchedGiftId evidence; create_gift NOT idempotent. |
| `reconciliation-resolved-predicate-four-forms.md` | "Is it booked?" via matched+created+group-reconciled+SPLIT (splits carry none of the 3 id cols). |
| `reconciliation-confirmed-relink.md` | match_confirmed not uniformly terminal; direct match = guarded relink via moveOwnApplication with legacy no-ledger fallback. |
| `unit-groups-dualwrite.md` | source_group_id retired; group state = unit_groups/unit_group_members; group_reconciled_gift_id described as separate column. |
| `raw-sql-pa-insert-guards.md` | Migration-file PA inserts guarded on matched_gift_id=target to prevent drift-window double-book. |
| `reconciliation-already-linked-picker.md` | Re-link pickers grayed candidates via COALESCE(matched/created/groupReconciled) (NOT PA ledger). |
| `stripe-charge-evidence-linkage.md` | "Marking a charge reconciled must ALSO set row-local matchedGiftId"; resolvedGift COALESCE + revert depend on it. |
| `stripe-failed-charge-exclusion.md` | Failed charges auto-excluded; exclusion-reason enum in 4 places; move-own-application path using ledger==matchedGiftId. |

## What replaced them

- **QB gift linkage:** `payment_applications` counted rows (`link_role='counted'`,
  `evidence_source='quickbooks'`). Mint ownership = `created_the_gift` bool.
  Group-reconciled = presence of `unit_group_members` row. Direct match = bare PA
  row with no unit_group_members membership.
- **Stripe/Donorbox gift linkage:** still live pointer columns (`matched_gift_id` /
  `created_gift_id` on the respective charge/donation tables). PA ledger dual-writes
  these rows but does NOT yet read them.
- **Approvability:** derived from exclusion_reason, auto_applied, PA counted rows,
  confirmed settlement links, and booked charge-tie facts — no stored gift-pointer
  columns involved.
- **Failed-charge terminal state:** `exclusion_reason = 'failed_charge'` → derived
  status `excluded`; terminal charges never receive a gift link by design.
