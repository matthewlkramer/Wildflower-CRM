---
name: Allocation restriction model + percent/footer total guard
description: Domain rules and gotchas for the opportunity/pledge & gift allocation editors (restriction flags, displayUsage, percent math, create-vs-update bodies).
---

# Allocation editors (pledge + gift)

## Restriction model is asymmetric — do NOT unify it
- `pledge_allocations` carries ONE flag: `formallyRestricted` → UI badge "Restricted" vs "Intent".
- `gift_allocations` carries TWO flags: `formalFundUseRestriction` + `formalRegionalRestriction` → "Use" / "Region" badges vs "Intent".
- **Why:** "formally restricted" means the grant letter legally restricts the money; unchecked means it's only our documented understanding of donor intent. Gifts distinguish use-vs-region restriction; pledges don't. They are intentionally separate columns — don't collapse them into one boolean.

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
