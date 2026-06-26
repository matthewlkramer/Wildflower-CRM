---
name: Allocation restriction model + percent/footer total guard
description: Domain rules and gotchas for the opportunity/pledge & gift allocation editors (restriction flags, displayUsage, percent math, create-vs-update bodies).
---

# Allocation editors (pledge + gift)

## Restriction model is THREE AXES (Task #449 — replaced the old flags)
- Both `pledge_allocations` AND `gift_allocations` now carry three independent
  `restriction_axis` columns: `regionalRestrictionType` / `usageRestrictionType` /
  `timeRestrictionType`, each `donor_restricted | wf_restricted | unrestricted`
  (NOT NULL default `unrestricted`).
- A line codes as restricted (→ 4100.x object code) when **ANY** axis is
  `donor_restricted`; `wf_restricted` (internal WF designation) and `unrestricted`
  both code unrestricted (`anyDonorRestricted` in `@workspace/api-zod`).
- The OLD flags (`formallyRestricted` on pledge; `formalFundUseRestriction` +
  `formalRegionalRestriction` on gift) and the `restriction_type` enum are
  `@deprecated` (kept physical for the deprecate-then-drop window; backfill in
  `lib/db/migrations/0082`).
- **Coding moved off allocations** — the revenue-coding snapshot (object code +
  override, revenue location + override, revenue class + override, coding flags,
  deferred revenue + reason) is now derived-on-demand (preview via
  `deriveRevenueCoding`) and captured onto `staged_payments`, NOT persisted on
  allocations.
- **Grant conditions moved onto `pledge_allocations`** (`conditional` +
  `conditionsMet`); the opportunity header exposes a derived read-only rollup
  (`deriveConditionalRollup`) driving win-probability (conditional pledge 0.7500 vs
  0.9000). Old header `conditional`/`conditions`/`conditionsMet` are write-deprecated.

## displayUsage is trigger-maintained — never write it
- `gift_allocations.displayUsage` is a denormalized label maintained by a DB trigger. The client must never include it in any create/update body or form state. Use it read-only (e.g. as a Usage fallback when only a school recipient is set).

## Percent / footer math must normalize the parent total
- Allocation "% of total" and the footer "remaining/over-allocated" use the parent total: opportunity `awardedAmount ?? askAmount`, gift `amount`. **That total is frequently null, and can be 0.**
- Normalize to null when not strictly `> 0` BEFORE computing percent or remaining, otherwise a 0/negative total renders a misleading "Fully allocated"/"Over-allocated" instead of a neutral "Total allocated", and percent shows nonsense.
- **How to apply:** `const total = raw != null && raw > 0 ? raw : null;` then guard every percent/remaining branch on `total != null`.

## Create-vs-update body convention (whole CRM, not just allocations)
- POST / `Create*Body` fields are non-nullable optionals → **omit** empty fields (sending `null` fails Zod validation).
- PATCH / `Update*Body` fields are nullable → **send explicit `null`** to clear a field.
- Booleans are always sent in both directions.
- Allocation amounts are non-negative: a negative parses to null (omit on create / clear on edit), matching the old create-path `>= 0` filter.
