import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  enrichmentSuggestions,
  organizations,
  people,
  regions,
} from "@workspace/db/schema";
import {
  BulkResolveEnrichmentSuggestionsBody,
  ImportEnrichmentSuggestionsCsvBody,
  ListEnrichmentSuggestionsQueryParams,
  ResolveEnrichmentSuggestionBody,
} from "@workspace/api-zod";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { recordAudit } from "../lib/audit";
import { requireAdmin } from "../lib/archive";
import { getViewer, maskName } from "../lib/identityVisibility";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import {
  runExternalEnrichmentStubs,
  runPersonRegionEnrichment,
} from "../lib/enrichment";

const router: IRouter = Router();
router.use(requireAuth);

type EntityType = "person" | "organization";
type EnrichmentField =
  | "currentHomeRegionId"
  | "regionIds"
  | "website"
  | "emailDomain"
  | "totalAssets"
  | "makesPris"
  | "ein";
const ENRICHMENT_FIELDS = new Set<EnrichmentField>([
  "currentHomeRegionId",
  "regionIds",
  "website",
  "emailDomain",
  "totalAssets",
  "makesPris",
  "ein",
]);
const EIN_PATTERN = /^\d{2}-\d{7}$/;

function isEnrichmentField(value: string): value is EnrichmentField {
  return ENRICHMENT_FIELDS.has(value as EnrichmentField);
}

function isSupportedEntityField(
  entityType: string,
  fieldName: string,
): fieldName is EnrichmentField {
  return entityType === "person"
    ? fieldName === "currentHomeRegionId"
    : entityType === "organization" &&
      ["regionIds", "website", "emailDomain", "totalAssets", "makesPris", "ein"].includes(fieldName);
}

function suggestedDisplay(value: typeof enrichmentSuggestions.$inferSelect["suggestedValue"]): string {
  if (value.label) return value.label;
  if (value.valueString != null) return value.valueString;
  if (value.valueNumber != null) return String(value.valueNumber);
  if (value.valueBoolean != null) return value.valueBoolean ? "Yes" : "No";
  if (value.regionId) return value.regionId;
  return "—";
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isNormalizedDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

function isEinConflict(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string; cause?: unknown };
  return (candidate?.code === "23505" && candidate.constraint === "organizations_ein_uq") ||
    (candidate?.cause != null && isEinConflict(candidate.cause));
}

function csvParse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

class EnrichmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function canResolve(req: Request, ownerUserId: string | null): boolean {
  const actor = getAppUser(req);
  return Boolean(
    actor?.id && (actor.role === "admin" || actor.id === ownerUserId),
  );
}

async function entityOwner(
  entityType: EntityType,
  entityId: string,
): Promise<string | null | undefined> {
  if (entityType === "person") {
    return db
      .select({ ownerUserId: people.ownerUserId })
      .from(people)
      .where(and(eq(people.id, entityId), isNull(people.archivedAt)))
      .then((rows) => rows[0]?.ownerUserId);
  }
  return db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(and(eq(organizations.id, entityId), isNull(organizations.archivedAt)))
    .then((rows) => rows[0]?.ownerUserId);
}

async function listPending(
  req: Request,
  entityType: EntityType,
  entityId: string,
) {
  const ownerUserId = await entityOwner(entityType, entityId);
  if (ownerUserId === undefined) return undefined;
  const rows = await db
    .select()
    .from(enrichmentSuggestions)
    .where(
      and(
        eq(enrichmentSuggestions.entityType, entityType),
        eq(enrichmentSuggestions.entityId, entityId),
        eq(enrichmentSuggestions.status, "pending"),
        sql`(
          (${enrichmentSuggestions.entityType} = 'person' AND EXISTS (
            SELECT 1 FROM people p WHERE p.id = ${enrichmentSuggestions.entityId}
              AND p.archived_at IS NULL
          ))
          OR
          (${enrichmentSuggestions.entityType} = 'organization' AND EXISTS (
            SELECT 1 FROM organizations o WHERE o.id = ${enrichmentSuggestions.entityId}
              AND o.archived_at IS NULL
          ))
        )`,
      ),
    )
    .orderBy(asc(enrichmentSuggestions.createdAt));
  return {
    data: rows.map((row) => ({
      ...row,
      viewerCanResolve: canResolve(req, ownerUserId),
    })),
  };
}

