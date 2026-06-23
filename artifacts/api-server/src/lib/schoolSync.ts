import { db } from "@workspace/db";
import { schools } from "@workspace/db/schema";
import type {
  schoolStatusEnum,
  governanceModelEnum,
} from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { listAllRecords, type AirtableRecord } from "./airtableClient";

/**
 * Airtable → schools sync (one-way; Airtable is the source of truth).
 *
 * Mirrors the columns visible in the dedicated Wildflower Schools Airtable
 * base's "Data for CRM in Replit" view into our `schools` Postgres table:
 *   Name, Long Name, Short Name, School Status, Governance Model, Ages-Planes,
 *   Logo - main square, Stage_Status, Current Mailing Address,
 *   Current Physical Address.
 *
 * Behaviour:
 *   - Upserts every record from the view by primary key (Airtable record id —
 *     the schools PK convention), so it is idempotent and safe to re-run.
 *   - NEVER deletes schools that fall out of the source view. Instead it counts
 *     them (and logs the gift-reference counts) so an operator can decide what
 *     to do. Rationale: gifts_and_payments.school_recipient_id is ON DELETE
 *     RESTRICT (money-trail data) — a truncate-and-reload would either fail or
 *     silently orphan gift history.
 */

const BASE_ID = "appJBT9a4f3b7hWQ2";
const TABLE_ID = "tblfdVLTc9ij4TaLh"; // Schools
const VIEW_ID = "viwfya5VZGmb7vu0s"; // Data for CRM in Replit

type SchoolStatus = (typeof schoolStatusEnum.enumValues)[number];
type GovernanceModel = (typeof governanceModelEnum.enumValues)[number];

const STATUS_MAP: Record<string, SchoolStatus> = {
  Emerging: "emerging",
  Open: "open",
  Paused: "paused",
  Closing: "closing",
  "Permanently Closed": "permanently_closed",
  Disaffiliating: "disaffiliating",
  Disaffiliated: "disaffiliated",
  Placeholder: "placeholder",
  Abandoned: "abandoned",
};

const GOV_MAP: Record<string, GovernanceModel> = {
  Independent: "independent",
  District: "district",
  Charter: "charter",
  "Exploring Charter": "exploring_charter",
  "Community Partnership": "community_partnership",
};

