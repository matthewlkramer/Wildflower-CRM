---
status: current-status
last_verified: 2026-09-12
---

# Individual and organization enrichment field audit

This audit records which editable CRM fields can be suggested safely from
existing evidence. Enrichment is suggestion-only: it never overwrites a
confirmed value, and acceptance remains an owner/admin decision.

## Shipped internal enrichers

| Entity       | Canonical field          | Evidence priority                                                                  | Confidence                                                                          | Decision                            |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| Person       | `current_home_region_id` | direct address; primary household address; current affiliated organization address | High when an address already links to a live region; medium for state-code fallback | Suggest only while blank            |

The CRM already stores canonical `city_region_id` and `state_region_id` links
on addresses, plus `state_code`. Those links are safer than guessing geography
from postal-code ranges and preserve the CRM's mixed city/state/metro taxonomy.
The service therefore uses the most precise live linked region first, then a
canonical state matching `state_code`. Unrecognized or incomplete addresses
produce no suggestion.

Organization `region_ids` means **funding interests**. Office addresses are
not evidence of those interests. Address-based organization suggestions are no
longer generated or accepted; existing suggestions remain dismissible for audit
history. Person home-region suggestions are unchanged.

## Reviewed, not safe to infer automatically yet

| Field                                                                             | Why it remains future work                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person `net_worth`                                                                | Requires a contracted wealth-screening provider, privacy review, match-confidence rules, and source licensing.                                                                                    |
| Person interests (`interests_thematic`, `interests_ages`, `interests_gov_models`) | Giving and affiliation categories are contextual evidence, not reliable statements of personal interest. A future proposal should expose supporting records and confidence.                       |
| Person `children_at_wf`                                                           | No canonical child-to-parent/school-enrollment relationship exists in the current schema. Free-text guessing would be unsafe.                                                                     |
| Person employer region                                                            | No canonical employer-region field exists. The current home-region enricher may use a current organization address only as lowest-priority evidence when personal/household addresses are absent. |
| Organization `entity_type` / sector                                               | External charity-registry matching needs a stable EIN or registry identifier, which is not currently a canonical organization field.                                                              |
| Addresses and social links                                                        | External lookup sources, overwrite policy, and identity-match thresholds must be selected before implementation.                                                                                  |

## External and bulk processing

`ENRICHMENT_EXTERNAL_ENABLED` defaults to false. A no-op integration seam is
present, but no external provider is configured and no external request is
made in either flag state. Enabling a real provider requires a separately
reviewed change.

There is no generic background-job queue whose retry, consent, and rate-limit
semantics fit bulk enrichment. Version 1 uses explicit per-record runs. A bulk
admin review can be added after the team has evaluated suggestion quality and
selected any external providers.
