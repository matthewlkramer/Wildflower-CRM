---
name: DAF sponsor donor attribution (soft warning, no auto-guard)
description: Community foundations DO issue direct grants; do not auto-rewrite DAF-sponsor donors. Surface a non-blocking UI warning instead.
---

A gift routed through a Donor-Advised Fund is *usually* better attributed to the
named **fund / donor advisor**, with the **DAF sponsor** (Fidelity / Schwab /
Vanguard Charitable) recorded as the gift's `payment_intermediary_id` (the
conduit). But this is a judgement call, not an invariant.

**Why the original auto-guard + historical cleanup was pulled:** a read-only prod
query disproved the premise. Pure DAF sponsors (Fidelity / Schwab / Vanguard /
T. Rowe Price Charitable) have **0 gifts as donor**. The only DAF-named orgs ever
used as donors are *community foundations* (Saint Paul & Minnesota Foundations,
East Bay Community Foundation) whose memos say "submitted proposal" / "applied /
approved" — i.e. legitimate **direct grants** under their own name. An automatic
rewrite (matcher guard or SQL repoint) would have corrupted real direct grants.

**How to apply:**
- Do **not** add a matcher guard that drops/rewrites a donor when it matches a
  `daf`-type intermediary, and do **not** ship a destructive historical-cleanup
  SQL that repoints donors. Both were implemented and then fully reverted.
- The chosen UX is a **soft, non-blocking warning** in the donor picker:
  `DafSponsorDonorWarning` in `artifacts/wildflower-crm/src/components/entity-picker.tsx`.
  It fires when the selected ORGANIZATION donor's name normalizes-equal to a
  `type='daf'` `payment_intermediaries` row, and just nudges the fundraiser to
  decide pass-through vs. direct grant. Rendered inside `DonorFieldPicker`
  (create forms, incl. the gift dialog) and `InlineEditDonor` (detail-page edits).
- Match is **normalized-exact** name equality (trim + lowercase + collapse
  whitespace), `daf` type only — never trigram/fuzzy (a near-name must not warn).
- DAF sponsors exist in the CRM as BOTH a `payment_intermediaries` row AND an
  `organizations` row, linked only by NAME (no FK between them).
