import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { organizations, people, bulkOperations } from "@workspace/db/schema";
import { inArray, sql, type SQL } from "drizzle-orm";
import { newId } from "./helpers";
import { getAppUser } from "./appRequest";

/**
 * Entity-merge engine. Collapses any number of duplicate records into a
 * single chosen "primary" record, then permanently deletes the
 * duplicates — all inside one transaction.
 *
 * Two things move to the primary:
 *  1. Scalar field winners the user picked field-by-field, applied as a
 *     whitelisted `overrides` patch on the primary row.
 *  2. Every piece of related data — direct FK references AND text[] slug
 *     arrays across the whole schema — re-pointed from each duplicate
 *     ("loser") to the primary.
 *
 * The primary's own multi-value array columns (region_ids, interests_*,
 * historical_names) are unioned across all selected records so nothing
 * is lost. For funders the duplicates' names are appended to
 * `historical_names` so legacy references still resolve after the merge.
 *
 * Single-value FK swaps keep the XOR/discriminator CHECK constraints
 * valid (a row that pointed at one funder/person now points at another —
 * still exactly one). Array rewrites de-duplicate while preserving
 * first-occurrence order so a row linked to both primary and a loser
 * doesn't end up with a doubled chip.
 */

export interface MergeRef {
  /** Physical table name (snake_case). */
  table: string;
  /** Physical column name (snake_case) holding the entity id. */
  col: string;
}

export interface MergeEntityConfig {
  kind: "organizations" | "people";
  /** Audit-log entity name, e.g. "funders_merge". */
  entity: string;
  /** Drizzle table for the entity itself (funders / people). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /**
   * Self-referencing FK column on the entity's own table
   * (parent_funder_id / assistant_person_id). Reassigned like any other
   * FK, then cleaned up so the primary can never point at itself or a
   * (deleted) loser.
   */
  selfRefCol: string;
  /** Every direct FK column referencing this entity's id. */
  fkRefs: ReadonlyArray<MergeRef>;
  /** Every text[] slug-array column referencing this entity's id. */
  arrayRefs: ReadonlyArray<MergeRef>;
  /**
   * The entity's own multi-value array columns (camelCase drizzle keys)
   * that should be unioned from all selected records onto the primary.
   */
  ownArrayCols: ReadonlyArray<string>;
  /** Append each loser's `name` to the primary's `historical_names` (funders). */
  appendNameToHistorical: boolean;
  /**
   * Whitelist of scalar column keys (camelCase drizzle keys) that the
   * user may pick a winner for. Anything else in `overrides` is dropped.
   */
  overrideFields: ReadonlyArray<string>;
}

const ORGANIZATION_FK_REFS: ReadonlyArray<MergeRef> = [
  { table: "organizations", col: "parent_organization_id" },
  { table: "opportunities_and_pledges", col: "organization_id" },
  { table: "gifts_and_payments", col: "organization_id" },
  { table: "people_entity_roles", col: "organization_id" },
  { table: "addresses", col: "organization_id" },
  { table: "emails", col: "organization_id" },
  { table: "phone_numbers", col: "organization_id" },
  { table: "meeting_notes", col: "organization_id" },
  { table: "email_proposals", col: "target_organization_id" },
  { table: "task_proposals", col: "target_organization_id" },
  { table: "donor_payment_intermediaries", col: "organization_id" },
  { table: "staged_payments", col: "organization_id" },
];

const ORGANIZATION_ARRAY_REFS: ReadonlyArray<MergeRef> = [
  { table: "notes", col: "organization_ids" },
  { table: "interactions", col: "organization_ids" },
  { table: "tasks", col: "organization_ids" },
  { table: "media_mentions", col: "organization_ids" },
  { table: "calendar_events", col: "matched_organization_ids" },
  { table: "email_messages", col: "matched_organization_ids" },
  { table: "tracked_emails", col: "recipient_organization_ids" },
];

