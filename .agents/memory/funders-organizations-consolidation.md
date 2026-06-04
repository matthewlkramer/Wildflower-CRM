---
name: funders→organizations consolidation
description: What changed when the funders and organizations tables were merged, and what still needs doing.
---

# Funders → Organizations Consolidation

**Why:** Wildflower wanted a single Organizations concept instead of the split Funders (grant-makers) vs Organizations (non-grant-making contacts). The `issuesGrants boolean` flag on the unified table distinguishes them.

## What changed

- DB: `organizations` table absorbs 719 funder rows (`issuesGrants=true`); all FK columns renamed `funder_id→organization_id`, `parent_funder_id→parent_organization_id`; text[] slug arrays renamed `funder_ids→organization_ids`, `matched_funder_ids→matched_organization_ids`, `recipient_funder_ids→recipient_organization_ids`
- API: all `/api/funders` routes → `/api/organizations`; `DonorType` "funder"→"organization"; `EntityRoleType` removes `non_funding_organization`
- Frontend: nav item "Funding Entities"→"Organizations", route `/organizations`, hooks `useListOrganizations` etc., `InlineEditFunderPicker`→`InlineEditOrganizationPicker`, `displayFunderName`→`displayOrganizationName`, `activeFunderNames`→`activeOrganizationNames`

## How to apply

- Any new code dealing with funding entities uses `organizations` table and `issuesGrants` flag
- Donor XOR fields are `organizationId | individualGiverPersonId | householdId` (no more `funderId`)
- Meeting-notes contact XOR fields: `organizationId | personId | householdId`

## Still needed

- **Airtable importer** (`lib/db/src/import-airtable.mjs`) not yet updated — still targets old split schema; run will fail until updated
- **Production DB migration** not yet run — production still has old schema
- **issuesGrants filter** on Organizations list page not yet built (follow-up task #152)
