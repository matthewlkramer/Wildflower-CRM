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

## Two-phase rollout (important)

The DB migration is **staged**, decoupled from the schema-source rename:

- **Phase 1 (additive, run via `migrate:organizations` script):** ADDS `organizations` rows + `organization_id`/`organization_ids` columns and copies from the funder columns, but **KEEPS** the `funders` table and `funder_id` columns dual-populated. This lets the already-renamed app code run before the destructive drop. **Done on dev.** Not yet on prod.
- **Phase 2 (`when we're done`):** `drizzle push` to drop `funders` table + `funder_id` columns, re-add the XOR/owner CHECK constraints keyed on `organization_id`, convert `entity_type`/`enthusiasm` to enum types, apply `0001_drop_is_conditional`. Not yet run anywhere.

**Why the schema source can look "ahead" of the DB:** schema files (`lib/db/src/schema/`) are already fully unified (organizationIds, anonymous, priority, matchedOrganizationIds all present). If api-server typecheck reports those props "do not exist", it's **stale composite-lib declarations** — run `pnpm run typecheck` (builds libs first), not the leaf-only check.

## Phase-1 migration gotchas (cost real debugging)

- `ALTER TYPE entity_role_type ADD VALUE 'organization'` must run **outside** the transaction — a new enum value can't be used in the same tx that adds it.
- Must DROP 4 owner/discriminator CHECK constraints before rewiring (`addresses/emails/phone_numbers_exactly_one_owner`, `per_entity_discriminator`) because Phase 1 dual-populates `funder_id`+`organization_id` and they count `organization_id`. The donor-XOR on opps/gifts/meeting_notes do **not** count `organization_id`, so leave them. Phase 2 re-adds the dropped 4.
- Script is idempotent **only in the pre-Phase-2 schema state**; it guards by aborting if `funders`/`funder_id` are already gone.

## Still needed

- **Airtable importer** (`lib/db/src/import-airtable.mjs`) not yet updated — still targets old split schema; run will fail until updated
- **Production DB migration** not yet run — production still has old schema (needs Phase 1 then Phase 2, ideally same maintenance window)
- **issuesGrants filter** on Organizations list page not yet built