const PERSON_FK_REFS: ReadonlyArray<MergeRef> = [
  { table: "people", col: "assistant_person_id" },
  { table: "people_entity_roles", col: "person_id" },
  { table: "gifts_and_payments", col: "individual_giver_person_id" },
  { table: "gifts_and_payments", col: "advisor_person_id" },
  { table: "gifts_and_payments", col: "primary_contact_person_id" },
  { table: "opportunities_and_pledges", col: "individual_giver_person_id" },
  { table: "opportunities_and_pledges", col: "individual_advisor_person_id" },
  { table: "opportunities_and_pledges", col: "primary_contact_person_id" },
  { table: "addresses", col: "person_id" },
  { table: "emails", col: "person_id" },
  { table: "phone_numbers", col: "person_id" },
  { table: "meeting_notes", col: "person_id" },
  { table: "email_proposals", col: "target_person_id" },
  { table: "task_proposals", col: "target_person_id" },
  { table: "person_suppression_windows", col: "person_id" },
  { table: "donor_payment_intermediaries", col: "individual_giver_person_id" },
  { table: "staged_payments", col: "individual_giver_person_id" },
];

const PERSON_ARRAY_REFS: ReadonlyArray<MergeRef> = [
  { table: "notes", col: "person_ids" },
  { table: "interactions", col: "person_ids" },
  { table: "tasks", col: "person_ids" },
  { table: "media_mentions", col: "person_ids" },
  { table: "calendar_events", col: "matched_person_ids" },
  { table: "email_messages", col: "matched_person_ids" },
  { table: "tracked_emails", col: "recipient_person_ids" },
];

const ORGANIZATION_OVERRIDE_FIELDS: ReadonlyArray<string> = [
  "name",
  "entityType",
  "issuesGrants",
  "makesPris",
  "numberOfEmployees",
  "capacityRating",
  "totalAssets",
  "priorityAreasNotes",
  "about",
  "activeStatus",
  "otherNames",
  "details",
  "emailDomain",
  "orgEmail",
  "ownerUserId",
  "tags",
  "lastContacted",
  "x",
  "linkedin",
  "facebook",
  "instagram",
  "youtube",
  "crunchbase",
  "website",
  "connectionStatus",
  "enthusiasm",
  "strategicAlignment",
  "parentOrganizationId",
  "paymentIntermediaryId",
  "priority",
];

const PERSON_OVERRIDE_FIELDS: ReadonlyArray<string> = [
  "prefix",
  "firstName",
  "nickname",
  "middleName",
  "lastName",
  "suffix",
  "fullName",
  "pronouns",
  "deceased",
  "currentHomeRegionId",
  "details",
  "ownerUserId",
  "tags",
  "lastContacted",
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "aboutMe",
  "youtube",
  "website",
  "newsletter",
  "unsubscribedToNewsletter",
  "capacityRating",
  "netWorth",
  "connectionStatus",
  "enthusiasm",
  "childrenAtWf",
  "meetingLink",
  "assistantPersonId",
  "priority",
];

export const ORGANIZATION_MERGE_CONFIG: MergeEntityConfig = {
  kind: "organizations",
  entity: "organizations_merge",
  table: organizations,
  selfRefCol: "parent_organization_id",
  fkRefs: ORGANIZATION_FK_REFS,
  arrayRefs: ORGANIZATION_ARRAY_REFS,
  ownArrayCols: [
    "regionIds",
    "interestsThematic",
    "interestsAges",
    "interestsGovModels",
    "historicalNames",
  ],
  appendNameToHistorical: true,
  overrideFields: ORGANIZATION_OVERRIDE_FIELDS,
};

export const PERSON_MERGE_CONFIG: MergeEntityConfig = {
  kind: "people",
  entity: "people_merge",
  table: people,
  selfRefCol: "assistant_person_id",
  fkRefs: PERSON_FK_REFS,
  arrayRefs: PERSON_ARRAY_REFS,
  ownArrayCols: ["regionIds", "interestsThematic", "interestsAges", "interestsGovModels"],
  appendNameToHistorical: false,
  overrideFields: PERSON_OVERRIDE_FIELDS,
};

const MAX_MERGE_RECORDS = 50;

