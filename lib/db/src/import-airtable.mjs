// Bulk importer: reads /tmp/airtable-dump/*.json and loads into Postgres.
// Uses airtable record IDs (recXXXXXXXX) as primary keys throughout.
import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DUMP = "/tmp/airtable-dump";
const load = (name) => JSON.parse(fs.readFileSync(`${DUMP}/${name}.json`, "utf8"));

const first = (v) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

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

  // 1. regions (deferred self-ref)
  const regions = load("regions");
  await batchInsert(
    "regions",
    ["id", "airtable_id", "name", "state_abbreviation", "type"],
    regions.map((r) => ({
      id: r.id,
      airtable_id: r.id,
      name: r.fields.name ?? "(unnamed)",
      state_abbreviation: first(r.fields.state_abbreviation) ?? null,
      type: regionTypeMap[r.fields.type] ?? null,
    })),
  );
  console.log("regions: setting parent_region_id...");
  {
    const ids = new Set(regions.map((r) => r.id));
    for (const r of regions) {
      const parent = first(r.fields.part_of);
      if (parent && ids.has(parent)) {
        await pool.query(`UPDATE regions SET parent_region_id=$1 WHERE id=$2`, [parent, r.id]);
      }
    }
  }

  // 2. schools
  const schools = load("schools");
  await batchInsert(
    "schools",
    ["id", "airtable_id", "name"],
    schools.map((r) => ({ id: r.id, airtable_id: r.id, name: r.fields.name ?? "(unnamed)" })),
  );

  // 3. households
  const households = load("households");
  await batchInsert(
    "households",
    ["id", "airtable_id", "name"],
    households.map((r) => ({ id: r.id, airtable_id: r.id, name: r.fields.name ?? "(unnamed)" })),
  );

  // 4. payment_intermediaries
  const pis = load("payment_intermediaries");
  await batchInsert(
    "payment_intermediaries",
    ["id", "airtable_id", "name", "type", "org_email"],
    pis.map((r) => ({
      id: r.id, airtable_id: r.id,
      name: r.fields.name ?? "(unnamed)",
      type: piTypeMap[r.fields.type] ?? null,
      org_email: r.fields.org_email ?? null,
    })),
  );

  // 5. funders (deferred parent self-ref)
  const funders = load("funders");
  await batchInsert(
    "funders",
    [
      "id","airtable_id","name","funding_entity_subtype","makes_pris","number_of_employees",
      "capacity_rating","national_priorities","priority_areas_notes","active_status","other_names",
      "details","email_domain","owner","tags","last_contacted","interaction_count",
      "created_from_copper","updated_from_copper","x","linkedin","facebook","instagram","youtube",
      "crunchbase","website","connection_status","enthusiasm","strategic_alignment",
      "interests_thematic","interests_ages","interests_gov_models",
    ],
    funders.map((r) => {
      const f = r.fields;
      return {
        id: r.id, airtable_id: r.id,
        name: f.name ?? "(unnamed)",
        funding_entity_subtype: f.funding_entity_subtype ?? null,
        makes_pris: typeof f.makes_pris === "boolean" ? f.makes_pris : null,
        number_of_employees: f.number_of_employees ?? null,
        capacity_rating: f.capacity_rating ?? null,
        national_priorities: typeof f.national_priorities === "boolean" ? f.national_priorities : null,
        priority_areas_notes: f.priority_areas_notes ?? null,
        active_status: f.active_status ?? null,
        other_names: f.other_names ?? null,
        details: f.details ?? null,
        email_domain: f.email_domain ?? null,
        owner: f.owner ?? null,
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

  // 6. organizations
  const orgs = load("organizations");
  await batchInsert(
    "organizations",
    ["id","airtable_id","name","type","email_domain","org_email","street","city_region_id",
     "state_region_id","postal_code","country","owner","website"],
    orgs.map((r) => {
      const f = r.fields;
      return {
        id: r.id, airtable_id: r.id,
        name: f.name ?? "(unnamed)",
        type: f.type ?? null,
        email_domain: f.email_domain ?? null,
        org_email: null,
        street: f.street ?? null,
        city_region_id: first(f.city),
        state_region_id: first(f.state),
        postal_code: f.postal_code ?? null,
        country: f.country ?? null,
        owner: f.owner ?? null,
        website: f.website ?? null,
      };
    }),
  );

  // 7. people (no assistant link in data)
  const people = load("people");
  await batchInsert(
    "people",
    [
      "id","airtable_id","prefix","first_name","middle_name","last_name","full_name",
      "deceased","current_home_region_id","details","owner","tags","last_contacted",
      "interaction_count","created_from_copper","updated_from_copper","linkedin","x",
      "facebook","instagram","about_me","website","interests_thematic","interests_ages",
      "newsletter",
    ],
    people.map((r) => {
      const f = r.fields;
      return {
        id: r.id, airtable_id: r.id,
        prefix: f.prefix ?? null,
        first_name: f.first_name ?? null,
        middle_name: f.middle_name ?? null,
        last_name: f.last_name ?? null,
        full_name: f.full_name ?? null,
        deceased: !!f.deceased,
        current_home_region_id: first(f.current_home),
        details: f.details ?? null,
        owner: f.owner ?? null,
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
    ["id","airtable_id","person_id","entity_type","funder_id","organization_id",
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
        id: r.id, airtable_id: r.id,
        person_id: pid, entity_type: etype,
        funder_id, organization_id, payment_intermediary_id, household_id,
        connection: f.connection ?? null,
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
    ["id","airtable_id","email","type","person_id","current"],
    emails.flatMap((r) => {
      const f = r.fields;
      if (!f.email) return [];
      const pid = first(f.person);
      return [{
        id: r.id, airtable_id: r.id,
        email: f.email,
        type: f.type ?? null,
        person_id: pid && personIds.has(pid) ? pid : null,
        current: "active",
      }];
    }),
  );

  // 10. phone_numbers
  const phones = load("phone_numbers");
  await batchInsert(
    "phone_numbers",
    ["id","airtable_id","phone_number","type","person_id","current"],
    phones.flatMap((r) => {
      const f = r.fields;
      if (!f.phone_number) return [];
      const pid = first(f.person);
      return [{
        id: r.id, airtable_id: r.id,
        phone_number: f.phone_number,
        type: f.type ?? null,
        person_id: pid && personIds.has(pid) ? pid : null,
        current: "active",
      }];
    }),
  );

  // 11. addresses
  const addrs = load("addresses");
  await batchInsert(
    "addresses",
    ["id","airtable_id","street","city_region_id","state_region_id","postal_code","country",
     "person_id","funder_id","organization_id"],
    addrs.map((r) => {
      const f = r.fields;
      const pid = first(f.person);
      const oid = first(f.organization);
      const fid = first(f.funder);
      return {
        id: r.id, airtable_id: r.id,
        street: f.street ?? null,
        city_region_id: (first(f.city) && regionIds.has(first(f.city))) ? first(f.city) : null,
        state_region_id: (first(f.state) && regionIds.has(first(f.state))) ? first(f.state) : null,
        postal_code: f.postal_code ?? null,
        country: f.country ?? null,
        person_id: pid && personIds.has(pid) ? pid : null,
        funder_id: fid && funderIds.has(fid) ? fid : null,
        organization_id: oid && orgIds.has(oid) ? oid : null,
      };
    }),
  );

  // 12. opportunities_and_pledges
  const opps = load("opportunities_and_pledges");
  await batchInsert(
    "opportunities_and_pledges",
    ["id","airtable_id","name","funder_id","ask_amount","awarded_amount","type","conditional",
     "grant_years","individual_giver_person_id","status","owner","projected_close_date",
     "actual_completion_date","win_probability","stage","payment_details","entity",
     "intended_usage","usage_notes","pledge_id","primary_contact_person_id",
     "created_at_from_airtable","updated_at_from_airtable"],
    opps.map((r) => {
      const f = r.fields;
      const fid = first(f.funder);
      const pid = first(f.individual_giver);
      const pcid = first(f.primary_contact_for_institutional_donors);
      return {
        id: r.id, airtable_id: r.id,
        name: f.name ?? null,
        funder_id: fid && funderIds.has(fid) ? fid : null,
        ask_amount: f.ask_amount ?? null,
        awarded_amount: f.awarded_amount ?? null,
        type: f.type ?? null,
        conditional: f.conditional ?? null,
        grant_years: arr(f.grant_years),
        individual_giver_person_id: pid && personIds.has(pid) ? pid : null,
        status: oppStatusMap[f.status] ?? null,
        owner: f.owner ?? null,
        projected_close_date: f.projected_close_date ?? null,
        actual_completion_date: f.actual_completion_date ?? null,
        win_probability: f.win_probability ?? null,
        stage: f.stage ?? null,
        payment_details: f.payment_details ?? null,
        entity: arr(f.entity),
        intended_usage: f.intended_usage ?? null,
        usage_notes: f.usage_notes ?? null,
        pledge_id: f.pledge_id ?? null,
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
    ["id","airtable_id","pledge_or_opportunity_id","sub_amount","grant_year","entity",
     "intended_usage","status","notes"],
    pa.map((r) => {
      const f = r.fields;
      const oid = first(f.pledge_or_opportunity);
      return {
        id: r.id, airtable_id: r.id,
        pledge_or_opportunity_id: oid && oppIds.has(oid) ? oid : null,
        sub_amount: f.sub_amount ?? null,
        grant_year: arr(f.grant_year),
        entity: f.entity ?? null,
        intended_usage: f.intended_usage ?? null,
        status: paStatusMap[f.status] ?? null,
        notes: f.notes ?? null,
      };
    }),
  );

  // 14. gifts_and_payments
  const gifts = load("gifts_and_payments");
  await batchInsert(
    "gifts_and_payments",
    ["id","airtable_id","legacy_gift_id","name","details","date_received","payment_method",
     "amount","funder_id","individual_giver_person_id","type","payment_on_pledge_id",
     "grant_year","primary_contact_person_id","payment_intermediary_id","owner","close_date",
     "completed_date","allocation_type","entity","intended_usage","designated_to_school",
     "school_recipient_id","spending_start_date","spending_end_date","tags",
     "created_at_from_airtable","updated_at_from_airtable"],
    gifts.map((r) => {
      const f = r.fields;
      const fid = first(f.funder);
      const pid = first(f.individual_giver);
      const pcid = first(f.primary_contact_for_institutional_donors);
      const pop = first(f.payment_on_pledge);
      const piid = first(f.payment_intermediary);
      const sid = first(f.school_recipient);
      return {
        id: r.id, airtable_id: r.id,
        legacy_gift_id: f.gift_id ?? null,
        name: f.name ?? null,
        details: f.details ?? null,
        date_received: f.date_received ?? null,
        payment_method: f.payment_method ?? null,
        amount: f.amount ?? null,
        funder_id: fid && funderIds.has(fid) ? fid : null,
        individual_giver_person_id: pid && personIds.has(pid) ? pid : null,
        type: f.type ?? null,
        payment_on_pledge_id: pop && oppIds.has(pop) ? pop : null,
        grant_year: f.grant_year ?? null,
        primary_contact_person_id: pcid && personIds.has(pcid) ? pcid : null,
        payment_intermediary_id: piid && piIds.has(piid) ? piid : null,
        owner: f.owner ?? null,
        close_date: f.close_date ?? null,
        completed_date: f.completed_date ?? null,
        allocation_type: f.allocation_type ?? null,
        entity: f.entity ?? null,
        intended_usage: f.intended_usage ?? null,
        designated_to_school: !!f.designated_to_school,
        school_recipient_id: sid && schoolIds.has(sid) ? sid : null,
        spending_start_date: f.spending_start_date ?? null,
        spending_end_date: f.spending_end_date ?? null,
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
    ["id","airtable_id","gift_id","sub_amount","grant_year_to_book_to","recipient",
     "intended_usage","spending_start","spending_end"],
    ga.map((r) => {
      const f = r.fields;
      const gid = first(f.link_to_gifts_and_payments);
      return {
        id: r.id, airtable_id: r.id,
        gift_id: gid && giftIds.has(gid) ? gid : null,
        sub_amount: f.sub_amount ?? null,
        grant_year_to_book_to: Array.isArray(f.grant_year_to_book_to)
          ? f.grant_year_to_book_to.join(", ")
          : (f.grant_year_to_book_to ?? null),
        recipient: Array.isArray(f.recipient) ? f.recipient.join(", ") : (f.recipient ?? null),
        intended_usage: f.intended_usage ?? null,
        spending_start: f.spending_start ?? null,
        spending_end: f.spending_end ?? null,
      };
    }),
  );

  const paIds = await existingIds("pledge_allocations");
  const gaIds = await existingIds("gift_allocations");

  // Junction tables
  console.log("== junction tables ==");

  // funder_regional_priorities
  const frp = [];
  for (const r of funders) {
    for (const rid of arr(r.fields.regional_priorities)) {
      if (regionIds.has(rid)) frp.push({ funder_id: r.id, region_id: rid });
    }
  }
  await batchInsertJunction("funder_regional_priorities", ["funder_id","region_id"], frp);

  // person_regional_priorities
  const prp = [];
  for (const r of people) {
    for (const rid of arr(r.fields.regional_priorities)) {
      if (regionIds.has(rid)) prp.push({ person_id: r.id, region_id: rid });
    }
  }
  await batchInsertJunction("person_regional_priorities", ["person_id","region_id"], prp);

  // opportunity_regional_focus
  const orf = [];
  for (const r of opps) {
    for (const rid of arr(r.fields.regional_focus)) {
      if (regionIds.has(rid)) orf.push({ opportunity_id: r.id, region_id: rid });
    }
  }
  await batchInsertJunction("opportunity_regional_focus", ["opportunity_id","region_id"], orf);

  // pledge_allocation_regional_designation
  const pard = [];
  for (const r of pa) {
    if (!paIds.has(r.id)) continue;
    for (const rid of arr(r.fields.regional_designation)) {
      if (regionIds.has(rid)) pard.push({ pledge_allocation_id: r.id, region_id: rid });
    }
  }
  await batchInsertJunction(
    "pledge_allocation_regional_designation",
    ["pledge_allocation_id","region_id"], pard,
  );

  // gift_regional_designation
  const grd = [];
  for (const r of gifts) {
    for (const rid of arr(r.fields.regional_designation)) {
      if (regionIds.has(rid)) grd.push({ gift_id: r.id, region_id: rid });
    }
  }
  await batchInsertJunction("gift_regional_designation", ["gift_id","region_id"], grd);

  // gift_allocation_regional_designation
  const gard = [];
  for (const r of ga) {
    if (!gaIds.has(r.id)) continue;
    for (const rid of arr(r.fields.regional_designation)) {
      if (regionIds.has(rid)) gard.push({ gift_allocation_id: r.id, region_id: rid });
    }
  }
  await batchInsertJunction(
    "gift_allocation_regional_designation",
    ["gift_allocation_id","region_id"], gard,
  );

  console.log("=== Import complete ===");
  await pool.end();
}

run().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