async function queueRow(req: Request, row: typeof enrichmentSuggestions.$inferSelect) {
  const target =
    row.entityType === "person"
      ? await db
          .select({
            name: people.fullName,
            ownerUserId: people.ownerUserId,
            currentHomeRegionId: people.currentHomeRegionId,
            anonymous: people.anonymous,
            archivedAt: people.archivedAt,
          })
          .from(people)
          .where(eq(people.id, row.entityId))
          .then((rows) => rows[0])
      : await db
          .select({
            name: organizations.name,
            ownerUserId: organizations.ownerUserId,
            website: organizations.website,
            emailDomain: organizations.emailDomain,
            totalAssets: organizations.totalAssets,
            makesPris: organizations.makesPris,
            ein: organizations.ein,
            anonymous: organizations.anonymous,
            archivedAt: organizations.archivedAt,
          })
          .from(organizations)
          .where(eq(organizations.id, row.entityId))
          .then((rows) => rows[0]);
  const activeTarget = target && target.archivedAt == null ? target : undefined;
  const ownerUserId = activeTarget?.ownerUserId ?? null;
  const viewerCanResolve = Boolean(activeTarget && canResolve(req, ownerUserId));
  const currentValue =
    !activeTarget
      ? null
      : row.fieldName === "currentHomeRegionId"
        ? ("currentHomeRegionId" in target ? target.currentHomeRegionId : null)
        : row.fieldName === "website"
          ? ("website" in target ? target.website : null)
          : row.fieldName === "emailDomain"
            ? ("emailDomain" in target ? target.emailDomain : null)
            : row.fieldName === "totalAssets"
              ? ("totalAssets" in target && target.totalAssets != null ? String(target.totalAssets) : null)
              : row.fieldName === "makesPris"
                ? ("makesPris" in target && target.makesPris != null ? String(target.makesPris) : null)
                : row.fieldName === "ein"
                  ? ("ein" in target ? target.ein : null)
                  : null;
  const targetIdentity = activeTarget
    ? { anonymous: activeTarget.anonymous, ownerUserId: activeTarget.ownerUserId }
    : null;
  return {
    ...row,
    recordName: targetIdentity
      ? maskName(activeTarget!.name, targetIdentity, getViewer(req)) ?? "Anonymous"
      : "Record not found",
    currentValue,
    suggestedValueDisplay: suggestedDisplay(row.suggestedValue),
    ownerUserId,
    viewerCanResolve,
    viewerCannotResolveReason: viewerCanResolve
      ? null
      : activeTarget
        ? "Only the record owner or an admin can resolve this suggestion."
        : "The target record no longer exists.",
  };
}