export interface MergeBody {
  primaryId: string;
  mergeIds: string[];
  overrides?: Record<string, unknown>;
}

export interface MergeResult {
  primaryId: string;
  mergedIds: string[];
}

/** Union string arrays, dropping null/empty and de-duplicating while
 * preserving first-occurrence order. */
export function unionArrays(
  ...arrs: ReadonlyArray<ReadonlyArray<string> | null | undefined>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of arrs) {
    if (!arr) continue;
    for (const v of arr) {
      if (v == null || v === "") continue;
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/**
 * Build the `.set()` object applied to the primary row: whitelisted
 * scalar overrides + unioned own-array columns + (funders) loser names
 * appended to historical_names. Pure — unit-testable without a DB.
 */
export function computePrimaryUpdates(
  cfg: MergeEntityConfig,
  primaryRow: Record<string, unknown>,
  loserRows: ReadonlyArray<Record<string, unknown>>,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};

  // 1. Whitelisted scalar overrides.
  if (overrides) {
    for (const key of cfg.overrideFields) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        set[key] = overrides[key];
      }
    }
  }

  const asArr = (v: unknown): string[] | null =>
    Array.isArray(v) ? (v as string[]) : null;

  // 2. Union the entity's own multi-value array columns.
  for (const col of cfg.ownArrayCols) {
    if (col === "historicalNames" && cfg.appendNameToHistorical) continue;
    const merged = unionArrays(
      asArr(primaryRow[col]),
      ...loserRows.map((r) => asArr(r[col])),
    );
    set[col] = merged;
  }

  // 3. Funders: fold loser display names into historical_names so legacy
  //    references resolve after the duplicates are gone.
  if (cfg.appendNameToHistorical) {
    const finalName = String(
      (set.name as string | undefined) ?? primaryRow.name ?? "",
    ).trim();
    const loserNames = loserRows
      .map((r) => String(r.name ?? "").trim())
      .filter((n) => n.length > 0 && n !== finalName);
    const merged = unionArrays(
      asArr(primaryRow.historicalNames),
      ...loserRows.map((r) => asArr(r.historicalNames)),
      loserNames,
    ).filter((n) => n !== finalName);
    set.historicalNames = merged;
  }

  return set;
}

function ident(name: string): SQL {
  return sql.raw(`"${name}"`);
}

function idArray(ids: ReadonlyArray<string>): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Execute a merge. Validates the request, then in one transaction:
 * applies the primary updates, re-points every FK + array reference from
 * the losers to the primary, cleans up self-references, deletes the
 * losers, and writes an audit row.
 */