function asStr(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Airtable lookup/rollup fields arrive as arrays; join them, else passthrough. */
function joinLookup(v: unknown): string | null {
  if (Array.isArray(v)) {
    const joined = v
      .map((x) => asStr(x))
      .filter((x): x is string => Boolean(x))
      .join("\n\n");
    return joined || null;
  }
  return asStr(v);
}

interface SchoolRow {
  id: string;
  name: string;
  longName: string | null;
  shortName: string | null;
  status: SchoolStatus | null;
  governanceModel: GovernanceModel | null;
  agesPlanes: string[] | null;
  logoMainSquareUrl: string | null;
  stageStatus: string | null;
  currentMailingAddress: string | null;
  currentPhysicalAddress: string | null;
}

function toRow(rec: AirtableRecord): SchoolRow {
  const f = rec.fields;
  const logoField = f["Logo - main square"];
  const logo =
    (Array.isArray(logoField) &&
      typeof (logoField[0] as { url?: unknown })?.url === "string" &&
      ((logoField[0] as { url: string }).url || null)) ||
    null;
  const agesPlanes = f["Ages-Planes"];
  const statusKey = asStr(f["School Status"]);
  const govKey = asStr(f["Governance Model"]);
  return {
    id: rec.id,
    name: asStr(f["Name"]) ?? "(unnamed)",
    longName: asStr(f["Long Name"]),
    shortName: asStr(f["Short Name"]),
    status: statusKey ? (STATUS_MAP[statusKey] ?? null) : null,
    governanceModel: govKey ? (GOV_MAP[govKey] ?? null) : null,
    agesPlanes: Array.isArray(agesPlanes)
      ? agesPlanes.map((x) => asStr(x)).filter((x): x is string => Boolean(x))
      : null,
    logoMainSquareUrl: logo,
    stageStatus: asStr(f["Stage_Status"]),
    currentMailingAddress: joinLookup(f["Current Mailing Address"]),
    currentPhysicalAddress: joinLookup(f["Current Physical Address"]),
  };
}

export interface StaleSchool {
  id: string;
  name: string;
  giftRefs: number;
  allocRefs: number;
}

export interface SchoolSyncSummary {
  schoolsFetched: number;
  schoolsUpserted: number;
  stale: StaleSchool[];
}

export interface SchoolSyncOptions {
  /** Cap pages walked from Airtable (guards runaway pagination). */
  maxPages?: number;
  /** Page size, 1..100 (default 100). */
  pageSize?: number;
}

/**
 * Pull the Schools view from Airtable and upsert it into `schools`. One-way,
 * non-destructive, idempotent. Returns the run summary (and the list of schools
 * present in our DB but absent from the source view — never deleted here).
 */
export async function syncSchoolsFromAirtable(
  opts: SchoolSyncOptions = {},
): Promise<SchoolSyncSummary> {
  const records = await listAllRecords({
    baseId: BASE_ID,
    tableId: TABLE_ID,
    viewId: VIEW_ID,
    ...(opts.maxPages != null ? { maxPages: opts.maxPages } : {}),
    ...(opts.pageSize != null ? { pageSize: opts.pageSize } : {}),
  });
  logger.info({ count: records.length }, "Airtable schools fetched");

  const rows = records.map(toRow);
  let upserted = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(schools)
        .values({
          id: row.id,
          name: row.name,
          longName: row.longName,
          shortName: row.shortName,
          status: row.status,
          governanceModel: row.governanceModel,
          agesPlanes: row.agesPlanes,
          logoMainSquareUrl: row.logoMainSquareUrl,
          stageStatus: row.stageStatus,
          currentMailingAddress: row.currentMailingAddress,
          currentPhysicalAddress: row.currentPhysicalAddress,
        })
        .onConflictDoUpdate({
          target: schools.id,
          set: {
            name: row.name,
            longName: row.longName,
            shortName: row.shortName,
            status: row.status,
            governanceModel: row.governanceModel,
            agesPlanes: row.agesPlanes,
            logoMainSquareUrl: row.logoMainSquareUrl,
            stageStatus: row.stageStatus,
            currentMailingAddress: row.currentMailingAddress,
            currentPhysicalAddress: row.currentPhysicalAddress,
            updatedAt: new Date(),
          },
        });
      upserted += 1;
    }
  });

  // Detect stale schools (present in DB, absent from the source view) and
  // report them with gift-reference counts. Do NOT delete — the RESTRICT FK
  // from gifts_and_payments.school_recipient_id blocks it, and a silent SET
  // NULL is not what we want for money-trail data.
  const sourceIds = records.map((r) => r.id);
  const staleResult = await db.execute<{
    id: string;
    name: string;
    gift_refs: number;
    alloc_refs: number;
  }>(sql`
    SELECT s.id, s.name,
           (SELECT COUNT(*)::int FROM gifts_and_payments
              WHERE school_recipient_id = s.id) AS gift_refs,
           (SELECT COUNT(*)::int FROM gift_allocations
              WHERE school_recipient_id = s.id) AS alloc_refs
      FROM schools s
     WHERE s.id <> ALL(${sourceIds}::text[])
     ORDER BY gift_refs DESC, s.name
  `);

  const stale: StaleSchool[] = staleResult.rows.map((r) => ({
    id: r.id,
    name: r.name,
    giftRefs: Number(r.gift_refs),
    allocRefs: Number(r.alloc_refs),
  }));

  if (stale.length) {
    logger.warn(
      { count: stale.length, stale },
      "schools in DB but missing from Airtable source view (not deleted — review manually)",
    );
  }

  return {
    schoolsFetched: records.length,
    schoolsUpserted: upserted,
    stale,
  };
}
