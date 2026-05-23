// Bulk importer: reads /tmp/airtable-dump/*.json and loads into Postgres.
// Uses airtable record IDs (recXXXXXXXX) as primary keys for every table
// EXCEPT `regions`, where the PK is a human-readable slug derived from the
// region's name + the names of its included-type ancestors (continent /
// country / state / city / neighborhood). Intermediate aggregation layers
// (multi_state_region, region_within_state, metro_area) appear in the
// region's own slug only and never in the slugs of their descendants, so
// adding or removing a wrapper layer never disturbs city/state slugs. A
// rec→slug map is built at region-insert time and used to translate every
// region reference in the rest of the import.
import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DUMP = "/tmp/airtable-dump";
const load = (name) => JSON.parse(fs.readFileSync(`${DUMP}/${name}.json`, "utf8"));

const first = (v) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// Normalize legacy grant-year codes (FY24 → fy2024, "Future" → future) into
// fiscal_years.id slugs.
const normalizeFy = (gy) => {
  if (gy == null) return null;
  if (/^FY\d{2}$/.test(gy)) return "fy20" + gy.slice(2);
  if (gy === "Future") return "future";
  return String(gy).toLowerCase();
};
// Extract the single FY value expected on per-row money bookings
// (pledge_allocations, gifts_and_payments, gift_allocations). If Airtable
// ever returns a multi-value array for one of these fields, fail loudly
// rather than silently dropping the extras — the schema only allows one
// fiscal year per allocation row, and the right resolution is to split
// the source record into multiple allocation rows, not to hide data.
const singleFy = (v, ctx) => {
  if (v == null) return null;
  if (Array.isArray(v)) {
    if (v.length > 1) {
      throw new Error(
        `${ctx}: expected single fiscal-year value, got ${v.length} (${JSON.stringify(v)}). ` +
          `Multi-year bookings must be split across multiple allocation rows.`,
      );
    }
    return normalizeFy(v[0] ?? null);
  }
  return normalizeFy(v);
};

// Region types that contribute their name to descendants' slugs. The four
// excluded types (multi_state_region, region_within_state, metro_area, and
// untyped rows) only appear in their own slug as the last segment, so a
// "Greater Boston" wrapper between Massachusetts and Boston doesn't change
// Boston's slug.
const SLUG_INCLUDED_REGION_TYPES = new Set([
  "continent", "country", "state", "city", "neighborhood",
]);
const slugify = (s) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

const regionTypeMap = {
  City: "city", Country: "country", State: "state", "Metro Area": "metro_area",
  "Region (within a state)": "region_within_state",
  "Multi-state Region": "multi_state_region",
  Neighborhood: "neighborhood", Continent: "continent",
};
const entityTypeMap = {
  Funder: "funder", "Non-funding organization": "non_funding_organization",
  Household: "household", "Payment intermediary": "payment_intermediary",
};
const personRoleCurrentMap = { current: "current", past: "past" };
const contactCurrentMap = { Active: "active", Inactive: "inactive" };
const oppStatusMap = { Open: "open", Won: "won", Dormant: "dormant", Lost: "lost" };
const paStatusMap = {
  Working: "working", Committed: "committed", Superseded: "superseded",
  "Committed with conditions": "committed_with_conditions",
};
const piTypeMap = { DAF: "daf", "Giving Platform": "giving_platform" };