export async function mergeEntity(
  req: Request,
  res: Response,
  cfg: MergeEntityConfig,
): Promise<void> {
  const body = req.body as Partial<MergeBody> | undefined;
  const primaryId = typeof body?.primaryId === "string" ? body.primaryId : "";
  const rawMergeIds = Array.isArray(body?.mergeIds) ? body.mergeIds : [];
  const overrides =
    body?.overrides && typeof body.overrides === "object"
      ? (body.overrides as Record<string, unknown>)
      : undefined;

  if (!primaryId) {
    res.status(400).json({ error: "validation_error", message: "primaryId is required" });
    return;
  }

  // De-dupe loser ids, drop the primary if it slipped in.
  const seen = new Set<string>([primaryId]);
  const loserIds: string[] = [];
  for (const id of rawMergeIds) {
    if (typeof id !== "string" || !id) continue;
    if (!seen.has(id)) {
      seen.add(id);
      loserIds.push(id);
    }
  }

  if (loserIds.length === 0) {
    res.status(400).json({
      error: "validation_error",
      message: "mergeIds must contain at least one record distinct from the primary",
    });
    return;
  }
  if (loserIds.length + 1 > MAX_MERGE_RECORDS) {
    res.status(400).json({
      error: "validation_error",
      message: `Cannot merge more than ${MAX_MERGE_RECORDS} records at once`,
    });
    return;
  }

  const allIds = [primaryId, ...loserIds];
  const rows = (await db
    .select()
    .from(cfg.table)
    .where(inArray(cfg.table.id, allIds))) as Array<Record<string, unknown>>;
  const byId = new Map<string, Record<string, unknown>>(
    rows.map((r) => [r.id as string, r]),
  );

  const primaryRow = byId.get(primaryId);
  if (!primaryRow) {
    res.status(400).json({ error: "validation_error", message: "primary record not found" });
    return;
  }
  const missing = loserIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    res.status(400).json({
      error: "validation_error",
      message: `record(s) not found: ${missing.join(", ")}`,
    });
    return;
  }

  const loserRows = loserIds.map((id) => byId.get(id)!);
  const setObj = computePrimaryUpdates(cfg, primaryRow, loserRows, overrides);

  const actor = getAppUser(req);

  await db.transaction(async (tx) => {
    // 0. Lock the primary + every loser entity row FOR UPDATE before any
    //    rewrite. Several child FKs (addresses, emails, phone_numbers,
    //    people_entity_roles, person_suppression_windows) are ON DELETE
    //    CASCADE. Without this lock a concurrent INSERT of a child row
    //    pointing at a loser could land between the FK rewrite (step 2) and
    //    the loser DELETE (step 5) and then be silently cascade-deleted.
    //    FOR UPDATE conflicts with the FOR KEY SHARE lock a child INSERT
    //    takes on its parent, so such an insert blocks until this txn
    //    commits and then fails its own FK check instead of vanishing.
    //    It also serializes overlapping merges of the same records.
    await tx.execute(sql`
      SELECT id FROM ${ident(cfg.kind)}
      WHERE id = ANY(${idArray(allIds)})
      FOR UPDATE
    `);

    // 1. Apply scalar winners + unioned arrays to the primary.
    await tx
      .update(cfg.table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ ...(setObj as any), updatedAt: new Date() })
      .where(inArray(cfg.table.id, [primaryId]));

    // 2. Re-point direct FK references loser -> primary.
    for (const ref of cfg.fkRefs) {
      await tx.execute(sql`
        UPDATE ${ident(ref.table)}
        SET ${ident(ref.col)} = ${primaryId}
        WHERE ${ident(ref.col)} = ANY(${idArray(loserIds)})
      `);
    }

    // 3. Rewrite text[] array references loser -> primary, de-duped,
    //    preserving first-occurrence order.
    for (const ref of cfg.arrayRefs) {
      await tx.execute(sql`
        UPDATE ${ident(ref.table)}
        SET ${ident(ref.col)} = (
          SELECT array_agg(val ORDER BY first_ord)
          FROM (
            SELECT val, MIN(ord) AS first_ord
            FROM (
              SELECT CASE WHEN e = ANY(${idArray(loserIds)}) THEN ${primaryId} ELSE e END AS val, ord
              FROM unnest(${ident(ref.col)}) WITH ORDINALITY AS u(e, ord)
            ) mapped
            GROUP BY val
          ) deduped
        )
        WHERE ${ident(ref.col)} && ${idArray(loserIds)}
      `);
    }

    // 4. Self-reference cleanup: the primary must never point at itself
    //    or at a (soon-to-be-deleted) loser.
    await tx.execute(sql`
      UPDATE ${ident(cfg.kind === "organizations" ? "organizations" : "people")}
      SET ${ident(cfg.selfRefCol)} = NULL
      WHERE id = ${primaryId}
        AND (${ident(cfg.selfRefCol)} = ${primaryId} OR ${ident(cfg.selfRefCol)} = ANY(${idArray(loserIds)}))
    `);

    // 5. Delete the losers. All references were re-pointed above, so
    //    nothing cascades away from the primary.
    await tx.delete(cfg.table).where(inArray(cfg.table.id, loserIds));

    // 6. Audit.
    await tx.insert(bulkOperations).values({
      id: newId(),
      actorUserId: actor?.id ?? "unknown",
      entity: cfg.entity,
      fields: Object.keys(setObj),
      targetIds: allIds,
      succeededIds: loserIds,
      failedIds: [],
    });
  });

  const result: MergeResult = { primaryId, mergedIds: loserIds };
  res.json(result);
}
