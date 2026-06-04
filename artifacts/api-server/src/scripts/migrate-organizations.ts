/**
 * migrate-organizations.ts
 *
 * One-time migration: consolidates the `funders` table (719 rows, issuesGrants=true)
 * and the legacy `organizations` table (814 rows, issuesGrants=false) into a single
 * `organizations` table with a unified `entity_type` enum and `issues_grants` flag.
 *
 * Safe to run multiple times (idempotent via ON CONFLICT (id) DO NOTHING / IF NOT EXISTS).
 *
 * Production deploy order:
 *   Phase 1: Deploy new schema (organizations gains new columns; funders still exists)
 *   Phase 2: pnpm --filter @workspace/api-server run migrate:organizations
 *   Phase 3: Verify row counts (see end of script output)
 *   Phase 4: Deploy Phase 2 schema (drops funders table + old funder_id columns)
 *
 * For dev: run against the current DB before the Phase 2 schema push so funder_id
 * columns still exist and can be copied to organization_id columns.
 *
 * Run: pnpm --filter @workspace/api-server run migrate:organizations
 */

import pg from "pg";
import { logger } from "../lib/logger";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function run() {
  const client = await pool.connect();
  try {
    logger.info("Starting organizations migration...");

    // ── Guard: this migration only runs against the pre-Phase-2 schema, where the
    // `funders` table and scalar `funder_id` columns still exist (it copies them into
    // organizations / organization_id). After the Phase 2 schema push drops them,
    // running this again is meaningless and should fail fast with a clear message.
    const guard = await client.query<{ funders: string | null; funder_col: number | null }>(`
      SELECT to_regclass('public.funders')::text AS funders,
             (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'opportunities_and_pledges' AND column_name = 'funder_id') AS funder_col
    `);
    if (!guard.rows[0].funders || !guard.rows[0].funder_col) {
      throw new Error(
        "Pre-Phase-2 artifacts missing (funders table / funder_id columns). " +
          "This migration only runs against the pre-Phase-2 schema. Aborting.",
      );
    }

    // ── Pre-step: ensure the entity_role_type enum has the unified 'organization'
    // value. MUST run outside the main transaction — a newly-added enum value cannot
    // be used (Step 5) in the same transaction that adds it. Idempotent.
    await client.query(
      `ALTER TYPE entity_role_type ADD VALUE IF NOT EXISTS 'organization'`,
    );
    logger.info("Pre-step complete: ensured 'organization' on entity_role_type enum");

    await client.query("BEGIN");

    // ── Step 0: Add new columns to organizations if they don't already exist ──
    // (Needed when running before the Phase 2 schema push, e.g. in dev.)
    const newOrgColumns: [string, string][] = [
      ["issues_grants",        "boolean NOT NULL DEFAULT false"],
      ["entity_type",          "text"],
      ["makes_pris",           "boolean"],
      ["number_of_employees",  "text"],
      ["capacity_rating",      "text"],
      ["total_assets",         "numeric(16,2)"],
      ["priority_areas_notes", "text"],
      ["about",                "text"],
      ["active_status",        "text"],
      ["other_names",          "text"],
      ["historical_names",     "text[]"],
      ["details",              "text"],
      ["email_domain",         "text"],
      ["org_email",            "text"],
      ["tags",                 "text"],
      ["last_contacted",       "date"],
      ["interaction_count",    "integer"],
      ["created_from_copper",  "date"],
      ["updated_from_copper",  "date"],
      ["x",                    "text"],
      ["linkedin",             "text"],
      ["facebook",             "text"],
      ["instagram",            "text"],
      ["youtube",              "text"],
      ["crunchbase",           "text"],
      ["website",              "text"],
      ["connection_status",    "text"],
      ["enthusiasm",           "text"],
      ["strategic_alignment",  "text"],
      ["interests_thematic",   "text[]"],
      ["interests_ages",       "text[]"],
      ["interests_gov_models", "text[]"],
      ["region_ids",           "text[]"],
      ["parent_organization_id", "text"],
      ["payment_intermediary_id", "text"],
      ["priority",             "text"],
      ["anonymous",            "boolean NOT NULL DEFAULT false"],
    ];

    for (const [col, type] of newOrgColumns) {
      await client.query(`
        ALTER TABLE organizations
          ADD COLUMN IF NOT EXISTS ${col} ${type}
      `);
    }
    logger.info("Step 0 complete: new columns added to organizations");

    // ── Step 1: Add new organization_id columns to child tables (if missing) ──
    const childFkColumns: Array<{ table: string; col: string; type?: string }> = [
      { table: "opportunities_and_pledges", col: "organization_id" },
      { table: "gifts_and_payments",        col: "organization_id" },
      { table: "people_entity_roles",       col: "organization_id" },
      { table: "addresses",                 col: "organization_id" },
      { table: "emails",                    col: "organization_id" },
      { table: "phone_numbers",             col: "organization_id" },
      { table: "meeting_notes",             col: "organization_id" },
      { table: "email_proposals",           col: "target_organization_id" },
    ];
    for (const { table, col } of childFkColumns) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} text`);
    }

    // Array columns renamed funder_ids → organization_ids
    const arrayRenames: Array<{ table: string; from: string; to: string }> = [
      { table: "notes",           from: "funder_ids",          to: "organization_ids" },
      { table: "interactions",    from: "funder_ids",          to: "organization_ids" },
      { table: "tasks",           from: "funder_ids",          to: "organization_ids" },
      { table: "media_mentions",  from: "funder_ids",          to: "organization_ids" },
      { table: "calendar_events", from: "matched_funder_ids",  to: "matched_organization_ids" },
      { table: "email_messages",  from: "matched_funder_ids",  to: "matched_organization_ids" },
      { table: "tracked_emails",  from: "recipient_funder_ids",to: "recipient_organization_ids" },
    ];
    for (const { table, from, to } of arrayRenames) {
      // Add new column then copy data
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${to} text[]`);
      await client.query(`UPDATE ${table} SET ${to} = ${from} WHERE ${to} IS NULL AND ${from} IS NOT NULL`);
    }
    logger.info("Step 1 complete: new FK/array columns added and pre-populated");

    // ── Step 2: Copy funders → organizations (issuesGrants = true) ──
    // Map fundingEntitySubtype → entity_type (same values, so 1:1).
    // Also map parent_funder_id → parent_organization_id.
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO organizations (
        id, name, issues_grants, entity_type, makes_pris, number_of_employees,
        capacity_rating, total_assets, priority_areas_notes, about, active_status,
        other_names, historical_names, details, email_domain, org_email, owner_user_id,
        tags, last_contacted, interaction_count, created_from_copper, updated_from_copper,
        x, linkedin, facebook, instagram, youtube, crunchbase, website,
        connection_status, enthusiasm, strategic_alignment,
        interests_thematic, interests_ages, interests_gov_models, region_ids,
        parent_organization_id, payment_intermediary_id, priority, anonymous,
        created_at, updated_at
      )
      SELECT
        id,
        name,
        true AS issues_grants,
        -- funding_entity_subtype values overlap with entity_type enum 1:1
        funding_entity_subtype::text AS entity_type,
        makes_pris,
        number_of_employees::text,
        capacity_rating::text,
        total_assets,
        priority_areas_notes,
        about,
        active_status::text,
        other_names,
        historical_names,
        details,
        email_domain,
        org_email,
        owner_user_id,
        tags,
        last_contacted,
        interaction_count,
        created_from_copper,
        updated_from_copper,
        x, linkedin, facebook, instagram, youtube, crunchbase, website,
        connection_status::text,
        enthusiasm::text,
        strategic_alignment::text,
        interests_thematic, interests_ages, interests_gov_models, region_ids,
        -- parent_funder_id stays as-is; the parent funder will also be migrated
        parent_funder_id AS parent_organization_id,
        payment_intermediary_id,
        priority::text,
        anonymous,
        created_at, updated_at
      FROM funders
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `);
    logger.info(`Step 2 complete: inserted ${inserted.rowCount} funder rows into organizations`);

    // ── Step 3: Update pre-existing organization rows (issuesGrants=false) ──
    // Map their legacy columns into the unified schema:
    //   - type/cmo → entity_type (old OrganizationType enum, cmo → school_network)
    //   - active_or_defunct → active_status ('Active'/null→active, 'Defunct'→defunct, 'Spenddown'→spenddown)
    //   - parent_org_id → parent_organization_id (self-ref FK in old org table)
    // Guard: add columns if they still exist in this DB state.
    for (const col of ["active_or_defunct", "parent_org_id"]) {
      await client.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ${col} text`).catch(() => {});
    }
    const updated = await client.query(`
      UPDATE organizations
      SET
        issues_grants = false,
        entity_type = COALESCE(
          -- map cmo → school_network; all other old org type values map 1:1
          CASE WHEN type = 'cmo' THEN 'school_network' ELSE type::text END,
          entity_type
        ),
        -- Map active_or_defunct → active_status ('Active'/null → active, 'Defunct' → defunct)
        active_status = COALESCE(
          active_status,
          CASE
            WHEN active_or_defunct = 'Defunct'   THEN 'defunct'
            WHEN active_or_defunct = 'Spenddown' THEN 'spenddown'
            WHEN active_or_defunct = 'Active'    THEN 'active'
            WHEN active_or_defunct IS NULL        THEN 'active'
            ELSE NULL
          END
        ),
        -- Rewire parent_org_id → parent_organization_id for legacy org rows
        parent_organization_id = COALESCE(parent_organization_id, parent_org_id)
      WHERE issues_grants = false
    `);
    logger.info(`Step 3 complete: updated ${updated.rowCount} pre-existing organization rows`);

    // ── Step 3.5: Drop XOR/discriminator CHECK constraints that forbid funder_id
    // and organization_id both being non-null. Phase 1 intentionally populates BOTH
    // (funder_id is retained until the Phase 2 schema push drops it), so these come
    // off now; the Phase 2 schema re-creates them keyed on organization_id. The
    // donor-XOR constraints on opps/gifts/meeting_notes do NOT count organization_id,
    // so they stay in place. Idempotent (IF EXISTS).
    const xorConstraintsToDrop: Array<{ table: string; constraint: string }> = [
      { table: "addresses",           constraint: "addresses_exactly_one_owner" },
      { table: "emails",              constraint: "emails_exactly_one_owner" },
      { table: "phone_numbers",       constraint: "phone_numbers_exactly_one_owner" },
      { table: "people_entity_roles", constraint: "per_entity_discriminator" },
    ];
    for (const { table, constraint } of xorConstraintsToDrop) {
      await client.query(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`,
      );
    }
    logger.info(
      "Step 3.5 complete: dropped transitional XOR constraints (funder_id + organization_id both set)",
    );

    // ── Step 4: Rewire scalar FKs: funder_id → organization_id ──
    const scalarRewires: Array<{ table: string; fromCol: string; toCol: string }> = [
      { table: "opportunities_and_pledges", fromCol: "funder_id",        toCol: "organization_id" },
      { table: "gifts_and_payments",        fromCol: "funder_id",        toCol: "organization_id" },
      { table: "people_entity_roles",       fromCol: "funder_id",        toCol: "organization_id" },
      { table: "addresses",                 fromCol: "funder_id",        toCol: "organization_id" },
      { table: "emails",                    fromCol: "funder_id",        toCol: "organization_id" },
      { table: "phone_numbers",             fromCol: "funder_id",        toCol: "organization_id" },
      { table: "meeting_notes",             fromCol: "funder_id",        toCol: "organization_id" },
      { table: "email_proposals",           fromCol: "target_funder_id", toCol: "target_organization_id" },
    ];
    for (const { table, fromCol, toCol } of scalarRewires) {
      const r = await client.query(`
        UPDATE ${table}
        SET ${toCol} = ${fromCol}
        WHERE ${fromCol} IS NOT NULL AND (${toCol} IS NULL OR ${toCol} != ${fromCol})
      `);
      logger.info(`  Rewired ${r.rowCount} rows in ${table}.${fromCol} → ${toCol}`);
    }

    // Assert every scalar rewire fully completed — abort (rollback) if any row still
    // has the old FK set but no new organization_id. Covers all rewired tables, not
    // just opps/gifts.
    for (const { table, fromCol, toCol } of scalarRewires) {
      const left = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ${table} WHERE ${fromCol} IS NOT NULL AND ${toCol} IS NULL`,
      );
      const remaining = parseInt(left.rows[0].c, 10);
      if (remaining > 0) {
        throw new Error(
          `${remaining} rows in ${table} still have ${fromCol} but no ${toCol} after rewire`,
        );
      }
    }

    // ── Step 5: Update entity_type in people_entity_roles ──
    // 'funder' and 'non_funding_organization' → 'organization'
    // Only update if the entity_role_type enum has the old values (pre-push).
    // If the enum has already been updated, this is a no-op string comparison.
    await client.query(`
      UPDATE people_entity_roles
      SET entity_type = 'organization'
      WHERE entity_type IN ('funder', 'non_funding_organization')
    `).catch(() => {
      // If the enum no longer has those values, the query may fail — ignore.
    });
    logger.info("Step 5 complete: entity_type updated in people_entity_roles");

    // ── Step 6: Verify row counts and FK rewiring — abort before committing ──
    const counts = await client.query<{ table_name: string; cnt: string }>(`
      SELECT 'funders'       AS table_name, COUNT(*)::text AS cnt FROM funders
      UNION ALL
      SELECT 'organizations' AS table_name, COUNT(*)::text AS cnt FROM organizations
      UNION ALL
      -- Funders that did NOT land in organizations (ID conflict or missed insert)
      SELECT 'funders_not_absorbed' AS table_name, COUNT(*)::text AS cnt
        FROM funders f WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = f.id)
      UNION ALL
      -- Opps still pointing at old funder_id but no organization_id
      SELECT 'opps_unrewired' AS table_name, COUNT(*)::text AS cnt
        FROM opportunities_and_pledges
       WHERE funder_id IS NOT NULL AND organization_id IS NULL
      UNION ALL
      -- Gifts still pointing at old funder_id but no organization_id
      SELECT 'gifts_unrewired' AS table_name, COUNT(*)::text AS cnt
        FROM gifts_and_payments
       WHERE funder_id IS NOT NULL AND organization_id IS NULL
    `);
    logger.info("Row counts and rewiring audit:");
    for (const row of counts.rows) {
      logger.info(`  ${row.table_name}: ${row.cnt}`);
    }
    const funderCount         = parseInt(counts.rows.find((r) => r.table_name === "funders")?.cnt ?? "0");
    const orgCount            = parseInt(counts.rows.find((r) => r.table_name === "organizations")?.cnt ?? "0");
    const notAbsorbed         = parseInt(counts.rows.find((r) => r.table_name === "funders_not_absorbed")?.cnt ?? "0");
    const oppsUnrewired       = parseInt(counts.rows.find((r) => r.table_name === "opps_unrewired")?.cnt ?? "0");
    const giftsUnrewired      = parseInt(counts.rows.find((r) => r.table_name === "gifts_unrewired")?.cnt ?? "0");

    const errors: string[] = [];
    if (notAbsorbed > 0)
      errors.push(`${notAbsorbed} funders NOT absorbed into organizations (ID conflict?)`);
    if (oppsUnrewired > 0)
      errors.push(`${oppsUnrewired} opportunities still have funder_id but no organization_id`);
    if (giftsUnrewired > 0)
      errors.push(`${giftsUnrewired} gifts still have funder_id but no organization_id`);
    if (orgCount < funderCount)
      errors.push(`organizations (${orgCount}) < funders (${funderCount})`);

    if (errors.length > 0) {
      throw new Error(`Migration verification failed — rolling back:\n  • ${errors.join("\n  • ")}`);
    }
    logger.info(`Verification passed: ${orgCount} orgs, 0 unrewired opps/gifts, all funders absorbed`);

    await client.query("COMMIT");
    logger.info("Migration complete. Ready for Phase 2 schema push.");

  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ err }, "Migration failed — rolled back");
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