// ---- Enum normalization maps ----
const fundingEntitySubtypeMap = {
  family_foundation: "family_foundation",
  institutional_foundation: "institutional_foundation",
  corporate_foundation: "corporate_foundation",
  community_foundation: "community_foundation",
  bank_foundation: "bank_foundation",
  family_office_trust: "family_office_trust",
  intermediary: "intermediary",
  government: "government",
  nonprofit: "nonprofit",
  corporation: "corporation",
  capital_provider: "capital_provider",
  philanthropic_advisor: "philanthropic_advisor",
  cdfi: "cdfi",
  education_forprofit: "education_forprofit",
  competition: "competition",
  "public/private": "public_private",
  daf_platform: "daf_platform",
  platform: "platform",
};
const numberOfEmployeesMap = {
  "1": "e_1",
  "2-10": "e_2_10",
  "11-50": "e_11_50",
  "51-250": "e_51_250",
  "251-1000": "e_251_1000",
  "1001-10000": "e_1001_10000",
  "10000+": "e_10000_plus",
};
const orgTypeMap = {
  "Advocacy/Membership/Lobbyist": "advocacy_membership_lobbyist",
  Authorizer: "authorizer",
  CMO: "cmo",
  "Capital Provider": "capital_provider",
  "City/County/State/Federal Government": "government",
  Corporation: "corporation",
  "Education vendor": "education_vendor",
  "Elected Official": "elected_official",
  "Higher ed": "higher_ed",
  Investor: "investor",
  "Law Firm": "law_firm",
  Media: "media",
  Nonprofit: "nonprofit",
  "Philanthropic Advisor": "philanthropic_advisor",
  "Real Estate": "real_estate",
  School: "school",
  "School District": "school_district",
  "School network": "school_network",
  "Small business / consulting practice": "small_business_consulting",
  Tribal: "tribal",
};
const oppTypeMap = {
  Solicitation: "solicitation",
  Renewal: "renewal",
  "Open application": "open_application",
};
const oppStageMap = {
  "Cold Lead - 0%": "cold_lead",
  "Warm Lead - 5%": "warm_lead",
  "In conversation - 20%": "in_conversation",
  "Convince - 40%": "convince",
  "Conditional commitment - 50%": "conditional_commitment",
  "Probable Renewal - 75%": "probable_renewal",
  "Verbal commitment - 90%": "verbal_commitment",
  "Written commitment - 100%": "written_commitment",
  "Cash in - 100%": "cash_in",
};
const oppConditionalMap = {
  Unconditional: "unconditional",
  Reimbursable: "reimbursable",
  "Conditional on funder determination of progress": "conditional_on_funder_determination",
  "Conditional on meeting specific target": "conditional_on_target",
};
const giftTypeMap = {
  "Standard gift": "standard_gift",
  "Pledge payment": "pledge_payment",
  "Loan fund investment": "loan_fund_investment",
};
const giftPaymentMethodMap = {
  ACH: "ach",
  check: "check",
  wire: "wire",
  stock: "stock",
  donor_box: "donor_box",
  daf_ACH: "daf_ach",
  daf_check: "daf_check",
  "daf_bill.com": "daf_bill_com",
};

// Maps "directed gift" / "matching gift" long descriptions to the short enum.
function mapGiftType(v) {
  if (!v) return null;
  if (giftTypeMap[v]) return giftTypeMap[v];
  const s = String(v).toLowerCase();
  if (s.startsWith("directed gift")) return "directed_gift";
  if (s.startsWith("matching gift")) return "matching_gift";
  return null;
}

// Canonical fund entities. Keys are slug ids; the array lists every raw value
// seen in Airtable that should map to that entity.
const ENTITY_DEFS = [
  { id: "wildflower_foundation", name: "Wildflower Foundation",
    aliases: ["Wildflower Foundation"] },
  { id: "black_wildflowers_fund", name: "Black Wildflowers Fund",
    aliases: ["Black Wildflowers Fund", "Black Wildflowers"] },
  { id: "sunlight_debt", name: "Sunlight - debt",
    aliases: ["Sunlight - debt", "Sunlight Debt"] },
  { id: "sunlight_grants", name: "Sunlight - grants",
    aliases: ["Sunlight - grants", "Sunlight Grants"] },
  { id: "observation_support_tech",
    name: "Observation Support Technologies / Observant Education",
    aliases: ["Observation Support Technologies / Observant Education"] },
  { id: "tierra_indigena", name: "Tierra Indigena", aliases: ["Tierra Indigena"] },
  { id: "embracing_equity", name: "Embracing Equity", aliases: ["Embracing Equity"] },
  { id: "rising_tide", name: "Rising Tide", aliases: ["Rising Tide"] },
  { id: "sunlight_equity", name: "Sunlight - equity",
    aliases: ["Sunlight - equity", "Sunlight - Equity"] },
];
const entityAliasToId = new Map();
for (const e of ENTITY_DEFS) for (const a of e.aliases) entityAliasToId.set(a, e.id);

// Canonical fundable projects. Keys are slug ids; the array lists every raw
// Airtable intended_usage value that should map to that project.
const FUNDABLE_PROJECT_DEFS = [
  { id: "mdd", name: "MDD", aliases: ["project_mdd"] },
  { id: "ssj", name: "SSJ", aliases: ["project_ssj"] },
  { id: "charter_growth", name: "Charter Growth", aliases: ["project_charter_growth"] },
  { id: "tsl", name: "TSL", aliases: ["project_tsl"] },
  { id: "observation_support_tech",
    name: "Observation Support Technologies",
    aliases: ["observation_support_tech"] },
];
const fundableProjectAliasToId = new Map();
for (const p of FUNDABLE_PROJECT_DEFS)
  for (const a of p.aliases) fundableProjectAliasToId.set(a, p.id);

