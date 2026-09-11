import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { mediaMentions, people } from "@workspace/db/schema";
import { and, desc, count, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  ListMediaMentionsQueryParams,
  CreateMediaMentionBodyRefined,
  UpdateMediaMentionBody,
  validateMediaMentionInvariants,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseBoolQuery,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { organizationActivityArrayScope } from "../lib/organizationActivityScope";
import { normalizeMediaHeadline } from "../lib/mediaIngest";

const router: IRouter = Router();
router.use(requireAuth);

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: { issues: issues.map((i) => ({ path: [i.path], message: i.message })) },
  });
}

router.get(
  "/media-mentions",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListMediaMentionsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    // Never surface dismissed (soft-deleted) mentions; counts/pagination
    // must reflect this too, so it's part of the shared WHERE.
    const filters: SQL[] = [eq(mediaMentions.dismissed, false)];
    if (q.search) {
      const search = or(
        ilike(mediaMentions.publicationName, `%${q.search}%`),
        ilike(mediaMentions.author, `%${q.search}%`),
        ilike(mediaMentions.aiSummary, `%${q.search}%`),
      );
      if (search) filters.push(search);
    }
    if (q.personId)
      filters.push(sql`${mediaMentions.personIds} @> ARRAY[${q.personId}]::text[]`);
    if (q.organizationId) {
      filters.push(
        parseBoolQuery(req, "includeLinkedPeople") === true
          ? organizationActivityArrayScope(
              q.organizationId,
              sql`${mediaMentions.organizationIds}`,
              sql`${mediaMentions.personIds}`,
            )
          : sql`${mediaMentions.organizationIds} @> ARRAY[${q.organizationId}]::text[]`,
      );
    }
    if (q.pinned !== undefined) filters.push(eq(mediaMentions.pinned, q.pinned));
    const baseWhere = and(...filters);

    // Historical GDELT rows predate the stricter ingest safeguards. Apply the
    // same quality bar at read time so the retroactive review improves every
    // existing profile without deleting provenance. Pinned-only views are left
    // untouched because pinning is an explicit human decision.
    const qualityFilters = [...filters];
    if (q.pinned !== true) {
      const candidateScope = q.personId
        ? sql`candidate.person_ids @> ARRAY[${q.personId}]::text[]`
        : q.organizationId
          ? parseBoolQuery(req, "includeLinkedPeople") === true
            ? organizationActivityArrayScope(
                q.organizationId,
                sql`candidate.organization_ids`,
                sql`candidate.person_ids`,
              )
            : sql`candidate.organization_ids @> ARRAY[${q.organizationId}]::text[]`
          : sql`TRUE`;

      qualityFilters.push(sql`NOT EXISTS (
        SELECT 1
        FROM media_mentions candidate
        WHERE candidate.dismissed = false
          AND ${candidateScope}
          AND (
            (
              media_mentions.canonical_url IS NOT NULL
              AND candidate.canonical_url = media_mentions.canonical_url
            )
            OR (
              media_mentions.headline_fingerprint IS NOT NULL
              AND candidate.headline_fingerprint = media_mentions.headline_fingerprint
              AND candidate.publication_date IS NOT DISTINCT FROM media_mentions.publication_date
            )
          )
          AND (
            (candidate.pinned = true AND media_mentions.pinned = false)
            OR (
              candidate.pinned = media_mentions.pinned
              AND (
                candidate.created_at < media_mentions.created_at
                OR (
                  candidate.created_at = media_mentions.created_at
                  AND candidate.id < media_mentions.id
                )
              )
            )
          )
      )`);

      if (q.personId) {
        const person = await db
          .select({ fullName: people.fullName })
          .from(people)
          .where(eq(people.id, q.personId))
          .then((rows) => rows[0]);
        const normalizedName = normalizeMediaHeadline(person?.fullName ?? "");
        if (normalizedName.length >= 5) {
          qualityFilters.push(sql`(
            media_mentions.pinned = true
            OR regexp_replace(
              lower(coalesce(media_mentions.title, '')),
              '[^a-z0-9]+',
              '',
              'g'
            ) LIKE ${`%${normalizedName}%`}
          )`);
        }
      }
    }

    const qualityWhere = and(...qualityFilters);
    const includeHidden = parseBoolQuery(req, "includeHidden") === true;
    const visibleWhere = includeHidden ? baseWhere : qualityWhere;
    const [
      rows,
      [{ value: total } = { value: 0 }],
      [{ value: baseTotal } = { value: 0 }],
      [{ value: qualityTotal } = { value: 0 }],
    ] = await Promise.all([
      db
        .select()
        .from(mediaMentions)
        .where(visibleWhere)
        .orderBy(desc(mediaMentions.publicationDate), desc(mediaMentions.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(mediaMentions).where(visibleWhere),
      db.select({ value: count() }).from(mediaMentions).where(baseWhere),
      db.select({ value: count() }).from(mediaMentions).where(qualityWhere),
    ]);
    res.json({
      data: rows,
      pagination: { page, limit, total: Number(total) },
      hiddenCount: Math.max(0, Number(baseTotal) - Number(qualityTotal)),
    });
  }),
);

router.get(
  "/media-mentions/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(mediaMentions)
      .where(eq(mediaMentions.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "media mention");
    res.json(row);
  }),
);

router.post(
  "/media-mentions",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateMediaMentionBodyRefined, req.body, res);
    if (!body) return;
    const [row] = await db
      .insert(mediaMentions)
      .values({
        id: newId(),
        ...body,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/media-mentions/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateMediaMentionBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const existing = await db
      .select()
      .from(mediaMentions)
      .where(eq(mediaMentions.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "media mention");

    // Validate merged post-update state so a partial PATCH can't slip an
    // over-length summary or non-http url past the create-time checks.
    const merged = { ...existing, ...body };
    const issues = validateMediaMentionInvariants({
      aiSummary: merged.aiSummary,
      url: merged.url,
    });
    if (issues.length) return respondInvariantFailure(res, issues);

    const [row] = await db
      .update(mediaMentions)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(mediaMentions.id, id))
      .returning();
    if (!row) return notFound(res, "media mention");
    res.json(row);
  }),
);

// "Delete" is a SOFT delete: we mark the row dismissed instead of removing it.
// Retaining the row keeps its `url` on record as a tombstone so a later GDELT
// sweep can't re-insert/re-link the exact same article (see mediaIngest's
// upsert guard). Dismissal is global per article — it hides the mention for
// every linked entity, not just one. An admin trash/undo UI is out of scope.
router.delete(
  "/media-mentions/:id",
  asyncHandler(async (req, res) => {
    await db
      .update(mediaMentions)
      .set({ dismissed: true, updatedAt: new Date() })
      .where(eq(mediaMentions.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