router.get(
  "/enrichment-suggestions",
  asyncHandler(async (req, res) => {
    const query = parseOrBadRequest(ListEnrichmentSuggestionsQueryParams, req.query, res);
    if (!query) return;
    const filters = [
      eq(enrichmentSuggestions.status, "pending"),
      sql`(
        (${enrichmentSuggestions.entityType} = 'person' AND EXISTS (
          SELECT 1 FROM people p WHERE p.id = ${enrichmentSuggestions.entityId}
            AND p.archived_at IS NULL
        ))
        OR
        (${enrichmentSuggestions.entityType} = 'organization' AND EXISTS (
          SELECT 1 FROM organizations o WHERE o.id = ${enrichmentSuggestions.entityId}
            AND o.archived_at IS NULL
        ))
      )`,
      ...(query.fieldName ? [eq(enrichmentSuggestions.fieldName, query.fieldName)] : []),
      ...(query.sourceLabel ? [eq(enrichmentSuggestions.sourceLabel, query.sourceLabel)] : []),
      ...(query.entityType ? [eq(enrichmentSuggestions.entityType, query.entityType)] : []),
      ...(query.ownerUserId
        ? [
            sql`(
              (${enrichmentSuggestions.entityType} = 'person' AND EXISTS (
                SELECT 1 FROM people p WHERE p.id = ${enrichmentSuggestions.entityId}
                  AND p.owner_user_id = ${query.ownerUserId}
              ))
              OR
              (${enrichmentSuggestions.entityType} = 'organization' AND EXISTS (
                SELECT 1 FROM organizations o WHERE o.id = ${enrichmentSuggestions.entityId}
                  AND o.owner_user_id = ${query.ownerUserId}
              ))
            )`,
          ]
        : []),
      ...(query.confidence ? [eq(enrichmentSuggestions.confidence, query.confidence)] : []),
    ];
    const where = and(...filters);
    const countWhere = and(
      ...filters.filter((_, index) => index !== (query.fieldName ? 2 : -1)),
    );
    const [rows, totalRows, countRows] = await Promise.all([
      db
        .select()
        .from(enrichmentSuggestions)
        .where(where)
        .orderBy(asc(enrichmentSuggestions.createdAt), asc(enrichmentSuggestions.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      db.select({ total: count() }).from(enrichmentSuggestions).where(where),
      db
        .select({
          fieldName: enrichmentSuggestions.fieldName,
          total: count(),
        })
        .from(enrichmentSuggestions)
        .where(countWhere)
        .groupBy(enrichmentSuggestions.fieldName),
    ]);
    const data = await Promise.all(rows.map((row) => queueRow(req, row)));
    const countsByField = Object.fromEntries(
      countRows.map((row) => [row.fieldName, Number(row.total)]),
    );
    res.json({
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: Number(totalRows[0]?.total ?? 0),
      },
      countsByField,
    });
  }),
);

router.get(
  "/people/:id/enrichment-suggestions",
  asyncHandler(async (req, res) => {
    const result = await listPending(req, "person", paramId(req));
    if (!result) return notFound(res, "person");
    res.json(result);
  }),
);

router.post(
  "/people/:id/enrich",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    if (!(await runPersonRegionEnrichment(id))) return notFound(res, "person");
    await runExternalEnrichmentStubs("person", id);
    const result = await listPending(req, "person", id);
    res.json(result);
  }),
);

router.get(
  "/organizations/:id/enrichment-suggestions",
  asyncHandler(async (req, res) => {
    const result = await listPending(req, "organization", paramId(req));
    if (!result) return notFound(res, "organization");
    res.json(result);
  }),
);

router.post(
  "/organizations/:id/enrich",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const org = await db
      .select({ id: organizations.id, regionIds: organizations.regionIds })
      .from(organizations)
      .where(eq(organizations.id, id))
      .then((rows) => rows[0]);
    if (!org) return notFound(res, "organization");
    await runExternalEnrichmentStubs("organization", id);
    const result = await listPending(req, "organization", id);
    res.json(result);
  }),
);

router.post(
  "/enrichment-suggestions/bulk-resolve",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(BulkResolveEnrichmentSuggestionsBody, req.body, res);
    if (!body) return;
    const outcomes = await Promise.all(
      body.ids.map(async (id) => {
        try {
          const suggestion = await resolveSuggestion(req, id, body.status);
          return { id, success: true, suggestion };
        } catch (error) {
          return {
            id,
            success: false,
            error: error instanceof EnrichmentError ? error.code : "request_failed",
            message: error instanceof Error ? error.message : "Resolution failed.",
          };
        }
      }),
    );
    res.json({
      outcomes,
      succeeded: outcomes.filter((outcome) => outcome.success).length,
      failed: outcomes.filter((outcome) => !outcome.success).length,
    });
  }),
);

router.post(
  "/enrichment-suggestions/generate-home-regions",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const peopleToProcess = await db
      .select({ id: people.id })
      .from(people)
      .where(and(isNull(people.currentHomeRegionId), isNull(people.archivedAt)));
    let created = 0;
    for (const person of peopleToProcess) {
      const before = await db
        .select({ id: enrichmentSuggestions.id })
        .from(enrichmentSuggestions)
        .where(and(
          eq(enrichmentSuggestions.entityType, "person"),
          eq(enrichmentSuggestions.entityId, person.id),
          eq(enrichmentSuggestions.fieldName, "currentHomeRegionId"),
          eq(enrichmentSuggestions.status, "pending"),
        ));
      await runPersonRegionEnrichment(person.id);
      const after = await db
        .select({ id: enrichmentSuggestions.id })
        .from(enrichmentSuggestions)
        .where(and(
          eq(enrichmentSuggestions.entityType, "person"),
          eq(enrichmentSuggestions.entityId, person.id),
          eq(enrichmentSuggestions.fieldName, "currentHomeRegionId"),
          eq(enrichmentSuggestions.status, "pending"),
        ));
      if (!before.length && after.length) created += 1;
    }
    res.json({
      examined: peopleToProcess.length,
      created,
      skipped: peopleToProcess.length - created,
    });
  }),
);