// Maps every raw Airtable intended_usage string to the new enum value and,
// when relevant, an implied fundable_project_id. Anything not listed becomes
// (null, null).
const INTENDED_USAGE_MAP = {
  gen_ops: { iu: "gen_ops" },
  "General Operations": { iu: "gen_ops" },
  sunlight_operations: { iu: "gen_ops" },
  school_startup_grants: { iu: "school_startup" },
  "Specific School Passthrough": { iu: "school_startup" },
  "Seed Fund": { iu: "school_startup" },
  project: { iu: "project" },
  "Specific Project": { iu: "project" },
  project_mdd: { iu: "project", fp: "mdd" },
  project_ssj: { iu: "project", fp: "ssj" },
  project_charter_growth: { iu: "project", fp: "charter_growth" },
  project_tsl: { iu: "project", fp: "tsl" },
  observation_support_tech: { iu: "project", fp: "observation_support_tech" },
};
function mapIntendedUsage(raw) {
  const v = first(raw);
  if (v == null || v === "") return { intended_usage: null, fundable_project_id: null };
  const m = INTENDED_USAGE_MAP[v];
  if (!m) return { intended_usage: null, fundable_project_id: null };
  return { intended_usage: m.iu, fundable_project_id: m.fp ?? null };
}

async function batchInsert(table, columns, rows, batchSize = 200) {
  if (rows.length === 0) return;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders = [];
    const params = [];
    let p = 1;
    for (const row of slice) {
      const ph = columns.map(() => `$${p++}`);
      placeholders.push(`(${ph.join(",")})`);
      for (const col of columns) {
        let v = row[col];
        if (v === undefined) v = null;
        params.push(v);
      }
    }
    const sql = `INSERT INTO "${table}" (${columns
      .map((c) => `"${c}"`)
      .join(",")}) VALUES ${placeholders.join(",")} ON CONFLICT (id) DO NOTHING`;
    const r = await pool.query(sql, params);
    inserted += r.rowCount ?? 0;
  }
  console.log(`  inserted ${inserted}/${rows.length} into ${table}`);
}

async function batchInsertJunction(table, columns, rows, batchSize = 500) {
  if (rows.length === 0) return;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders = [];
    const params = [];
    let p = 1;
    for (const row of slice) {
      const ph = columns.map(() => `$${p++}`);
      placeholders.push(`(${ph.join(",")})`);
      for (const col of columns) params.push(row[col] ?? null);
    }
    const sql = `INSERT INTO "${table}" (${columns
      .map((c) => `"${c}"`)
      .join(",")}) VALUES ${placeholders.join(",")} ON CONFLICT DO NOTHING`;
    const r = await pool.query(sql, params);
    inserted += r.rowCount ?? 0;
  }
  console.log(`  inserted ${inserted}/${rows.length} into ${table}`);
}

// Validation helpers: filter junction rows to only those whose FK targets exist
async function existingIds(table) {
  const r = await pool.query(`SELECT id FROM "${table}"`);
  return new Set(r.rows.map((row) => row.id));
}

