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
- **Phase 2 (`lib/db/migrations/0002_finalize_organizations.sql`, applied via `psql -1 -v ON_ERROR_STOP=1`):** drops `funders` table + ALL `funder_*` columns, re-adds the 7 XOR/owner/discriminator CHECK constraints keyed on `organization_id`, converts `entity_type`/`enthusiasm` text→enum (enthusiasm uses a legacy-text→7-point CASE map; `people` drops the old text col and renames `enthusiasm_enum`→`enthusiasm`), and trims `entity_role_type` to its 3 live values. Idempotent (DO-block guards). **Done on dev (2026-06-04).** Not yet on prod. `0001_drop_is_conditional.sql` also **applied on dev**, not prod.

**Why the schema source can look "ahead" of the DB:** schema files (`lib/db/src/schema/`) are already fully unified (organizationIds, anonymous, priority, matchedOrganizationIds all present). If api-server typecheck reports those props "do not exist", it's **stale composite-lib declarations** — run `pnpm run typecheck` (builds libs first), not the leaf-only check.

## Phase-1 migration gotchas (cost real debugging)

- `ALTER TYPE entity_role_type ADD VALUE 'organization'` must run **outside** the transaction — a new enum value can't be used in the same tx that adds it.
- Must DROP 4 owner/discriminator CHECK constraints before rewiring (`addresses/emails/phone_numbers_exactly_one_owner`, `per_entity_discriminator`) because Phase 1 dual-populates `funder_id`+`organization_id` and they count `organization_id`. The donor-XOR on opps/gifts/meeting_notes do **not** count `organization_id`, so leave them. Phase 2 re-adds the dropped 4.
- Script is idempotent **only in the pre-Phase-2 schema state**; it guards by aborting if `funders`/`funder_id` are already gone.

## Still needed

- **Airtable importer** (`lib/db/src/import-airtable.mjs`) not yet updated — still targets old split schema (writes a `funders` table that no longer exists); a re-import will fail until updated. `lib/db/SCHEMA.md` is likewise stale (still documents the split funders/organizations model).
- **Production DB migration** not yet run — production still has the old split schema. To bring prod to dev's state it needs Phase 1 (`migrate:organizations`) THEN `0001_drop_is_conditional.sql` THEN Phase 2 (`0002_finalize_organizations.sql`), ideally one maintenance window. Dev is fully consolidated; prod is not.