router.post(
  "/enrichment-suggestions/import-csv",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(ImportEnrichmentSuggestionsCsvBody, req.body, res);
    if (!body) return;
    const rows = csvParse(body.csvText);
    const headers = rows.shift() ?? [];
    const expectedHeaders = [
      "implement", "priority", "change_type", "table", "record_id",
      "record_name", "field", "current_value", "proposed_value",
      "confidence", "source", "notes",
    ];
    if (headers.join(",") !== expectedHeaders.join(",")) {
      res.status(400).json({ error: "invalid_csv", message: "CSV columns must exactly match the reviewed enrichment format." });
      return;
    }
    const allowed = new Set([
      "PERSON_HOME_REGION", "ORG_WEBSITE", "ORG_TOTAL_ASSETS", "ORG_EIN", "ORG_MAKES_PRIS",
    ]);
    const resultRows: Array<{ row: number; status: "created" | "skipped" | "invalid"; reason: string }> = [];
    let created = 0;
    let skipped = 0;
    let invalid = 0;
    for (const [index, values] of rows.entries()) {
      const record = Object.fromEntries(expectedHeaders.map((header, i) => [header, values[i] ?? ""]));
      const rowNumber = index + 2;
      if (record.implement.trim().toUpperCase() !== "Y") {
        skipped += 1;
        resultRows.push({ row: rowNumber, status: "skipped", reason: "implement is not Y" });
        continue;
      }
      if (!allowed.has(record.change_type)) {
        skipped += 1;
        resultRows.push({ row: rowNumber, status: "skipped", reason: `unsupported change type: ${record.change_type || "blank"}` });
        continue;
      }
      if (record.confidence && !["high", "medium", "low"].includes(record.confidence.trim().toLowerCase())) {
        invalid += 1;
        resultRows.push({ row: rowNumber, status: "invalid", reason: "confidence must be high, medium, or low" });
        continue;
      }
      const entityType: EntityType = record.change_type === "PERSON_HOME_REGION" ? "person" : "organization";
      const fieldName: EnrichmentField =
        record.change_type === "PERSON_HOME_REGION" ? "currentHomeRegionId" :
        record.change_type === "ORG_WEBSITE" ? "website" :
        record.change_type === "ORG_TOTAL_ASSETS" ? "totalAssets" :
        record.change_type === "ORG_EIN" ? "ein" : "makesPris";
      const target = entityType === "person"
        ? await db.select({ id: people.id, archivedAt: people.archivedAt }).from(people).where(eq(people.id, record.record_id)).then((found) => found[0])
        : await db.select({ id: organizations.id, archivedAt: organizations.archivedAt }).from(organizations).where(eq(organizations.id, record.record_id)).then((found) => found[0]);
      if (!target || target.archivedAt != null) {
        skipped += 1;
        resultRows.push({ row: rowNumber, status: "skipped", reason: "target record not found" });
        continue;
      }
      let suggestedValue: typeof enrichmentSuggestions.$inferInsert["suggestedValue"];
      if (fieldName === "currentHomeRegionId") {
        const region = await db.select({ id: regions.id, displayPath: regions.displayPath })
          .from(regions)
          .where(or(eq(regions.id, record.proposed_value), eq(regions.displayPath, record.proposed_value)))
          .then((found) => found[0]);
        if (!region) {
          invalid += 1;
          resultRows.push({ row: rowNumber, status: "invalid", reason: "region id or canonical display path not found" });
          continue;
        }
        suggestedValue = { regionId: region.id, label: region.displayPath, evidence: record.notes || null };
      } else if (fieldName === "website") {
        if (!record.proposed_value.trim() || !isHttpUrl(record.proposed_value.trim())) {
          invalid += 1;
          resultRows.push({ row: rowNumber, status: "invalid", reason: "website must be a valid http or https URL" });
          continue;
        }
        suggestedValue = { valueString: record.proposed_value.trim(), evidence: record.notes || null };
      } else if (fieldName === "totalAssets") {
        const number = Number(record.proposed_value.replace(/[$,]/g, ""));
        if (!record.proposed_value.trim() || !Number.isFinite(number) || number < 0) {
          invalid += 1;
          resultRows.push({ row: rowNumber, status: "invalid", reason: "total assets must be a non-negative number" });
          continue;
        }
        suggestedValue = { valueNumber: number, evidence: record.notes || null };
      } else if (fieldName === "ein") {
        const digits = record.proposed_value.replace(/\D/g, "");
        if (!/^\d{9}$/.test(digits)) {
          invalid += 1;
          resultRows.push({ row: rowNumber, status: "invalid", reason: "EIN must contain nine digits" });
          continue;
        }
        suggestedValue = { valueString: `${digits.slice(0, 2)}-${digits.slice(2)}`, evidence: record.notes || null };
      } else {
        if (!/^(true|false|yes|no)$/i.test(record.proposed_value.trim())) {
          invalid += 1;
          resultRows.push({ row: rowNumber, status: "invalid", reason: "makes_pris must be true or false" });
          continue;
        }
        if (!record.notes.trim()) {
          invalid += 1;
          resultRows.push({ row: rowNumber, status: "invalid", reason: "makes_pris requires nonblank evidence in notes" });
          continue;
        }
        suggestedValue = { valueBoolean: /^(true|yes)$/i.test(record.proposed_value.trim()), evidence: record.notes.trim() };
      }
      const existing = await db.select({ id: enrichmentSuggestions.id })
        .from(enrichmentSuggestions)
        .where(and(
          eq(enrichmentSuggestions.entityType, entityType),
          eq(enrichmentSuggestions.entityId, record.record_id),
          eq(enrichmentSuggestions.fieldName, fieldName),
          eq(enrichmentSuggestions.status, "pending"),
        ));
      if (existing.length) {
        skipped += 1;
        resultRows.push({ row: rowNumber, status: "skipped", reason: "pending suggestion already exists" });
        continue;
      }
      const inserted = await db.insert(enrichmentSuggestions).values({
        id: newId(),
        entityType,
        entityId: record.record_id,
        fieldName,
        suggestedValue,
        sourceLabel: record.source || "CSV review import",
        sourceDetail: record.notes || null,
        confidence: record.confidence ? record.confidence.trim().toLowerCase() : null,
      }).onConflictDoNothing().returning({ id: enrichmentSuggestions.id });
      if (inserted.length) {
        created += 1;
        resultRows.push({ row: rowNumber, status: "created", reason: "pending suggestion created" });
      } else {
        skipped += 1;
        resultRows.push({ row: rowNumber, status: "skipped", reason: "pending suggestion already exists" });
      }
    }
    res.json({ created, skipped, invalid, rows: resultRows });
  }),
);