async function run() {
  console.log("=== Starting import ===");

  // Build name → user.id map so we can resolve legacy free-text `owner`
  // fields from Airtable to a real users.id FK. Users are pre-seeded via
  // populate-users-from-owners; unknown owner names resolve to null.
  const userByName = new Map();
  {
    const { rows } = await pool.query(
      `SELECT id, display_name FROM users WHERE display_name IS NOT NULL`,
    );
    for (const r of rows) userByName.set(r.display_name, r.id);
    console.log(`loaded ${userByName.size} users for owner lookup`);
  }
  const resolveOwner = (name) => (name ? userByName.get(name) ?? null : null);

  // 1. regions (deferred self-ref) — keyed by slug PK derived from the
  // region's name + its included-type ancestors. Builds a rec→slug map that
  // the rest of the importer uses to translate every region reference.
  const regions = load("regions");
  const regionByRecId = new Map(regions.map((r) => [r.id, r]));
  const recToSlug = new Map();
  const slugCollisions = new Map();
  function computeRegionSlugAndPath(rec) {
    const ancSlugParts = [];
    const dispParts = [];
    const seen = new Set();
    let cur = first(rec.fields.part_of);
    cur = cur ? regionByRecId.get(cur) : null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const t = regionTypeMap[cur.fields.type] ?? null;
      dispParts.unshift(cur.fields.name ?? "(unnamed)");
      if (SLUG_INCLUDED_REGION_TYPES.has(t)) {
        ancSlugParts.unshift(slugify(cur.fields.name ?? "(unnamed)"));
      }
      cur = first(cur.fields.part_of);
      cur = cur ? regionByRecId.get(cur) : null;
    }
    const ownSlug = slugify(rec.fields.name ?? "(unnamed)");
    return {
      slug: [...ancSlugParts, ownSlug].join("__"),
      displayPath: [...dispParts, rec.fields.name ?? "(unnamed)"].join(", "),
    };
  }
  for (const r of regions) {
    const { slug, displayPath } = computeRegionSlugAndPath(r);
    if (recToSlug.has(r.id)) continue;
    if (slugCollisions.has(slug)) {
      slugCollisions.get(slug).push(r.id);
    } else {
      slugCollisions.set(slug, [r.id]);
    }
    recToSlug.set(r.id, { slug, displayPath });
  }
  // Fail fast on collisions: silently merging distinct Airtable regions
  // into one slug would orphan refs in downstream tables. The caller must
  // resolve the source data (merge duplicates, rename ambiguous regions,
  // or add a state_abbreviation distinguisher) before re-running.
  const realCollisions = [...slugCollisions.entries()].filter(([, ids]) => ids.length > 1);
  if (realCollisions.length) {
    console.error(`ERROR: ${realCollisions.length} region slug collision(s):`);
    for (const [slug, ids] of realCollisions) {
      console.error(`  ${slug} ← ${ids.join(", ")}`);
    }
    throw new Error(
      `Region slug collisions detected; resolve the source data and re-run.`,
    );
  }
  // Insert one row per region (slugs are guaranteed unique above).
  const regionRows = [];
  for (const r of regions) {
    const m = recToSlug.get(r.id);
    regionRows.push({
      id: m.slug,
      name: r.fields.name ?? "(unnamed)",
      display_path: m.displayPath,
      state_abbreviation: first(r.fields.state_abbreviation) ?? null,
      type: regionTypeMap[r.fields.type] ?? null,
    });
  }
  await batchInsert(
    "regions",
    ["id", "name", "display_path", "state_abbreviation", "type"],
    regionRows,
  );
  console.log("regions: setting parent_region_id...");
  {
    const insertedSlugs = new Set(regionRows.map((r) => r.id));
    for (const r of regions) {
      const parentRec = first(r.fields.part_of);
      const childSlug = recToSlug.get(r.id)?.slug;
      const parentSlug = parentRec ? recToSlug.get(parentRec)?.slug : null;
      if (childSlug && parentSlug && insertedSlugs.has(parentSlug) && childSlug !== parentSlug) {
        await pool.query(
          `UPDATE regions SET parent_region_id=$1 WHERE id=$2`,
          [parentSlug, childSlug],
        );
      }
    }
  }
  // Helpers for translating Airtable region refs to slug PKs.
  const toRegionSlug = (recId) => (recId ? recToSlug.get(recId)?.slug ?? null : null);
  const toRegionSlugs = (recIds) =>
    arr(recIds).map(toRegionSlug).filter(Boolean);

  // 2. schools
  const schools = load("schools");
  await batchInsert(
    "schools",
    ["id", "name"],
    schools.map((r) => ({ id: r.id, name: r.fields.name ?? "(unnamed)" })),
  );

  // 3. households
  const households = load("households");
  await batchInsert(
    "households",
    ["id", "name"],
    households.map((r) => ({ id: r.id, name: r.fields.name ?? "(unnamed)" })),
  );

  // 4. payment_intermediaries — email moves to the `emails` table (FK
  // payment_intermediary_id); see step 4c below.
  const pis = load("payment_intermediaries");
  await batchInsert(
    "payment_intermediaries",
    ["id", "name", "type"],
    pis.map((r) => ({
      id: r.id,
      name: r.fields.name ?? "(unnamed)",
      type: piTypeMap[r.fields.type] ?? null,
    })),
  );

  // 4c. Synthetic emails for PIs (id = "pi-email-<piId>")
  const piEmailRows = pis
    .filter((r) => r.fields.org_email)
    .map((r) => ({
      id: `pi-email-${r.id}`,
      email: r.fields.org_email,
      payment_intermediary_id: r.id,
      validity: "unknown",
      is_preferred: true,
    }));
  await batchInsert(
    "emails",
    ["id","email","payment_intermediary_id","validity","is_preferred"],
    piEmailRows,
  );

  // 4b. entities (fund entities, seeded from canonical list)
  await batchInsert(
    "entities",
    ["id", "name", "active"],
    ENTITY_DEFS.map((e) => ({ id: e.id, name: e.name, active: true })),
  );

  // 4c. fundable_projects (seeded from canonical list)
  await batchInsert(
    "fundable_projects",
    ["id", "name", "active"],
    FUNDABLE_PROJECT_DEFS.map((p) => ({ id: p.id, name: p.name, active: true })),
  );

  // 5. funders (deferred parent self-ref)
  const funders = load("funders");
  await batchInsert(
    "funders",
    [
      "id","name","funding_entity_subtype","makes_pris","number_of_employees",
      "capacity_rating","national_priorities","priority_areas_notes","active_status","other_names",
      "details","email_domain","owner_user_id","tags","last_contacted","interaction_count",
      "created_from_copper","updated_from_copper","x","linkedin","facebook","instagram","youtube",
      "crunchbase","website","connection_status","enthusiasm","strategic_alignment",
      "interests_thematic","interests_ages","interests_gov_models",
    ],
    funders.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        name: f.name ?? "(unnamed)",
        funding_entity_subtype: fundingEntitySubtypeMap[f.funding_entity_subtype] ?? null,
        makes_pris: typeof f.makes_pris === "boolean" ? f.makes_pris : null,
        number_of_employees: numberOfEmployeesMap[f.number_of_employees] ?? null,
        capacity_rating: f.capacity_rating ?? null,
        national_priorities: typeof f.national_priorities === "boolean" ? f.national_priorities : null,
        priority_areas_notes: f.priority_areas_notes ?? null,
        active_status: f.active_status ?? null,
        other_names: f.other_names ?? null,
        details: f.details ?? null,
        email_domain: f.email_domain ?? null,
        owner_user_id: resolveOwner(f.owner),
        tags: Array.isArray(f.tags) ? f.tags.join(", ") : (f.tags ?? null),
        last_contacted: f.last_contacted ?? null,
        interaction_count: f.interaction_count ?? null,
        created_from_copper: f.created_from_copper ?? null,
        updated_from_copper: f.updated_from_copper ?? null,
        x: f.x ?? null, linkedin: f.linkedin ?? null,
        facebook: f.facebook ?? null, instagram: f.instagram ?? null,
        youtube: f.youtube ?? null, crunchbase: f.crunchbase ?? null,
        website: f.website ?? null,
        connection_status: f.connection_status ?? null,
        enthusiasm: f.enthusiasm ?? null,
        strategic_alignment: f.strategic_alignment ?? null,
        interests_thematic: arr(f.interests_thematic),
        interests_ages: arr(f.interests_ages),
        interests_gov_models: arr(f.interests_gov_models),
      };
    }),
  );
  console.log("funders: setting parent_funder_id...");
  {
    const ids = new Set(funders.map((r) => r.id));
    for (const r of funders) {
      const parent = first(r.fields.parent_funder);
      if (parent && ids.has(parent)) {
        await pool.query(`UPDATE funders SET parent_funder_id=$1 WHERE id=$2`, [parent, r.id]);
      }
    }
  }

  // 6. organizations — address fields live in the `addresses` table now, so
  // we insert orgs first, then synthesize an address row per org that has any
  // address data on the Airtable record.
  const orgs = load("organizations");
  await batchInsert(
    "organizations",
    ["id","name","type","email_domain","owner_user_id","website"],
    orgs.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        name: f.name ?? "(unnamed)",
        type: orgTypeMap[f.type] ?? null,
        email_domain: f.email_domain ?? null,
        owner_user_id: resolveOwner(f.owner),
        website: f.website ?? null,
      };
    }),
  );

  // 6b. Synthetic addresses for orgs (id = "org-addr-<orgId>")
  const orgAddrRows = orgs
    .filter((r) => {
      const f = r.fields;
      return f.street || first(f.city) || first(f.state) || f.postal_code || f.country;
    })
    .map((r) => {
      const f = r.fields;
      return {
        id: `org-addr-${r.id}`,
        street: f.street ?? null,
        city_region_id: toRegionSlug(first(f.city)),
        state_region_id: toRegionSlug(first(f.state)),
        postal_code: f.postal_code ?? null,
        country: f.country ?? null,
        organization_id: r.id,
      };
    });
  await batchInsert(
    "addresses",
    ["id","street","city_region_id","state_region_id",
     "postal_code","country","organization_id"],
    orgAddrRows,
  );

  // 7. people (no assistant link in data)
  const people = load("people");
  await batchInsert(
    "people",
    [
      "id","prefix","first_name","middle_name","last_name","full_name",
      "deceased","current_home_region_id","details","owner_user_id","tags","last_contacted",
      "interaction_count","created_from_copper","updated_from_copper","linkedin","x",
      "facebook","instagram","about_me","website","interests_thematic","interests_ages",
      "newsletter",
    ],
    people.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        prefix: f.prefix ?? null,
        first_name: f.first_name ?? null,
        middle_name: f.middle_name ?? null,
        last_name: f.last_name ?? null,
        full_name: f.full_name ?? null,
        deceased: !!f.deceased,
        current_home_region_id: toRegionSlug(first(f.current_home)),
        details: f.details ?? null,
        owner_user_id: resolveOwner(f.owner),
        tags: Array.isArray(f.tags) ? f.tags.join(", ") : (f.tags ?? null),
        last_contacted: f.last_contacted ?? null,
        interaction_count: f.interaction_count ?? null,
        created_from_copper: f.created_from_copper ?? null,
        updated_from_copper: f.updated_from_copper ?? null,
        linkedin: f.linkedin ?? null,
        x: f.x ?? null,
        facebook: f.facebook ?? null,
        instagram: f.instagram ?? null,
        about_me: f["about.me"] ?? null,
        website: f.website ?? null,
        interests_thematic: arr(f.interests_thematic),
        interests_ages: arr(f.interests_ages),
        newsletter: !!f.newsletter,
      };
    }),
  );

  // Cache existing IDs for FK validation
  const funderIds = await existingIds("funders");
  const orgIds = await existingIds("organizations");
  const piIds = await existingIds("payment_intermediaries");
  const hhIds = await existingIds("households");
  const personIds = await existingIds("people");
  const regionIds = await existingIds("regions");
  const schoolIds = await existingIds("schools");

  // 8. people_entity_roles
  const per = load("people_entity_roles");
  await batchInsert(
    "people_entity_roles",
    ["id","person_id","entity_type","funder_id","organization_id",
     "payment_intermediary_id","household_id","connection","notes","external_title_or_role",
     "current","primary_contact"],
    per.flatMap((r) => {
      const f = r.fields;
      const pid = first(f.person);
      const etype = entityTypeMap[f.entity_type];
      if (!pid || !personIds.has(pid) || !etype) return [];
      let funder_id = null, organization_id = null, payment_intermediary_id = null, household_id = null;
      if (etype === "funder") {
        funder_id = first(f.funders);
        if (funder_id && !funderIds.has(funder_id)) funder_id = null;
        if (!funder_id) return [];
      } else if (etype === "non_funding_organization") {
        organization_id = first(f.organization);
        if (organization_id && !orgIds.has(organization_id)) organization_id = null;
        if (!organization_id) return [];
      } else if (etype === "household") {
        household_id = first(f.household);
        if (household_id && !hhIds.has(household_id)) household_id = null;
        if (!household_id) return [];
      } else if (etype === "payment_intermediary") {
        payment_intermediary_id = first(f.payment_intermediaries) ?? first(f.funders);
        if (payment_intermediary_id && !piIds.has(payment_intermediary_id)) payment_intermediary_id = null;
        if (!payment_intermediary_id) return [];
      }
      return [{
        id: r.id,
        person_id: pid, entity_type: etype,
        funder_id, organization_id, payment_intermediary_id, household_id,
        connection: f.connection ?? null, // already snake_case in source
        notes: f.notes ?? null,
        external_title_or_role: f.external_title_or_role ?? null,
        current: personRoleCurrentMap[f.current] ?? "current",
        primary_contact: !!f.primary_contact,
      }];
    }),
  );

  // 9. emails
  const emails = load("emails");
  await batchInsert(
    "emails",
    ["id","email","type","person_id","validity","is_preferred"],
    emails.flatMap((r) => {
      const f = r.fields;
      if (!f.email) return [];
      const pid = first(f.person);
      return [{
        id: r.id,
        email: f.email,
        type: f.type ?? null,
        person_id: pid && personIds.has(pid) ? pid : null,
        validity: "unknown",
        is_preferred: false,
      }];
    }),
  );

  // 10. phone_numbers
  const phones = load("phone_numbers");
  await batchInsert(
    "phone_numbers",
    ["id","phone_number","type","person_id","validity","is_preferred"],
    phones.flatMap((r) => {
      const f = r.fields;
      if (!f.phone_number) return [];
      const pid = first(f.person);
      return [{
        id: r.id,
        phone_number: f.phone_number,
        type: f.type ?? null,
        person_id: pid && personIds.has(pid) ? pid : null,
        validity: "unknown",
        is_preferred: false,
      }];
    }),
  );

  // 11. addresses (also denormalize city name + state code for cheap reads).
  // Region IDs are translated from Airtable recXXX to the new slug PK.
  const regionLookupBySlug = new Map();
  {
    const rs = await pool.query(`SELECT id, name, state_abbreviation, type FROM regions`);
    for (const row of rs.rows) regionLookupBySlug.set(row.id, row);
  }
  const addrs = load("addresses");
  await batchInsert(
    "addresses",
    ["id","street","city_region_id","city_name","state_region_id","state_code",
     "postal_code","country","person_id","funder_id","organization_id",
     "payment_intermediary_id","household_id"],
    addrs.map((r) => {
      const f = r.fields;
      const pid = first(f.person);
      const oid = first(f.organization);
      const fid = first(f.funder);
      const citySlug = toRegionSlug(first(f.city));
      const stateSlug = toRegionSlug(first(f.state));
      const cityRow = citySlug ? regionLookupBySlug.get(citySlug) : null;
      const stateRow = stateSlug ? regionLookupBySlug.get(stateSlug) : null;
      return {
        id: r.id,
        street: f.street ?? null,
        city_region_id: cityRow ? citySlug : null,
        city_name: cityRow?.name ?? null,
        state_region_id: stateRow ? stateSlug : null,
        state_code: stateRow?.state_abbreviation ?? null,
        postal_code: f.postal_code ?? null,
        country: f.country ?? null,
        person_id: pid && personIds.has(pid) ? pid : null,
        funder_id: fid && funderIds.has(fid) ? fid : null,
        organization_id: oid && orgIds.has(oid) ? oid : null,
        // Source data doesn't link addresses to PIs / households directly,
        // but the columns exist for future records.
        payment_intermediary_id: null,
        household_id: null,
      };
    }),
  );

  // 12. opportunities_and_pledges
  const opps = load("opportunities_and_pledges");
  await batchInsert(
    "opportunities_and_pledges",
    ["id","name","funder_id","ask_amount","awarded_amount","type","conditional",
     "grant_years","individual_giver_person_id","status","owner_user_id","projected_close_date",
     "actual_completion_date","win_probability","stage","payment_details",
     "intended_usages","fundable_project_ids","entity_ids","usage_notes",
     "legacy_pledge_id_from_copper","primary_contact_person_id",
     "created_at_from_airtable","updated_at_from_airtable"],
    opps.map((r) => {
      const f = r.fields;
      const fid = first(f.funder);
      const pid = first(f.individual_giver);
      const pcid = first(f.primary_contact_for_institutional_donors);
      const iu = mapIntendedUsage(f.intended_usage);
      const grantYears = arr(f.grant_years).map(normalizeFy).filter(Boolean);
      // Map the multi-select entity field to entity_ids text[].
      const entityIds = arr(f.entity)
        .map((raw) => entityAliasToId.get(raw))
        .filter(Boolean);
      return {
        id: r.id,
        name: f.name ?? null,
        funder_id: fid && funderIds.has(fid) ? fid : null,
        ask_amount: f.ask_amount ?? null,
        awarded_amount: f.awarded_amount ?? null,
        type: oppTypeMap[f.type] ?? null,
        conditional: oppConditionalMap[f.conditional] ?? null,
        grant_years: grantYears,
        individual_giver_person_id: pid && personIds.has(pid) ? pid : null,
        status: oppStatusMap[f.status] ?? null,
        owner_user_id: resolveOwner(f.owner),
        projected_close_date: f.projected_close_date ?? null,
        actual_completion_date: f.actual_completion_date ?? null,
        win_probability: f.win_probability ?? null,
        stage: oppStageMap[f.stage] ?? null,
        payment_details: f.payment_details ?? null,
        intended_usages: iu.intended_usage ? [iu.intended_usage] : null,
        fundable_project_ids: iu.fundable_project_id ? [iu.fundable_project_id] : null,
        entity_ids: entityIds.length ? entityIds : null,
        usage_notes: f.usage_notes ?? null,
        legacy_pledge_id_from_copper: f.pledge_id ?? null,
        primary_contact_person_id: pcid && personIds.has(pcid) ? pcid : null,
        created_at_from_airtable: f["Created At"] ?? null,
        updated_at_from_airtable: f["Updated At"] ?? null,
      };
    }),
  );

  const oppIds = await existingIds("opportunities_and_pledges");

  // 13. pledge_allocations
  const pa = load("pledge_allocations");
  await batchInsert(
    "pledge_allocations",
    ["id","pledge_or_opportunity_id","sub_amount","grant_year","entity_id",
     "intended_usage","fundable_project_id","status","notes"],
    pa.map((r) => {
      const f = r.fields;
      const oid = first(f.pledge_or_opportunity);
      const iu = mapIntendedUsage(f.intended_usage);
      return {
        id: r.id,
        pledge_or_opportunity_id: oid && oppIds.has(oid) ? oid : null,
        sub_amount: f.sub_amount ?? null,
        grant_year: singleFy(f.grant_year, `pledge_allocations[${r.id}].grant_year`),
        entity_id: entityAliasToId.get(f.entity) ?? null,
        intended_usage: iu.intended_usage,
        fundable_project_id: iu.fundable_project_id,
        status: paStatusMap[f.status] ?? null,
        notes: f.notes ?? null,
      };
    }),
  );

  // 14. gifts_and_payments
  const gifts = load("gifts_and_payments");
  await batchInsert(
    "gifts_and_payments",
    ["id","legacy_gift_id","name","details","date_received","payment_method",
     "amount","funder_id","individual_giver_person_id","type","payment_on_pledge_id",
     "grant_year","primary_contact_person_id","payment_intermediary_id","owner_user_id","close_date",
     "completed_date","allocation_type","entity_id","intended_usage","fundable_project_id",
     "designated_to_school","school_recipient_id","spending_start","spending_end","tags",
     "created_at_from_airtable","updated_at_from_airtable"],
    gifts.map((r) => {
      const f = r.fields;
      const fid = first(f.funder);
      const pid = first(f.individual_giver);
      const pcid = first(f.primary_contact_for_institutional_donors);
      const pop = first(f.payment_on_pledge);
      const piid = first(f.payment_intermediary);
      const sid = first(f.school_recipient);
      const iu = mapIntendedUsage(f.intended_usage);
      return {
        id: r.id,
        legacy_gift_id: f.gift_id ?? null,
        name: f.name ?? null,
        details: f.details ?? null,
        date_received: f.date_received ?? null,
        payment_method: giftPaymentMethodMap[f.payment_method] ?? null,
        amount: f.amount ?? null,
        funder_id: fid && funderIds.has(fid) ? fid : null,
        individual_giver_person_id: pid && personIds.has(pid) ? pid : null,
        type: mapGiftType(f.type),
        payment_on_pledge_id: pop && oppIds.has(pop) ? pop : null,
        grant_year: singleFy(f.grant_year, `gifts_and_payments[${r.id}].grant_year`),
        primary_contact_person_id: pcid && personIds.has(pcid) ? pcid : null,
        payment_intermediary_id: piid && piIds.has(piid) ? piid : null,
        owner_user_id: resolveOwner(f.owner),
        close_date: f.close_date ?? null,
        completed_date: f.completed_date ?? null,
        allocation_type: f.allocation_type ?? null,
        entity_id: entityAliasToId.get(f.entity) ?? null,
        intended_usage: iu.intended_usage,
        fundable_project_id: iu.fundable_project_id,
        designated_to_school: !!f.designated_to_school,
        school_recipient_id: sid && schoolIds.has(sid) ? sid : null,
        spending_start: f.spending_start_date ?? null,
        spending_end: f.spending_end_date ?? null,
        tags: Array.isArray(f.Tags) ? f.Tags.join(", ") : (f.Tags ?? null),
        created_at_from_airtable: f["Created At"] ?? null,
        updated_at_from_airtable: f["Updated At"] ?? null,
      };
    }),
  );

  const giftIds = await existingIds("gifts_and_payments");

  // 15. gift_allocations
  const ga = load("gift_allocations");
  await batchInsert(
    "gift_allocations",
    ["id","gift_id","sub_amount","grant_year","entity_id",
     "intended_usage","fundable_project_id","spending_start","spending_end"],
    ga.map((r) => {
      const f = r.fields;
      const gid = first(f.link_to_gifts_and_payments);
      const iu = mapIntendedUsage(f.intended_usage);
      // Airtable's `recipient` is the fund-entity name (e.g. "Wildflower
      // Foundation"); map it to entity_id via the alias table. project_name
      // is dropped because fundable_project_id supersedes it.
      const recipientRaw = Array.isArray(f.recipient)
        ? f.recipient[0]
        : f.recipient;
      return {
        id: r.id,
        gift_id: gid && giftIds.has(gid) ? gid : null,
        sub_amount: f.sub_amount ?? null,
        grant_year: singleFy(f.grant_year_to_book_to, `gift_allocations[${r.id}].grant_year`),
        entity_id: entityAliasToId.get(recipientRaw) ?? null,
        intended_usage: iu.intended_usage,
        fundable_project_id: iu.fundable_project_id,
        spending_start: f.spending_start ?? null,
        spending_end: f.spending_end ?? null,
      };
    }),
  );

  const paIds = await existingIds("pledge_allocations");
  const gaIds = await existingIds("gift_allocations");

  // Regional designations — denormalized as text[] columns on each parent
  // table (no junction tables). For each parent row we collect the linked
  // Airtable record IDs from the relevant field and write them to
  // `region_ids` only if they reference a known region.
  console.log("== regional designations (region_ids text[]) ==");

  async function setRegionIds(table, sourceRows, airtableField, idAllowSet) {
    for (const r of sourceRows) {
      if (idAllowSet && !idAllowSet.has(r.id)) continue;
      // Translate Airtable recXXX region refs to slug PKs, dropping
      // anything that doesn't resolve to a known region.
      const slugs = toRegionSlugs(r.fields[airtableField]).filter((s) =>
        regionIds.has(s),
      );
      if (!slugs.length) continue;
      await pool.query(`UPDATE ${table} SET region_ids = $1 WHERE id = $2`, [slugs, r.id]);
    }
  }

  await setRegionIds("funders", funders, "regional_priorities");
  await setRegionIds("people", people, "regional_priorities");
  await setRegionIds("opportunities_and_pledges", opps, "regional_focus");
  await setRegionIds("pledge_allocations", pa, "regional_designation", paIds);
  await setRegionIds("gifts_and_payments", gifts, "regional_designation");
  await setRegionIds("gift_allocations", ga, "regional_designation", gaIds);

  console.log("=== Import complete ===");
  await pool.end();
}

run().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
