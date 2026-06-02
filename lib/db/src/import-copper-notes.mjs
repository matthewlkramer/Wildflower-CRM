// One-time migration: import all "user note" activities from the legacy Copper
// CRM into this CRM's `notes` table.
//
// Self-contained + idempotent + re-runnable:
//   - Fetches notes/people/companies/opportunities live from the Copper API
//     (needs COPPER_API_KEY + COPPER_USER_EMAIL env).
//   - Queries this DB live for the match maps (person emails/names, funder /
//     organization / household names, opportunity copper ids).
//   - Inserts notes with id `copper_<activityId>` and ON CONFLICT (id) DO
//     NOTHING, so re-running never duplicates.
//
// Attachment strategy (decided with the product owner):
//   - person  parent → matched person (by email, else exact-unique name) or
//                       exact-unique household.
//   - company parent → matched funder / household (exact or slash-combined
//                       subset). If it ONLY matches an `organizations` row
//                       (orgs have no detail page), we instead resolve the
//                       Copper company's contacts to CRM people and attach the
//                       note to those people.
//   - opportunity parent → opportunity by copper_pledge_id, else fall back to
//                       the opp's primary contact (person) + company (funder).
//   - Anything that can't be resolved is imported UNATTACHED (body preserved
//     and full-text searchable) rather than risk mis-attributing a donor.
//   - Ambiguous matches (>1 equally-good candidate) are deliberately left
//     unattached, never guessed.
//
// Authorship:
//   - Active Copper users are resolved by email to the existing CRM user.
//   - Copper user 237350 → "Allison Welch" (seeded if missing).
//   - Every other deactivated Copper author → one shared "Former Copper user"
//     placeholder (seeded if missing).
//
// Run:  pnpm --filter @workspace/db run import:copper-notes
//       pnpm --filter @workspace/db run import:copper-notes -- --dry-run
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DRY_RUN = process.argv.includes("--dry-run");
const ALLISON_COPPER_ID = 237350;