async function resolveSuggestion(
  req: Request,
  id: string,
  status: "accepted" | "dismissed",
) {
  const actor = getAppUser(req);
  if (!actor?.id) {
    throw new EnrichmentError(401, "unauthorized", "Sign in required.");
  }
  return db.transaction(async (tx) => {
    const suggestion = await tx
      .select()
      .from(enrichmentSuggestions)
      .where(eq(enrichmentSuggestions.id, id))
      .for("update")
      .then((rows) => rows[0]);
    if (!suggestion) throw new EnrichmentError(404, "not_found", "Suggestion not found.");
    if (suggestion.status !== "pending") {
      throw new EnrichmentError(409, "suggestion_resolved", "This suggestion has already been resolved.");
    }
    if (
      (suggestion.entityType !== "person" && suggestion.entityType !== "organization") ||
      !isEnrichmentField(suggestion.fieldName) ||
      !isSupportedEntityField(suggestion.entityType, suggestion.fieldName)
    ) {
      throw new EnrichmentError(409, "unsupported_suggestion", "This suggestion field is not supported.");
    }
    const now = new Date();
    if (suggestion.entityType === "person") {
      if (suggestion.fieldName !== "currentHomeRegionId") {
        throw new EnrichmentError(409, "unsupported_suggestion", "This person suggestion targets an unsupported field.");
      }
      const person = await tx
        .select({ ownerUserId: people.ownerUserId, currentHomeRegionId: people.currentHomeRegionId, archivedAt: people.archivedAt })
        .from(people)
        .where(eq(people.id, suggestion.entityId))
        .for("update")
        .then((rows) => rows[0]);
      if (!person || person.archivedAt != null) throw new EnrichmentError(404, "not_found", "Person not found.");
      if (!canResolve(req, person.ownerUserId)) {
        throw new EnrichmentError(403, "record_owner_required", "Only the record owner or an admin can resolve this suggestion.");
      }
      if (status === "accepted") {
        if (person.currentHomeRegionId) {
          throw new EnrichmentError(409, "canonical_value_present", "Home region was filled after this suggestion was created.");
        }
        if (!suggestion.suggestedValue.regionId) {
          throw new EnrichmentError(409, "suggested_value_stale", "The suggested region is invalid.");
        }
        const regionExists = await tx
          .select({ id: regions.id })
          .from(regions)
          .where(and(eq(regions.id, suggestion.suggestedValue.regionId), isNull(regions.archivedAt)))
          .then((rows) => rows[0]);
        if (!regionExists) throw new EnrichmentError(409, "suggested_value_stale", "The suggested region is no longer available.");
        await tx.update(people).set({ currentHomeRegionId: suggestion.suggestedValue.regionId, updatedAt: now }).where(eq(people.id, suggestion.entityId));
        await recordAudit(tx, req, {
          action: "field_enriched",
          entityType: "person",
          entityId: suggestion.entityId,
          summary: "Accepted CRM enrichment suggestion",
          changes: [{ field: "currentHomeRegionId", from: person.currentHomeRegionId, to: suggestion.suggestedValue.regionId }],
          metadata: { suggestionId: suggestion.id, sourceLabel: suggestion.sourceLabel },
        });
      }
    } else {
      const organization = await tx
        .select({
          ownerUserId: organizations.ownerUserId,
          regionIds: organizations.regionIds,
          website: organizations.website,
          emailDomain: organizations.emailDomain,
          totalAssets: organizations.totalAssets,
          makesPris: organizations.makesPris,
          ein: organizations.ein,
          archivedAt: organizations.archivedAt,
        })
        .from(organizations)
        .where(eq(organizations.id, suggestion.entityId))
        .for("update")
        .then((rows) => rows[0]);
      if (!organization || organization.archivedAt != null) throw new EnrichmentError(404, "not_found", "Organization not found.");
      if (!canResolve(req, organization.ownerUserId)) {
        throw new EnrichmentError(403, "record_owner_required", "Only the record owner or an admin can resolve this suggestion.");
      }
      if (!["regionIds", "website", "emailDomain", "totalAssets", "makesPris", "ein"].includes(suggestion.fieldName)) {
        throw new EnrichmentError(409, "unsupported_suggestion", "This organization suggestion targets an unsupported field.");
      }
      if (status === "accepted") {
        if (suggestion.fieldName === "regionIds") {
          throw new EnrichmentError(409, "funding_interest_evidence_required", "Office location does not establish funding interests.");
        }
        const value = suggestion.suggestedValue;
        let auditFrom: unknown = null;
        let auditTo: unknown = null;
        if (suggestion.fieldName === "website") {
          if (!value.valueString?.trim() || !isHttpUrl(value.valueString.trim())) throw new EnrichmentError(409, "suggested_value_stale", "The suggested website must be a valid http or https URL.");
          if (organization.website) throw new EnrichmentError(409, "canonical_value_present", "Website was filled after this suggestion was created.");
          await tx.update(organizations).set({ website: value.valueString.trim(), updatedAt: now }).where(eq(organizations.id, suggestion.entityId));
          auditTo = value.valueString.trim();
        } else if (suggestion.fieldName === "emailDomain") {
          const domain = value.valueString?.trim().toLowerCase();
          if (!domain || !isNormalizedDomain(domain) || typeof value.expectedCurrentValue !== "string" || !value.expectedCurrentValue.trim()) {
            throw new EnrichmentError(409, "suggested_value_stale", "The suggested email-domain correction must include a normalized domain and expected current value.");
          }
          if ((organization.emailDomain ?? null) !== value.expectedCurrentValue) throw new EnrichmentError(409, "suggested_value_stale", "Email domain changed after this suggestion was created.");
          await tx.update(organizations).set({ emailDomain: domain, updatedAt: now }).where(eq(organizations.id, suggestion.entityId));
          auditFrom = organization.emailDomain;
          auditTo = domain;
        } else if (suggestion.fieldName === "totalAssets") {
          if (value.valueNumber == null || !Number.isFinite(value.valueNumber) || value.valueNumber < 0) throw new EnrichmentError(409, "suggested_value_stale", "The suggested total assets value is invalid.");
          if (organization.totalAssets != null) throw new EnrichmentError(409, "canonical_value_present", "Total assets was filled after this suggestion was created.");
          await tx.update(organizations).set({ totalAssets: String(value.valueNumber), updatedAt: now }).where(eq(organizations.id, suggestion.entityId));
          auditTo = value.valueNumber;
        } else if (suggestion.fieldName === "makesPris") {
          if (value.valueBoolean == null) throw new EnrichmentError(409, "suggested_value_stale", "The suggested PRI value is invalid.");
          if (!value.evidence?.trim()) throw new EnrichmentError(409, "suggested_value_stale", "PRI acceptance requires nonblank evidence.");
          if (organization.makesPris != null) throw new EnrichmentError(409, "canonical_value_present", "PRI status was filled after this suggestion was created.");
          await tx.update(organizations).set({ makesPris: value.valueBoolean, updatedAt: now }).where(eq(organizations.id, suggestion.entityId));
          auditTo = value.valueBoolean;
        } else if (suggestion.fieldName === "ein") {
          if (!value.valueString || !EIN_PATTERN.test(value.valueString)) throw new EnrichmentError(409, "suggested_value_stale", "The suggested EIN is invalid.");
          if (organization.ein) throw new EnrichmentError(409, "canonical_value_present", "EIN was filled after this suggestion was created.");
          try {
            await tx.update(organizations).set({ ein: value.valueString, updatedAt: now }).where(eq(organizations.id, suggestion.entityId));
          } catch (error) {
            if (isEinConflict(error)) throw new EnrichmentError(409, "ein_conflict", "An organization with this EIN already exists.");
            throw error;
          }
          auditTo = value.valueString;
        }
        await recordAudit(tx, req, {
          action: "field_enriched",
          entityType: "organization",
          entityId: suggestion.entityId,
          summary: "Accepted CRM enrichment suggestion",
          changes: [{ field: suggestion.fieldName, from: auditFrom, to: auditTo }],
          metadata: { suggestionId: suggestion.id, sourceLabel: suggestion.sourceLabel, evidence: value.evidence ?? null },
        });
      }
    }
    if (status === "dismissed") {
      await recordAudit(tx, req, {
        action: "field_enrichment_dismissed",
        entityType: suggestion.entityType,
        entityId: suggestion.entityId,
        summary: "Dismissed CRM enrichment suggestion",
        metadata: { suggestionId: suggestion.id, fieldName: suggestion.fieldName, sourceLabel: suggestion.sourceLabel },
      });
    }
    const updated = await tx
      .update(enrichmentSuggestions)
      .set({ status, resolvedAt: now, resolvedByUserId: actor.id, updatedAt: now })
      .where(and(eq(enrichmentSuggestions.id, suggestion.id), eq(enrichmentSuggestions.status, "pending")))
      .returning()
      .then((rows) => rows[0]);
    if (!updated) throw new EnrichmentError(409, "suggestion_resolved", "This suggestion has already been resolved.");
    return { ...updated, viewerCanResolve: true };
  });
}

router.patch(
  "/enrichment-suggestions/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(ResolveEnrichmentSuggestionBody, req.body, res);
    if (!body) return;
    try {
      res.json(await resolveSuggestion(req, paramId(req), body.status));
    } catch (error) {
      if (error instanceof EnrichmentError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  }),
);

export default router;