// ---------------------------------------------------------------------------
// Copper API client
// ---------------------------------------------------------------------------
const COPPER_BASE = "https://api.copper.com/developer_api/v1";
const COPPER_HEADERS = {
  "X-PW-AccessToken": process.env.COPPER_API_KEY,
  "X-PW-Application": "developer_api",
  "X-PW-UserEmail":
    process.env.COPPER_USER_EMAIL || "matthew.kramer@wildflowerschools.org",
  "Content-Type": "application/json",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE_MS = 350;

async function copperPost(path, body, attempt = 0) {
  try {
    const res = await fetch(COPPER_BASE + path, {
      method: "POST",
      headers: COPPER_HEADERS,
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    return await res.json();
  } catch (e) {
    if (attempt < 5) {
      await sleep(1000 * (attempt + 1));
      return copperPost(path, body, attempt + 1);
    }
    throw e;
  }
}

async function copperPaginate(path, extra = {}) {
  const all = [];
  for (let page = 1; ; page++) {
    const rows = await copperPost(path, { page_number: page, page_size: 200, ...extra });
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 200) break;
    await sleep(THROTTLE_MS);
  }
  return all;
}

async function copperGetUser(id) {
  try {
    const res = await fetch(COPPER_BASE + "/users/" + id, { headers: COPPER_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Text helpers (Copper note bodies are HTML; the UI renders plain text)
// ---------------------------------------------------------------------------
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", trade: "\u2122",
  reg: "\u00ae", copy: "\u00a9", deg: "\u00b0",
};
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}
function htmlToText(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "\n\u2022 ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------
const STOP = new Set([
  "the", "inc", "llc", "foundation", "fund", "funds", "trust", "company", "co",
  "corp", "incorporated", "donor", "advised", "daf", "charitable", "family",
  "group", "of", "and", "a", "an", "for", "llp", "lp", "plc", "ltd", "org",
  "organization", "university", "school", "schools",
]);
function tokens(n) {
  return new Set(
    String(n || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t && !STOP.has(t)),
  );
}
const normEmail = (e) => {
  if (e && typeof e === "object") e = e.email || "";
  return String(e || "").trim().toLowerCase();
};

function buildIndex(rows /* [id,name] */) {
  const byKey = new Map();
  const list = [];
  for (const [id, name] of rows) {
    const tk = tokens(name);
    if (tk.size === 0) continue;
    const k = [...tk].sort().join(" ");
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(id);
    list.push({ id, tk });
  }
  return { byKey, list };
}
let ambiguousRejected = 0;
function matchExact(name, idx) {
  const tk = tokens(name);
  if (tk.size === 0) return null;
  const k = [...tk].sort().join(" ");
  const hit = idx.byKey.get(k);
  if (hit) {
    if (hit.length > 1) {
      ambiguousRejected++;
      return null;
    }
    return hit[0];
  }
  return null;
}
function matchSubset(name, idx, minTokens = 2) {
  const tk = tokens(name);
  if (tk.size < minTokens) return null;
  let best = null;
  let bestExtra = Infinity;
  let ties = 0;
  for (const cand of idx.list) {
    let subset = true;
    for (const t of tk) {
      if (!cand.tk.has(t)) {
        subset = false;
        break;
      }
    }
    if (subset) {
      const extra = cand.tk.size - tk.size;
      if (extra < bestExtra) {
        bestExtra = extra;
        best = cand.id;
        ties = 1;
      } else if (extra === bestExtra) {
        ties++;
      }
    }
  }
  if (best) {
    if (ties > 1) {
      ambiguousRejected++;
      return null;
    }
    return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`=== Copper notes import ${DRY_RUN ? "(DRY RUN)" : ""} ===`);
  if (!process.env.COPPER_API_KEY) throw new Error("COPPER_API_KEY is not set");

  // 1. Fetch Copper data
  console.log("Fetching Copper data…");
  const [notes, people, companies, opportunities] = await Promise.all([
    copperPaginate("/activities/search", { activity_types: [{ category: "user", id: 0 }] }),
    copperPaginate("/people/search"),
    copperPaginate("/companies/search"),
    copperPaginate("/opportunities/search"),
  ]);
  console.log(
    `  notes=${notes.length} people=${people.length} companies=${companies.length} opps=${opportunities.length}`,
  );
  const cPersonById = new Map(people.map((p) => [p.id, p]));
  const cCompanyById = new Map(companies.map((c) => [c.id, c]));
  const cOppById = new Map(opportunities.map((o) => [o.id, o]));
  const peopleByCompany = new Map();
  for (const p of people) {
    if (!p.company_id) continue;
    if (!peopleByCompany.has(p.company_id)) peopleByCompany.set(p.company_id, []);
    peopleByCompany.get(p.company_id).push(p);
  }

  // 2. Build match maps from this DB
  console.log("Building match maps from DB…");
  const q = (text) => pool.query(text).then((r) => r.rows);
  const [emailRows, peopleRows, funderRows, orgRows, hhRows, oppRows] = await Promise.all([
    q(`SELECT lower(email) AS email, person_id FROM emails WHERE person_id IS NOT NULL`),
    q(`SELECT id, coalesce(full_name, trim(coalesce(first_name,'')||' '||coalesce(last_name,''))) AS name FROM people`),
    q(`SELECT id, name FROM funders`),
    q(`SELECT id, name FROM organizations`),
    q(`SELECT id, name FROM households`),
    q(`SELECT id, copper_pledge_id FROM opportunities_and_pledges WHERE copper_pledge_id IS NOT NULL`),
  ]);
  const dbPersonEmail = new Map();
  for (const r of emailRows) if (r.email && r.person_id) dbPersonEmail.set(r.email, r.person_id);
  const idxPeople = buildIndex(peopleRows.map((r) => [r.id, r.name]));
  const idxFunder = buildIndex(funderRows.map((r) => [r.id, r.name]));
  const idxOrg = buildIndex(orgRows.map((r) => [r.id, r.name]));
  const idxHh = buildIndex(hhRows.map((r) => [r.id, r.name]));
  const dbOppByCopper = new Map(oppRows.map((r) => [String(r.copper_pledge_id), r.id]));

  function matchPerson(cp) {
    if (!cp) return null;
    for (const em of cp.emails || []) {
      const h = dbPersonEmail.get(normEmail(em.email));
      if (h) return { target: "person", id: h };
    }
    const p = matchExact(cp.name, idxPeople);
    if (p) return { target: "person", id: p };
    const h = matchExact(cp.name, idxHh);
    if (h) return { target: "household", id: h };
    return null;
  }
  function matchCompany(cc) {
    if (!cc) return null;
    const f = matchExact(cc.name, idxFunder) || matchSubset(cc.name, idxFunder);
    if (f) return { target: "funder", id: f };
    const h = matchExact(cc.name, idxHh) || matchSubset(cc.name, idxHh);
    if (h) return { target: "household", id: h };
    const o = matchExact(cc.name, idxOrg) || matchSubset(cc.name, idxOrg);
    if (o) return { target: "organization", id: o };
    return null;
  }

  // 3. Resolve authors
  console.log("Resolving authors…");
  const userRows = await q(
    `SELECT id, lower(email) AS email, coalesce(display_name, trim(coalesce(first_name,'')||' '||coalesce(last_name,''))) AS name FROM users`,
  );
  const dbUsersByEmail = new Map(userRows.map((r) => [r.email, r.id]));
  // Email can drift between systems (e.g. Copper "rachel.kelley-cohn@" vs CRM
  // "rachel.kelleycohn@"), so fall back to an exact-unique name match against
  // existing users before seeding a duplicate.
  const idxUsers = buildIndex(userRows.filter((r) => r.name).map((r) => [r.id, r.name]));
  const seededUsers = []; // {id, clerkId, email, firstName, lastName}
  function ensureSeedUser(email, firstName, lastName) {
    const lc = email.toLowerCase();
    if (dbUsersByEmail.has(lc)) return dbUsersByEmail.get(lc);
    // Include the domain so distinct emails sharing a local-part (e.g.
    // alex@a.com vs alex@b.com) can't collide on the users PK.
    const id = "usr_" + lc.replace(/[^a-z0-9]+/g, "_");
    seededUsers.push({ id, clerkId: "placeholder:" + lc, email: lc, firstName, lastName });
    dbUsersByEmail.set(lc, id);
    return id;
  }

  const authorIds = [...new Set(notes.map((n) => n.user_id).filter((x) => x != null))];
  const authorMap = new Map(); // copper user_id -> CRM user id
  let placeholderId = null;
  for (const cid of authorIds) {
    const u = await copperGetUser(cid);
    if (u && u.email) {
      const existing = dbUsersByEmail.get(u.email.toLowerCase()) || matchExact(u.name, idxUsers);
      if (existing) {
        authorMap.set(cid, existing);
      } else {
        const [fn, ...rest] = (u.name || "").split(" ");
        authorMap.set(cid, ensureSeedUser(u.email, fn || null, rest.join(" ") || null));
      }
    } else if (cid === ALLISON_COPPER_ID) {
      authorMap.set(cid, ensureSeedUser("allison.welch@wildflowerschools.org", "Allison", "Welch"));
    } else {
      if (!placeholderId)
        placeholderId = ensureSeedUser("former-copper-user@wildflowerschools.org", "Former Copper", "user");
      authorMap.set(cid, placeholderId);
    }
    await sleep(120);
  }
  console.log(`  ${authorIds.length} distinct Copper authors → ${new Set(authorMap.values()).size} CRM users`);
  console.log(`  seeding ${seededUsers.length} new user row(s): ${seededUsers.map((u) => u.email).join(", ") || "(none)"}`);

  // 4. Build note rows
  const uniq = (a) => (a.length ? [...new Set(a)] : null);
  const rows = [];
  const stat = { attached: 0, unattached: 0, orgResolvedToPeople: 0, emptyBody: 0, missingAuthor: 0 };
  for (const n of notes) {
    const personIds = [];
    const funderIds = [];
    const householdIds = [];
    const opportunityIds = [];
    const pt = n.parent?.type;
    const addLink = (r) => {
      if (!r) return;
      if (r.target === "person") personIds.push(r.id);
      else if (r.target === "funder") funderIds.push(r.id);
      else if (r.target === "household") householdIds.push(r.id);
      else if (r.target === "opp") opportunityIds.push(r.id);
    };
    if (pt === "person") {
      addLink(matchPerson(cPersonById.get(n.parent.id)));
    } else if (pt === "company") {
      const cc = cCompanyById.get(n.parent.id);
      const r = matchCompany(cc);
      if (r && r.target === "organization") {
        // org-only: resolve via the company's Copper contacts → CRM people
        let any = false;
        for (const p of peopleByCompany.get(cc.id) || []) {
          const pr = matchPerson(p);
          if (pr && pr.target === "person") {
            personIds.push(pr.id);
            any = true;
          }
        }
        if (any) stat.orgResolvedToPeople++;
      } else {
        addLink(r);
      }
    } else if (pt === "opportunity") {
      const oid = dbOppByCopper.get(String(n.parent.id));
      if (oid) {
        opportunityIds.push(oid);
      } else {
        const o = cOppById.get(n.parent.id);
        if (o) {
          if (o.primary_contact_id) addLink(matchPerson(cPersonById.get(o.primary_contact_id)));
          if (o.company_id) addLink(matchCompany(cCompanyById.get(o.company_id)));
        }
      }
    }

    const authorUserId = authorMap.get(n.user_id);
    if (!authorUserId) {
      stat.missingAuthor++;
      continue;
    }
    let body = htmlToText(n.details);
    if (!body) {
      body = "(no content)";
      stat.emptyBody++;
    }
    const linked = personIds.length || funderIds.length || householdIds.length || opportunityIds.length;
    if (linked) stat.attached++;
    else stat.unattached++;

    rows.push({
      id: "copper_" + n.id,
      body,
      authorUserId,
      personIds: uniq(personIds),
      funderIds: uniq(funderIds),
      householdIds: uniq(householdIds),
      opportunityIds: uniq(opportunityIds),
      createdAt: n.date_created ? new Date(n.date_created * 1000) : new Date(),
      updatedAt: n.date_modified ? new Date(n.date_modified * 1000) : new Date(),
    });
  }

  console.log("\n=== Plan ===");
  console.log(`  total notes:           ${notes.length}`);
  console.log(`  rows to import:        ${rows.length}`);
  console.log(`  attached to entity:    ${stat.attached}`);
  console.log(`  unattached:            ${stat.unattached}`);
  console.log(`  org→people resolved:   ${stat.orgResolvedToPeople}`);
  console.log(`  empty body → "(no content)": ${stat.emptyBody}`);
  console.log(`  ambiguous matches skipped:   ${ambiguousRejected}`);
  if (stat.missingAuthor) console.log(`  WARNING dropped (no author): ${stat.missingAuthor}`);

  if (DRY_RUN) {
    console.log("\nDRY RUN — no writes performed.");
    await pool.end();
    return;
  }

  // 5. Seed users
  if (seededUsers.length) {
    for (const u of seededUsers) {
      await pool.query(
        `INSERT INTO users (id, clerk_id, email, first_name, last_name, role)
         VALUES ($1,$2,$3,$4,$5,'team_member')
         ON CONFLICT (email) DO NOTHING`,
        [u.id, u.clerkId, u.email, u.firstName, u.lastName],
      );
    }
    console.log(`Seeded ${seededUsers.length} user row(s).`);
  }

  // 6. Insert notes (chunked, idempotent)
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((r, j) => {
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      params.push(
        r.id, r.body, r.authorUserId, r.personIds, r.funderIds,
        r.householdIds, r.opportunityIds, r.createdAt, r.updatedAt,
      );
    });
    const result = await pool.query(
      `INSERT INTO notes
         (id, body, author_user_id, person_ids, funder_ids, household_ids, opportunity_ids, created_at, updated_at)
       VALUES ${values.join(",")}
       ON CONFLICT (id) DO NOTHING`,
      params,
    );
    inserted += result.rowCount;
  }
  console.log(`\nInserted ${inserted} new note row(s) (existing copper_* rows skipped).`);
  await pool.end();
  console.log("=== Done ===");
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
